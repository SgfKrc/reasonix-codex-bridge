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
  BRIDGE_ROOT,
  CODEX_CONFIG_PATH,
  PRESETS_EXAMPLE_PATH,
  PRESETS_PATH,
  REASONIX_SKILLS_PATH,
  buildCodexBlock,
  atomicWriteFile,
  checkCliVersion,
  cliSpawnOptions,
  doctorRefs,
  isFile,
  profileDrift,
  ensureProfileReadOnly,
  readSubagentProfile,
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
  profile [--create|--sync] [--write]
                       inspect a profile or print/run a create/edit command, then verify model + read-only
  verify               check the CLI, the selected model ref, and the subagent profile

Environment overrides: REASONIX_EXE, REASONIX_MODEL_REF, REASONIX_SUBAGENT, REASONIX_ROOT,
REASONIX_MIN_VERSION, BRIDGE_CONFIG, BRIDGE_PRESETS, CODEX_CONFIG, CODEX_HOME.`;

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
  let updated;
  try {
    updated = upsertReasonixBlock(existing, block);
    atomicWriteFile(CODEX_CONFIG_PATH, updated);
  } catch (error) {
    fail(error.message);
  }
  process.stdout.write(`updated ${CODEX_CONFIG_PATH}\n${block}`);
}

function quoteCommandArg(value) {
  const text = String(value);
  return /[\s"']/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

function profileCommand(args) {
  const create = args.includes('--create');
  const sync = args.includes('--sync');
  const write = args.includes('--write');
  if (create && sync) fail('profile accepts only one of --create or --sync');
  if (write && !create && !sync) fail('profile --write requires --create or --sync');
  const context = loadContext();
  const name = context.subagent.name;
  const profile = readSubagentProfile(name);
  if (profile.error && !profile.exists && profile.path === '') fail(profile.error);
  const modelRef = context.resolution.ref;
  const promptFile = path.join(BRIDGE_ROOT, 'prompts', `${name}-prompt.md`);
  const defaultTools = ['read_file', 'grep', 'glob', 'ls', 'code_index'];
  if (sync && profile.frontmatter?.exists && profile.frontmatter.toolsKnown === false) {
    fail(`cannot sync profile with an unparseable allowed-tools field at ${profile.path}; repair it manually first`);
  }
  const tools = profile.frontmatter?.exists && profile.frontmatter.toolsKnown ? profile.frontmatter.tools : defaultTools;
  const description = profile.frontmatter?.fields?.description || 'Read-only reconnaissance and failure analysis subagent.';
  const commandArgs = create
    ? ['subagent', 'create', name, '--description', description, '--scope', 'global', '--model', modelRef || '<provider>/<model>', '--prompt-file', promptFile, '--tools', tools.join(',')]
    : ['subagent', 'edit', name, '--model', modelRef || '<provider>/<model>', '--prompt-file', promptFile, '--tools', tools.join(',')];
  const command = `reasonix ${commandArgs.map(quoteCommandArg).join(' ')}`;
  const issues = profileDrift(profile, modelRef);
  process.stdout.write(`profile name : ${name}\nprofile path : ${profile.path}\nmodel ref    : ${modelRef || '(unresolved)'}\n`);
  if (profile.exists && profile.frontmatter?.exists) {
    process.stdout.write(`profile model: ${profile.frontmatter.model || '(missing)'}\nread-only    : ${profile.frontmatter.readOnly === true ? 'true' : profile.frontmatter.readOnly === false ? 'false' : 'missing'}\n`);
  }
  if (!create && !sync) {
    process.stdout.write(`${issues.length ? `DRIFT       : ${issues.join('; ')}\n` : 'consistency  : OK\n'}`);
    if (issues.length) process.exit(1);
    return;
  }
  if (!modelRef) fail(`cannot prepare profile command: model ref unresolved (${context.resolution.error ?? 'no source'})`);
  if (!isFile(promptFile)) fail(`profile prompt file is missing: ${promptFile}`);
  if (create && profile.exists) fail(`profile already exists at ${profile.path}; use --sync or inspect it first`);
  if (sync && !profile.exists) fail(`cannot sync missing profile at ${profile.path}; use --create first`);
  process.stdout.write(`command      : ${command}\n`);
  if (!write) {
    process.stdout.write('write        : not requested (add --write to execute the CLI command)\n');
    return;
  }
  if (!context.cliPath) fail(`cannot execute profile command: ${context.cliError}`);
  const result = spawnSync(context.cliPath, commandArgs, cliSpawnOptions(context.cliPath, {
    cwd: context.root,
    env: process.env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  }));
  if (result.error) fail(`profile command failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`profile command failed with code ${result.status}\n${String(result.stderr ?? '').trim()}`);
  let updated = readSubagentProfile(name);
  if (updated.exists && updated.frontmatter?.readOnly !== true) {
    try {
      ensureProfileReadOnly(updated.path);
      updated = readSubagentProfile(name);
    } catch (error) {
      fail(`profile command completed but read-only guard could not be written: ${error.message}`);
    }
  }
  const updatedIssues = profileDrift(updated, modelRef);
  if (updatedIssues.length) fail(`profile command completed but consistency check failed at ${updated.path}: ${updatedIssues.join('; ')}`);
  process.stdout.write(`verified     : ${updated.path} (model and read-only are consistent)\n`);
}

function verifyCommand() {
  const context = loadContext();
  const results = [];
  if (context.cliPath) {
    const version = checkCliVersion(context.cliPath);
    if (version.status === 'fail') {
      results.push(['fail', `reasonix CLI: ${context.cliPath} (${version.error}); upgrade Reasonix or deliberately set REASONIX_MIN_VERSION below the installed version`]);
    } else if (version.status === 'unknown') {
      results.push(['warn', `reasonix CLI: ${context.cliPath} (version unknown: ${version.error})`]);
    } else if (version.warning) {
      results.push(['warn', `reasonix CLI: ${context.cliPath} (${version.version}; ${version.warning})`]);
    } else {
      results.push(['ok', `reasonix CLI: ${context.cliPath} (${version.version}; minimum ${version.minimum})`]);
    }
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
    const listed = spawnSync(context.cliPath, ['subagent', 'list'], cliSpawnOptions(context.cliPath, { encoding: 'utf8', timeout: 30_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
    const text = `${listed.stdout ?? ''}\n${listed.stderr ?? ''}`;
    const name = context.subagent.name;
    const present = listed.status === 0 && text.split('\n').some((line) => line.trim().split(/\s+/)[0] === name);
    const profile = readSubagentProfile(name);
    const issues = context.resolution.ref ? profileDrift(profile, context.resolution.ref) : [];
    results.push(!present ? ['fail', `subagent profile: ${name} missing - create it with: reasonix subagent create ${name} --scope global --model "${context.resolution.ref || '<ref>'}" --prompt-file prompts/${name}-prompt.md`]
      : !profile.exists ? ['fail', `subagent profile: ${name} is listed but SKILL.md is missing at ${profile.path || REASONIX_SKILLS_PATH}`]
        : issues.length ? ['fail', `subagent profile drift: ${issues.join('; ')} (${profile.path})`]
          : ['ok', `subagent profile: ${name} is installed and consistent (model + read-only)`]);
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
else if (command === 'profile') profileCommand(args);
else if (command === 'verify') verifyCommand();
else fail(`unknown command "${command}"\n\n${USAGE}`);
