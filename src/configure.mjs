#!/usr/bin/env node
/**
 * Configure the Reasonix ↔ Codex bridge without hand-editing JSON or TOML.
 *
 * Everything is derived from this machine (`reasonix doctor --json`) plus an
 * optional, human-editable bridge.config.json / presets.json.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  BRIDGE_CONFIG_PATH,
  CODEX_CONFIG_PATH,
  PRESETS_EXAMPLE_PATH,
  PRESETS_PATH,
  buildCodexBlock,
  doctorRefs,
  isFile,
  readBridgeConfig,
  readDoctor,
  readPresets,
  resolveCliPath,
  resolveModelRef,
  resolveSubagent,
  resolveWorkspaceRoot,
  upsertReasonixBlock,
  validateModelRef,
} from './config.mjs';

const USAGE = `Usage: node src/configure.mjs <command>

  list                 list every <provider>/<model> ref this machine reports
  show                 print the configuration the bridge will use, and each value's source
  use <ref|preset>     write modelRef into bridge.config.json (a preset name is accepted)
  presets              list presets from presets.json (copy presets.example.json to create it)
  codex [--write]      print the Codex MCP block; --write upserts it into the Codex config (backup first)
  verify               check the CLI, the selected model ref, and the subagent profile

Environment overrides: REASONIX_EXE, REASONIX_MODEL_REF, REASONIX_SUBAGENT, REASONIX_ROOT,
BRIDGE_CONFIG, BRIDGE_PRESETS, CODEX_CONFIG, CODEX_HOME.`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function loadContext() {
  let cliPath = '';
  let cliError = '';
  try { cliPath = resolveCliPath(); } catch (error) { cliError = error.message; }
  const bridgeConfig = readBridgeConfig();
  return {
    cliPath,
    cliError,
    bridgeConfig,
    resolution: resolveModelRef({ cliPath, bridgeConfig }),
    subagent: resolveSubagent(bridgeConfig),
    root: resolveWorkspaceRoot(bridgeConfig),
  };
}

function doctorFor(context) {
  if (context.resolution.doctor) return context.resolution.doctor;
  if (!context.cliPath) return { ok: false, error: context.cliError || 'reasonix CLI is not available', data: null };
  return readDoctor(context.cliPath);
}

function listCommand() {
  const context = loadContext();
  if (!context.cliPath) fail(`[bridge] ${context.cliError}`);
  const doctor = doctorFor(context);
  if (!doctor.ok) fail(`[bridge] ${doctor.error}`);
  const { refs, defaultRef } = doctorRefs(doctor.data);
  const current = context.resolution.ref;
  process.stdout.write(`reasonix CLI           : ${context.cliPath}\n`);
  process.stdout.write(`reasonix version       : ${doctor.data?.version ?? 'unknown'}\n`);
  process.stdout.write(`reasonix default_model : ${defaultRef || '(none reported)'}\n\n`);
  if (refs.length === 0) {
    process.stdout.write('this machine reports no providers; run `reasonix doctor` to inspect the Reasonix config\n');
    return;
  }
  for (const item of refs) {
    const marks = [
      item.ref === current ? 'current' : '',
      item.isReasonixDefault ? 'reasonix default' : '',
      item.keyPresent ? '' : 'no api key',
    ].filter(Boolean);
    const host = item.baseHost ? `  ${item.baseHost}` : '';
    process.stdout.write(`${item.ref === current ? '*' : ' '} ${item.ref}${marks.length ? `  [${marks.join(', ')}]` : ''}${host}\n`);
  }
  process.stdout.write('\nselect one with: node src/configure.mjs use <ref>\n');
}

function showCommand() {
  const context = loadContext();
  const lines = [];
  lines.push(`bridge config  : ${context.bridgeConfig.path}${context.bridgeConfig.exists ? '' : ' (not created yet)'}`);
  lines.push(`reasonix CLI   : ${context.cliPath || `UNRESOLVED - ${context.cliError}`}`);
  lines.push(`codex config   : ${CODEX_CONFIG_PATH}${isFile(CODEX_CONFIG_PATH) ? '' : ' (missing)'}`);
  lines.push(`workspace root : ${context.root}`);
  lines.push(`subagent       : ${context.subagent.name}  (source: ${context.subagent.source})`);
  if (context.resolution.ref) {
    lines.push(`model ref      : ${context.resolution.ref}  (source: ${context.resolution.source})`);
  } else {
    lines.push(`model ref      : UNRESOLVED - ${context.resolution.error ?? 'no source'}`);
    lines.push('                 fix with: node src/configure.mjs use <provider>/<model>');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function useCommand(target) {
  const wanted = (target ?? '').trim();
  if (!wanted) fail('usage: node src/configure.mjs use <provider>/<model>|<preset-name>');
  const presets = readPresets();
  const preset = presets.presets.find((item) => item.name === wanted);
  const modelRef = preset ? preset.modelRef : wanted;
  const problem = validateModelRef(modelRef);
  if (problem) fail(`invalid model reference "${modelRef}": ${problem}`);
  const config = readBridgeConfig();
  writeFileSync(BRIDGE_CONFIG_PATH, `${JSON.stringify({ ...config.data, modelRef }, null, 2)}\n`, 'utf8');
  process.stdout.write(`wrote ${BRIDGE_CONFIG_PATH}\n  modelRef = ${modelRef}${preset ? `  (preset "${preset.name}")` : ''}\n`);
  try {
    const doctor = readDoctor(resolveCliPath());
    if (doctor.ok) {
      const { refs } = doctorRefs(doctor.data);
      if (refs.length > 0 && !refs.some((item) => item.ref === modelRef)) {
        process.stdout.write(`warning: "${modelRef}" is not among the providers this machine reports; check with: node src/configure.mjs list\n`);
      }
    }
  } catch {
    // CLI unavailable: keep the write, the bridge reports it at startup.
  }
}

function presetsCommand() {
  const presets = readPresets();
  if (!presets.exists) {
    process.stdout.write(`no presets file at ${PRESETS_PATH}\n`);
    process.stdout.write(`copy the example to create one:\n  cp "${PRESETS_EXAMPLE_PATH}" "${PRESETS_PATH}"\n`);
    return;
  }
  if (presets.presets.length === 0) {
    process.stdout.write(`${presets.path} contains no usable preset (each needs a name and a modelRef with "/")\n`);
    return;
  }
  for (const item of presets.presets) {
    process.stdout.write(`  ${item.name.padEnd(20)} ${item.modelRef}${item.note ? `  - ${item.note}` : ''}\n`);
  }
  process.stdout.write('\napply one with: node src/configure.mjs use <name>\n');
}

function codexCommand(args) {
  const write = args.includes('--write');
  const context = loadContext();
  if (!context.resolution.ref) {
    fail(`no model ref resolved (${context.resolution.error ?? 'no source'}); run: node src/configure.mjs use <provider>/<model>`);
  }
  const block = buildCodexBlock({
    modelRef: context.resolution.ref,
    subagent: context.subagent.name,
    root: context.root,
    cliPath: context.cliPath,
  });
  if (!write) {
    process.stdout.write(`# paste into ${CODEX_CONFIG_PATH}, or re-run with --write\n${block}`);
    return;
  }
  if (isFile(CODEX_CONFIG_PATH)) {
    const backup = `${CODEX_CONFIG_PATH}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(CODEX_CONFIG_PATH, backup);
    process.stdout.write(`backup: ${backup}\n`);
  } else {
    mkdirSync(path.dirname(CODEX_CONFIG_PATH), { recursive: true });
  }
  const existing = isFile(CODEX_CONFIG_PATH) ? readFileSync(CODEX_CONFIG_PATH, 'utf8') : '';
  writeFileSync(CODEX_CONFIG_PATH, upsertReasonixBlock(existing, block), 'utf8');
  process.stdout.write(`updated ${CODEX_CONFIG_PATH}\n${block}`);
}

function verifyCommand() {
  const context = loadContext();
  const results = [];
  if (context.cliPath) {
    const version = spawnSync(context.cliPath, ['--version'], { encoding: 'utf8', timeout: 30_000, windowsHide: true });
    const text = (version.stdout ?? '').trim();
    results.push(['ok', `reasonix CLI: ${context.cliPath}${text ? ` (${text})` : ''}`]);
  } else {
    results.push(['fail', `reasonix CLI: ${context.cliError}`]);
  }

  if (!context.resolution.ref) {
    results.push(['fail', `model ref: unresolved (${context.resolution.error ?? 'no source'}) - run: node src/configure.mjs use <ref>`]);
  } else if (validateModelRef(context.resolution.ref)) {
    results.push(['fail', `model ref: ${validateModelRef(context.resolution.ref)}`]);
  } else {
    const doctor = doctorFor(context);
    if (!doctor.ok) {
      results.push(['warn', `model ref: ${context.resolution.ref} (could not verify against this machine: ${doctor.error})`]);
    } else {
      const { refs } = doctorRefs(doctor.data);
      const hit = refs.find((item) => item.ref === context.resolution.ref);
      if (refs.length === 0) results.push(['warn', `model ref: ${context.resolution.ref} (this machine reports no providers)`]);
      else if (!hit) results.push(['warn', `model ref: ${context.resolution.ref} is not among this machine's providers - run: node src/configure.mjs list`]);
      else if (!hit.keyPresent) results.push(['warn', `model ref: ${context.resolution.ref} (provider "${hit.provider}" reports no API key here)`]);
      else results.push(['ok', `model ref: ${context.resolution.ref} (provider ${hit.provider}, key present)`]);
    }
  }

  if (context.cliPath) {
    const listed = spawnSync(context.cliPath, ['subagent', 'list'], { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const text = `${listed.stdout ?? ''}\n${listed.stderr ?? ''}`;
    const name = context.subagent.name;
    const present = listed.status === 0 && text.split('\n').some((line) => line.trim().split(/\s+/)[0] === name);
    results.push([present ? 'ok' : 'warn', present
      ? `subagent profile: ${name} is installed`
      : `subagent profile: ${name} missing - create it with: reasonix subagent create ${name} --scope global --model "${context.resolution.ref || '<ref>'}" --prompt-file prompts/${name}-prompt.md`]);
  }

  for (const [state, message] of results) process.stdout.write(`${state === 'ok' ? 'OK  ' : state === 'warn' ? 'WARN' : 'FAIL'} ${message}\n`);
  if (results.some(([state]) => state === 'fail')) process.exit(1);
}

const [command = '', ...args] = process.argv.slice(2);
if (!command || command === 'help' || command === '--help' || command === '-h') {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
if (command === 'list') listCommand();
else if (command === 'show') showCommand();
else if (command === 'use') useCommand(args[0]);
else if (command === 'presets') presetsCommand();
else if (command === 'codex') codexCommand(args);
else if (command === 'verify') verifyCommand();
else fail(`unknown command "${command}"\n\n${USAGE}`);
