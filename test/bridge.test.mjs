import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';
import {
  DEFAULT_MIN_REASONIX_VERSION,
  checkCliVersion,
  compareVersions,
  doctorRefs,
  parseVersion,
  resolveModelRef,
  upsertReasonixBlock,
  validateModelRef,
} from '../src/config.mjs';

const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_PATH = path.join(BRIDGE_ROOT, 'src', 'server.mjs');
const CONFIGURE_PATH = path.join(BRIDGE_ROOT, 'src', 'configure.mjs');
const tempRoots = new Set();

function tempRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'reasonix-codex-bridge-'));
  tempRoots.add(root);
  return root;
}

function envFor(root, overrides = {}) {
  return {
    ...process.env,
    BRIDGE_CONFIG: path.join(root, 'bridge.config.json'),
    BRIDGE_PRESETS: path.join(root, 'presets.json'),
    CODEX_CONFIG: path.join(root, 'codex.config.toml'),
    REASONIX_EXE: process.execPath,
    REASONIX_ROOT: root,
    REASONIX_MODEL_REF: 'fixture/provider',
    ...overrides,
  };
}

function writeCliFiles(root, { version = '1.38.7' } = {}) {
  writeFileSync(path.join(root, 'doctor'), `
const args = process.argv.slice(2);
if (args.includes('--json')) {
  process.stdout.write(JSON.stringify({ version: ${JSON.stringify(version)}, config: { default_model: 'fixture/provider' }, providers: [{ name: 'fixture', models: ['provider'], key_present: true, base_url_host: 'fixture.invalid' }] }));
}
`, 'utf8');
  writeFileSync(path.join(root, 'subagent'), `
process.stdout.write('deepseek-worker  read-only\\n');
`, 'utf8');
}

function writeVersionStub(root, version) {
  if (process.platform === 'win32') {
    const file = path.join(root, 'reasonix-stub.cmd');
    const body = [
      '@echo off',
      `if "%1"=="--version" (echo Reasonix ${version} & exit /b 0)`,
      'if "%1"=="doctor" (echo {"version":"1.38.7","config":{"default_model":"fixture/provider"},"providers":[{"name":"fixture","models":["provider"],"key_present":true}]} & exit /b 0)',
      'if "%1"=="subagent" (echo deepseek-worker read-only & exit /b 0)',
      'exit /b 0',
    ].join('\r\n');
    writeFileSync(file, body, 'utf8');
    return file;
  }
  const file = path.join(root, 'reasonix-stub');
  writeFileSync(file, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Reasonix ${version}"; exit 0; fi
if [ "$1" = "doctor" ]; then echo '{"version":"1.38.7","config":{"default_model":"fixture/provider"},"providers":[{"name":"fixture","models":["provider"],"key_present":true}]}' ; exit 0; fi
if [ "$1" = "subagent" ]; then echo 'deepseek-worker read-only'; exit 0; fi
exit 0
`, 'utf8');
  // chmod is intentionally avoided in the Windows test path; POSIX runners use a shell script.
  spawnSync('chmod', ['+x', file]);
  return file;
}

function runNode(args, root, overrides = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    env: envFor(root, overrides),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function readMcpSession(child, requests) {
  let buffer = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter(message); }
    }
  });
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP request ${id} timed out`)); }, 5000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const responses = [];
  for (const item of requests) responses.push(await request(item.id, item.method, item.params));
  child.stdin.end();
  return responses;
}

after(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('configuration pure functions', () => {
  test('parses and compares version gates', () => {
    assert.deepEqual(parseVersion('Reasonix CLI v1.38.7'), { major: 1, minor: 38, patch: 7, normalized: '1.38.7' });
    assert.equal(compareVersions('1.38.5', DEFAULT_MIN_REASONIX_VERSION), -1);
    assert.equal(compareVersions('1.38.6', DEFAULT_MIN_REASONIX_VERSION), 0);
    assert.equal(compareVersions('1.39', DEFAULT_MIN_REASONIX_VERSION), 1);
    assert.equal(parseVersion('development build'), null);
  });

  test('keeps model resolution order and validates refs', () => {
    const old = process.env.REASONIX_MODEL_REF;
    try {
      process.env.REASONIX_MODEL_REF = 'env/provider';
      assert.equal(resolveModelRef({ cliPath: '', bridgeConfig: { path: 'fixture.json', data: { modelRef: 'file/provider' } } }).ref, 'env/provider');
      delete process.env.REASONIX_MODEL_REF;
      assert.equal(resolveModelRef({ cliPath: '', bridgeConfig: { path: 'fixture.json', data: { modelRef: 'file/provider' } } }).ref, 'file/provider');
      assert.equal(validateModelRef('provider/model'), '');
      assert.match(validateModelRef('provider model'), /whitespace/);
      assert.match(validateModelRef('model-only'), /look like/);
    } finally {
      if (old === undefined) delete process.env.REASONIX_MODEL_REF;
      else process.env.REASONIX_MODEL_REF = old;
    }
  });

  test('normalizes doctor model[] and single model forms', () => {
    const result = doctorRefs({
      config: { default_model: 'alpha/one' },
      providers: [
        { name: 'alpha', models: ['one', 'two'], key_present: true, base_url_host: 'alpha.invalid', context_window: 8192 },
        { name: 'beta', model: 'solo', key_present: false },
      ],
    });
    assert.deepEqual(result.refs.map((item) => item.ref), ['alpha/one', 'alpha/two', 'beta/solo']);
    assert.equal(result.refs[0].isReasonixDefault, true);
    assert.equal(result.refs[2].keyPresent, false);
  });

  test('upserts bridge blocks at append, first and last boundaries', () => {
    const block = '[mcp_servers.reasonix_local]\ncommand = "node"\n';
    assert.match(upsertReasonixBlock('title = "x"\n', block), /title = "x"[\s\S]*\[mcp_servers\.reasonix_local\]/);
    assert.match(upsertReasonixBlock('[mcp_servers.reasonix_local]\nold = true\n\n[other]\nvalue = 1\n', block), /command = "node"[\s\S]*\[other\]/);
    assert.match(upsertReasonixBlock('[other]\nvalue = 1\n\n[mcp_servers.reasonix_local]\nold = true\n', block), /\[other\][\s\S]*command = "node"/);
  });
});

describe('offline command contracts', () => {
  test('configure use and codex --write only touch temporary files', () => {
    const root = tempRoot();
    writeCliFiles(root);
    const use = runNode([CONFIGURE_PATH, 'use', 'fixture/provider'], root);
    assert.equal(use.status, 0, use.stderr);
    assert.equal(JSON.parse(readFileSync(path.join(root, 'bridge.config.json'), 'utf8')).modelRef, 'fixture/provider');
    writeFileSync(path.join(root, 'codex.config.toml'), '[tool]\nvalue = 1\n', 'utf8');
    const codex = runNode([CONFIGURE_PATH, 'codex', '--write'], root);
    assert.equal(codex.status, 0, codex.stderr);
    const written = readFileSync(path.join(root, 'codex.config.toml'), 'utf8');
    assert.match(written, /\[mcp_servers\.reasonix_local\]/);
    assert.match(written, /REASONIX_MODEL_REF = "fixture\/provider"/);
  });

  test('verify fails below the default version and downgrades only with an explicit override', () => {
    const root = tempRoot();
    const cli = writeVersionStub(root, '1.38.5');
    writeFileSync(path.join(root, 'bridge.config.json'), JSON.stringify({ modelRef: 'fixture/provider' }), 'utf8');
    const failed = runNode([CONFIGURE_PATH, 'verify'], root, { REASONIX_EXE: cli });
    assert.equal(failed.status, 1);
    assert.match(failed.stdout, /FAIL reasonix CLI/);
    const relaxed = runNode([CONFIGURE_PATH, 'verify'], root, { REASONIX_EXE: cli, REASONIX_MIN_VERSION: '1.0' });
    assert.equal(relaxed.status, 0, relaxed.stderr);
    assert.match(relaxed.stdout, /WARN reasonix CLI/);
  });

  test('MCP session exposes tools and a structured version status without a model call', async () => {
    const root = tempRoot();
    writeCliFiles(root);
    const child = spawn(process.execPath, [SERVER_PATH], { cwd: root, env: envFor(root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const responses = await readMcpSession(child, [
      { id: 1, method: 'initialize' },
      { id: 2, method: 'tools/list' },
      { id: 3, method: 'tools/call', params: { name: 'reasonix_status', arguments: {} } },
    ]);
    const exit = await new Promise((resolve) => child.once('close', resolve));
    assert.equal(exit, 0);
    assert.equal(responses[0].result.serverInfo.name, 'reasonix-local-bridge');
    assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['reasonix_run', 'reasonix_status']);
    const status = JSON.parse(responses[2].result.content[0].text);
    assert.equal(status.versionCheck, 'ok');
    assert.equal(status.workerReadOnlyAssumed, true);
    assert.equal(status.historyHardCapBytes, 128 * 1024 * 1024);
  });
});

test('low-version CLI is refused before the bridge starts', () => {
  const root = tempRoot();
  const cli = writeVersionStub(root, '1.38.5');
  const result = spawnSync(process.execPath, [SERVER_PATH], {
    cwd: root,
    env: envFor(root, { REASONIX_EXE: cli }),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /below minimum 1\.38\.6/);
});

test('unparseable CLI version remains unknown instead of blocking startup', () => {
  const result = checkCliVersion('missing-reasonix-cli');
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /cannot run|not available|ENOENT/);
});
