/** Local stdio MCP facade for the configured Reasonix worker. */
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { appendFileSync, existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  ConfigError,
  SERVER_NAME,
  checkCliVersion,
  cliSpawnOptions,
  readBridgeConfig,
  doctorRefs,
  readDoctor,
  resolveCliPath,
  resolveModelRef,
  resolveSubagent,
  resolveSubagentRole,
  resolveWritePolicy,
  resolveWorkspaceRoot,
  validateModelRef,
} from './config.mjs';

function log(message) { process.stderr.write(`[${SERVER_NAME}] ${message}\n`); }
function refuse(reason, hint) {
  log(`refusing to start: ${reason}`);
  if (hint) log(hint);
  process.exit(2);
}

const HARD_MAX_STEPS_CAP = 40;
const HARD_TIMEOUT_SECONDS_CAP = 600;
const TASK_CHAR_CAP = 8000;
const HARD_OUTPUT_CHAR_CAP = 24000;
const HARD_QUEUE_CAP = 5;
const HISTORY_HARD_CAP_BYTES = 128 * 1024 * 1024;
const MODES = { inspect: { maxSteps: 12, timeoutSeconds: 180 }, review: { maxSteps: 16, timeoutSeconds: 240 }, plan: { maxSteps: 16, timeoutSeconds: 240 }, implement: { maxSteps: 16, timeoutSeconds: 240 } };
const BRIDGE_LOG_PATH = (process.env.BRIDGE_LOG ?? '').trim() ? path.resolve(process.env.BRIDGE_LOG.trim()) : '';

const TOOLS = [
  { name: 'reasonix_run', description: 'Run the configured Reasonix worker in inspect, review, plan, or explicitly authorized implement mode.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, cwd: { type: 'string' }, max_steps: { type: 'integer' }, mode: { type: 'string', enum: ['inspect', 'implement', 'review', 'plan'] }, timeout_seconds: { type: 'integer' } }, required: ['task'] } },
  { name: 'reasonix_rollback', description: 'Explicitly roll back one successful implement call by its returned rollback_id, only when its files are unchanged since that call.', inputSchema: { type: 'object', properties: { rollback_id: { type: 'string' } }, required: ['rollback_id'] } },
  { name: 'reasonix_status', description: 'Show bridge configuration and limits without calling a model.', inputSchema: { type: 'object', properties: {} } },
];

let bridgeConfig = { path: '', exists: false, data: {} };
try {
  bridgeConfig = readBridgeConfig();
} catch (error) {
  refuse(error instanceof ConfigError ? error.message : String(error?.message ?? error));
}

function configuredLimit(config, key) {
  const root = config?.data;
  const nested = root?.limits;
  if (nested && typeof nested === 'object' && !Array.isArray(nested) && Object.hasOwn(nested, key)) return nested[key];
  if (root && typeof root === 'object' && Object.hasOwn(root, key)) return root[key];
  return undefined;
}
function resolveConfiguredLimit(config, key, fallback, hardCap) {
  const raw = configuredLimit(config, key);
  if (raw === undefined) return fallback;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw.trim()) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    log(`warning: bridge config ${key} is invalid; using default ${fallback}`);
    return fallback;
  }
  if (parsed > hardCap) {
    log(`warning: bridge config ${key}=${parsed} exceeds hard cap ${hardCap}; clamped to ${hardCap}`);
    return hardCap;
  }
  return parsed;
}
const LIMITS = Object.freeze({
  maxStepsCap: resolveConfiguredLimit(bridgeConfig, 'MAX_STEPS_CAP', HARD_MAX_STEPS_CAP, HARD_MAX_STEPS_CAP),
  timeoutSecondsCap: resolveConfiguredLimit(bridgeConfig, 'TIMEOUT_SECONDS_CAP', HARD_TIMEOUT_SECONDS_CAP, HARD_TIMEOUT_SECONDS_CAP),
  outputCharCap: resolveConfiguredLimit(bridgeConfig, 'OUTPUT_CHAR_CAP', HARD_OUTPUT_CHAR_CAP, HARD_OUTPUT_CHAR_CAP),
  queueCap: resolveConfiguredLimit(bridgeConfig, 'queueCap', HARD_QUEUE_CAP, HARD_QUEUE_CAP),
});

let CLI_PATH = '';
try {
  CLI_PATH = resolveCliPath();
} catch (error) {
  refuse(
    error instanceof ConfigError ? error.message : String(error?.message ?? error),
    'set REASONIX_EXE, or install Reasonix so the standard locations are populated.',
  );
}

const VERSION_CHECK = checkCliVersion(CLI_PATH);
if (VERSION_CHECK.status === 'fail') {
  refuse(
    VERSION_CHECK.error,
    `upgrade Reasonix or set REASONIX_MIN_VERSION below ${VERSION_CHECK.version ?? 'the installed version'} only for a deliberate compatibility check.`,
  );
}
if (VERSION_CHECK.warning) log(`warning: ${VERSION_CHECK.warning}`);
if (VERSION_CHECK.status === 'unknown') log(`warning: Reasonix CLI version check unknown (${VERSION_CHECK.error})`);

const WORKSPACE_ROOT = resolveWorkspaceRoot(bridgeConfig);
const SUBAGENT = resolveSubagent(bridgeConfig);
let SUBAGENT_ROLE;
try {
  SUBAGENT_ROLE = resolveSubagentRole(bridgeConfig, SUBAGENT);
} catch (error) {
  refuse(error instanceof ConfigError ? error.message : String(error?.message ?? error));
}
const MODEL_RESOLUTION = resolveModelRef({ cliPath: CLI_PATH, bridgeConfig });
const MODEL_REF = MODEL_RESOLUTION.ref;
if (!MODEL_REF) {
  refuse(
    `no subagent model reference configured (${MODEL_RESOLUTION.error ?? 'no source'})`,
    'pick one with: node src/configure.mjs list  ->  node src/configure.mjs use <provider>/<model>',
  );
}
const MODEL_REF_PROBLEM = validateModelRef(MODEL_REF);
if (MODEL_REF_PROBLEM) {
  refuse(`${MODEL_REF_PROBLEM}: ${MODEL_REF}`, 'fix with: node src/configure.mjs use <provider>/<model>');
}
const SUBAGENT_NAME = SUBAGENT.name;
const MODEL_REF_SOURCE = MODEL_RESOLUTION.source;
const MODEL_CAPABILITIES = resolveModelCapabilities();
const WRITE_POLICY = resolveWritePolicy(bridgeConfig);
const rollbackRecords = new Map();
const MAX_ROLLBACK_RECORDS = 32;

function resolveModelCapabilities() {
  const doctor = MODEL_RESOLUTION.doctor?.ok
    ? MODEL_RESOLUTION.doctor
    : readDoctor(CLI_PATH, 30_000, { writeCache: false });
  if (!doctor?.ok) return { available: false, provider: null, model: null, contextWindow: null, vision: null, base_url_host: null, error: doctor?.error || 'reasonix doctor unavailable' };
  const selected = doctorRefs(doctor.data).refs.find((item) => item.ref === MODEL_REF);
  if (!selected) return { available: false, provider: null, model: null, contextWindow: null, vision: null, base_url_host: null, error: 'selected model is not reported by reasonix doctor' };
  const host = selected.baseHost && /^[A-Za-z0-9.:[\]-]+$/u.test(selected.baseHost) ? selected.baseHost : null;
  return {
    available: true,
    provider: selected.provider,
    model: selected.model,
    contextWindow: selected.contextWindow,
    vision: selected.vision,
    base_url_host: host,
    error: null,
  };
}

function allowedRoots() {
  const extra = (process.env.REASONIX_ADD_DIRS ?? '').split(path.delimiter).map((x) => x.trim()).filter(Boolean);
  return [WORKSPACE_ROOT, ...extra].map((entry) => { const absolute = path.resolve(entry); try { return realpathSync.native(absolute); } catch { return absolute; } });
}
function isInside(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }
function resolveCwd(raw) {
  const roots = allowedRoots();
  const base = raw === undefined || raw === null || String(raw).trim() === '' ? roots[0] : path.resolve(roots[0], String(raw).trim());
  let real;
  try { real = realpathSync.native(base); } catch { throw new Error(`cwd does not exist or is not readable: ${base}`); }
  if (!statSync(real).isDirectory()) throw new Error(`cwd is not a directory: ${real}`);
  if (!roots.some((root) => isInside(root, real))) throw new Error(`cwd outside allowed workspace: ${real}`);
  return real;
}

function gitStatus(root) {
  const result = spawn('git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], cliSpawnOptions('git', { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    result.stdout.setEncoding('utf8');
    result.stderr.setEncoding('utf8');
    result.stdout.on('data', (chunk) => { stdout += chunk; });
    result.stderr.on('data', (chunk) => { stderr += chunk; });
    result.once('error', (error) => resolve({ ok: false, entries: [], error: `cannot run git status: ${error.message}` }));
    result.once('close', (code) => {
      if (code !== 0) return resolve({ ok: false, entries: [], error: `git status exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}` });
      const entries = [];
      const fields = stdout.split('\0').filter(Boolean);
      for (let index = 0; index < fields.length; index += 1) {
        const field = fields[index];
        if (field.length < 4) continue;
        const status = field.slice(0, 2);
        const firstPath = field.slice(3).replaceAll('\\', '/');
        entries.push({ status, path: firstPath });
        if (status.includes('R') || status.includes('C')) {
          const oldPath = fields[index + 1];
          if (oldPath) entries.push({ status: 'D', path: oldPath.replaceAll('\\', '/') });
          index += 1;
        }
      }
      resolve({ ok: true, entries, error: '' });
    });
  });
}
function changedEntries(before, after) {
  const beforeMap = new Map(before.map((entry) => [entry.path, entry.status]));
  return after.filter((entry) => beforeMap.get(entry.path) !== entry.status);
}
function pathMatchesAllowed(relativePath) {
  const candidate = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  return WRITE_POLICY.allowedPaths.some((allowed) => candidate === allowed || candidate.startsWith(`${allowed}/`));
}
async function rollbackEntries(root, entries) {
  const unique = [...new Map(entries.filter((entry) => entry?.path).map((entry) => [entry.path, entry])).values()];
  if (!unique.length) return { ok: true, error: '' };
  const tracked = unique.filter((entry) => !entry.status.includes('?')).map((entry) => entry.path);
  const untracked = unique.filter((entry) => entry.status.includes('?')).map((entry) => entry.path);
  const errors = [];
  if (tracked.length) {
    await new Promise((resolve) => {
      const restore = spawn('git', ['-C', root, 'restore', '--worktree', '--staged', '--', ...tracked], cliSpawnOptions('git', { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
      restore.once('error', (error) => { errors.push(`git restore: ${error.message}`); resolve(); });
      restore.once('close', (code) => { if (code !== 0) errors.push(`git restore exited with code ${code}`); resolve(); });
    });
  }
  for (const relativePath of untracked) {
    try { rmSync(path.join(root, relativePath), { recursive: true, force: true }); } catch (error) { errors.push(`remove ${relativePath}: ${error.message}`); }
  }
  return { ok: errors.length === 0, error: errors.join('; ') };
}
function runGitSync(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], cliSpawnOptions('git', {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  }));
  if (result.error || result.status !== 0) return { ok: false, stdout: '', error: result.error?.message || `git ${args[0]} exited with code ${result.status}` };
  return { ok: true, stdout: String(result.stdout ?? ''), error: '' };
}
function hashFile(filePath) {
  return new Promise((resolve) => {
    if (!existsSync(filePath)) return resolve(null);
    let hash;
    try { hash = createHash('sha256'); } catch { return resolve(null); }
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', () => resolve(null));
    stream.once('end', () => resolve(hash.digest('hex')));
  });
}
function countTextLines(filePath) {
  try {
    const data = readFileSync(filePath);
    if (data.includes(0)) return { additions: null, deletions: null, binary: true };
    const text = data.toString('utf8');
    return { additions: text === '' ? 0 : text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').length - (text.endsWith('\n') ? 1 : 0), deletions: 0, binary: false };
  } catch {
    return { additions: null, deletions: null, binary: false };
  }
}
function gitNumstat(root, paths) {
  if (!paths.length) return new Map();
  const result = runGitSync(root, ['diff', 'HEAD', '--numstat', '--', ...paths]);
  if (!result.ok) return new Map();
  const stats = new Map();
  for (const line of result.stdout.split(/\r?\n/).filter(Boolean)) {
    const match = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!match) continue;
    stats.set(match[3].replaceAll('\\', '/'), {
      additions: match[1] === '-' ? null : Number(match[1]),
      deletions: match[2] === '-' ? null : Number(match[2]),
      binary: match[1] === '-' || match[2] === '-',
    });
  }
  return stats;
}
function gitDiffStat(root, paths) {
  if (!paths.length) return '';
  const result = runGitSync(root, ['diff', 'HEAD', '--stat', '--', ...paths]);
  return result.ok ? result.stdout.trim() : '';
}
function changeKind(entry) {
  if (entry.status.includes('D')) return 'deleted';
  if (entry.status.includes('A') || entry.status.includes('?')) return 'added';
  return 'modified';
}
async function buildChangeSet(root, entries, rollbackId = null) {
  const paths = entries.map((entry) => entry.path);
  const numstat = gitNumstat(root, paths);
  const changes = [];
  for (const entry of entries) {
    const filePath = path.resolve(root, entry.path);
    const exists = existsSync(filePath) && statSync(filePath).isFile();
    const kind = changeKind(entry);
    const fileHash = exists ? await hashFile(filePath) : null;
    let lineStats = numstat.get(entry.path);
    if (!lineStats && exists && kind === 'added') lineStats = countTextLines(filePath);
    if (!lineStats) lineStats = { additions: kind === 'deleted' ? 0 : null, deletions: kind === 'deleted' ? null : 0, binary: false };
    changes.push({ path: entry.path, kind, additions: lineStats.additions, deletions: lineStats.deletions, binary: lineStats.binary, sha256: fileHash });
  }
  return {
    schema: 'qlh.reasonix.changes.v1',
    rollback_id: rollbackId,
    diff_stat: gitDiffStat(root, paths) || (changes.length ? `untracked changes: ${changes.length} file(s)` : ''),
    changes,
  };
}
function rememberRollback(root, changes) {
  if (!changes.length) return null;
  const rollbackId = randomUUID();
  rollbackRecords.set(rollbackId, { root, changes, createdAt: Date.now() });
  while (rollbackRecords.size > MAX_ROLLBACK_RECORDS) rollbackRecords.delete(rollbackRecords.keys().next().value);
  return rollbackId;
}
async function explicitRollback(rollbackId) {
  const value = typeof rollbackId === 'string' ? rollbackId.trim() : '';
  if (!value) return { isError: true, text: 'rollback_id is required' };
  const record = rollbackRecords.get(value);
  if (!record) return { isError: true, text: 'rollback_id is unknown or has expired' };
  const conflicts = [];
  for (const change of record.changes) {
    const currentPath = path.resolve(record.root, change.path);
    const exists = existsSync(currentPath) && statSync(currentPath).isFile();
    const currentHash = exists ? await hashFile(currentPath) : null;
    if (currentHash !== change.sha256 && !(currentHash === null && change.sha256 === null)) conflicts.push(change.path);
  }
  if (conflicts.length) return { isError: true, text: `rollback refused because files changed after the implement call: ${conflicts.join(', ')}` };
  const entries = record.changes.map((change) => ({ path: change.path, status: change.kind === 'added' ? '??' : change.kind === 'deleted' ? ' D' : ' M' }));
  const rollback = await rollbackEntries(record.root, entries);
  if (!rollback.ok) return { isError: true, text: `rollback failed: ${rollback.error}` };
  rollbackRecords.delete(value);
  return { isError: false, text: JSON.stringify({ schema: 'qlh.reasonix.rollback.v1', rollback_id: value, status: 'rolled_back', paths: record.changes.map((change) => change.path) }) };
}
function clampInteger(value, fallback, cap) {
  const safeFallback = Math.min(cap, Math.max(1, Math.trunc(fallback)));
  if (value === null || value === '' || typeof value === 'boolean') return safeFallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return safeFallback;
  return Math.min(cap, Math.max(1, Math.trunc(parsed)));
}
function truncate(value, cap) { return value.length <= cap ? value : `${value.slice(0, cap)}\n\n[output truncated; original ${value.length} chars]`; }
function cwdRootLabel(cwd) {
  const roots = allowedRoots();
  const index = roots.findIndex((root) => isInside(root, cwd));
  return index === 0 ? 'workspace' : index > 0 ? `allowed-${index}` : 'unknown';
}
let logFailureReported = false;
let lastRun = null;
function runSummary(entry) {
  return {
    timestamp: new Date().toISOString(),
    mode: entry.mode,
    cwdRoot: entry.cwdRoot,
    maxSteps: entry.maxSteps,
    timeoutSeconds: entry.timeoutSeconds,
    outcome: entry.outcome,
    exitCode: entry.exitCode ?? null,
    elapsedMs: Number.isFinite(entry.elapsedMs) ? entry.elapsedMs : 0,
    outputBytes: Number.isFinite(entry.outputBytes) ? entry.outputBytes : 0,
    truncated: entry.truncated === true,
  };
}
function writeCallLog(record) {
  if (!BRIDGE_LOG_PATH) return;
  try { appendFileSync(BRIDGE_LOG_PATH, `${JSON.stringify(record)}\n`, 'utf8'); } catch (error) {
    if (!logFailureReported) {
      logFailureReported = true;
      log(`call log disabled after write failure: ${error.message}`);
    }
  }
}
function recordRun(entry) {
  const summary = runSummary(entry);
  lastRun = summary;
  writeCallLog(summary);
}
function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32' && child.pid) return new Promise((resolve) => { const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }); killer.once('close', resolve); killer.once('error', () => { child.kill('SIGKILL'); resolve(); }); });
  child.kill('SIGKILL');
  return Promise.resolve();
}
function runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap, task, mode }, { record = true } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const args = ['subagent', 'run', SUBAGENT_NAME, '--model', MODEL_REF, '--max-steps', String(maxSteps), '--dir', cwd, '--', task];
    const child = spawn(CLI_PATH, args, cliSpawnOptions(CLI_PATH, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }));
    let stdout = ''; let stderr = ''; let settled = false; let truncatedOutput = false;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const finish = (result, outcome, exitCode = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (record) recordRun({ mode, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome, exitCode, elapsedMs: Date.now() - startedAt, outputBytes: Buffer.byteLength(stdout, 'utf8'), truncated: truncatedOutput || stdout.length > outputCharCap });
      resolve({ ...result, meta: { outcome, exitCode, elapsedMs: Date.now() - startedAt, outputBytes: Buffer.byteLength(stdout, 'utf8'), truncated: truncatedOutput || stdout.length > outputCharCap } });
    };
    const timer = setTimeout(async () => {
      if (settled) return;
      await terminate(child);
      finish({ isError: true, text: `worker timeout (${timeoutSeconds}s)\n${truncate(stderr, 2000)}` }, 'timeout');
    }, timeoutSeconds * 1000);
    child.stdout.on('data', (chunk) => { stdout += chunk; if (stdout.length > outputCharCap * 2) { truncatedOutput = true; void terminate(child); } });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (stderr.length > outputCharCap) { truncatedOutput = true; void terminate(child); } });
    child.on('error', (error) => finish({ isError: true, text: `cannot start reasonix CLI: ${error.message}` }, 'spawn_error'));
    child.on('close', (code) => {
      if (settled) return;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1); const body = truncate(mode === 'plan' ? stdout : stdout.trim(), outputCharCap);
      if (code !== 0) finish({ isError: true, text: `worker exited with code ${code} (${elapsed}s)${body ? `\n\n--- stdout ---\n${body}` : ''}${stderr ? `\n\n--- stderr ---\n${truncate(stderr, 2000)}` : ''}` }, 'worker_exit', code);
      else finish({ isError: false, text: mode === 'plan' ? body : `[mode cwd=${cwd} model=${MODEL_REF} steps<=${maxSteps} elapsed=${elapsed}s]\n\n${body || '[worker returned no content]'}` }, 'success', 0);
    });
  });
}
async function runImplement({ cwd, maxSteps, timeoutSeconds, outputCharCap, task }) {
  const reject = (text, startedAt = Date.now()) => {
    recordRun({ mode: 'implement', cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: 'write_rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false });
    return { isError: true, text, meta: { outcome: 'write_rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false } };
  };
  const startedAt = Date.now();
  if (!WRITE_POLICY.allowWrite) return reject('mode=implement is disabled; set allowWrite=true in bridge.config.json and pass mode=implement explicitly.', startedAt);
  if (WRITE_POLICY.errors.length) return reject(`mode=implement is disabled; invalid write policy: ${WRITE_POLICY.errors.join('; ')}`, startedAt);
  if (!WRITE_POLICY.allowedPaths.length) return reject('mode=implement is disabled; allowedPaths must contain at least one repository-relative path.', startedAt);
  const beforeStatus = await gitStatus(WORKSPACE_ROOT);
  if (!beforeStatus.ok) return reject(`mode=implement requires a verifiable Git workspace: ${beforeStatus.error}`, startedAt);
  if (WRITE_POLICY.requireCleanTree && beforeStatus.entries.length) {
    return reject(`mode=implement requires a clean Git workspace (${beforeStatus.entries.length} existing change(s)); commit or stash them first.`, startedAt);
  }
  if (!WRITE_POLICY.requireCleanTree && beforeStatus.entries.some((entry) => pathMatchesAllowed(entry.path))) {
    return reject('mode=implement refuses to write an allowed path that is already dirty; restore or commit it first.', startedAt);
  }
  const result = await runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap, task, mode: 'implement' }, { record: false });
  const afterStatus = await gitStatus(WORKSPACE_ROOT);
  if (!afterStatus.ok) {
    recordRun({ mode: 'implement', cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: 'write_rejected', exitCode: result.meta?.exitCode ?? null, elapsedMs: Date.now() - startedAt, outputBytes: result.meta?.outputBytes ?? 0, truncated: result.meta?.truncated === true });
    return { isError: true, text: `mode=implement could not verify post-write Git state: ${afterStatus.error}`, meta: { ...result.meta, outcome: 'write_rejected' } };
  }
  const changed = changedEntries(beforeStatus.entries, afterStatus.entries);
  const disallowed = changed.filter((entry) => !pathMatchesAllowed(entry.path));
  const mustRollback = disallowed.length > 0 || result.isError;
  if (mustRollback && changed.length) {
    const rollback = await rollbackEntries(WORKSPACE_ROOT, changed);
    const reason = disallowed.length
      ? `write touched paths outside allowedPaths: ${disallowed.map((entry) => entry.path).join(', ')}`
      : `worker failed: ${result.text}`;
    const rollbackText = rollback.ok ? 'rollback completed' : `rollback failed: ${rollback.error}`;
    const outcome = disallowed.length ? 'write_rejected' : (result.meta?.outcome ?? 'worker_exit');
    recordRun({ mode: 'implement', cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome, exitCode: result.meta?.exitCode ?? null, elapsedMs: Date.now() - startedAt, outputBytes: result.meta?.outputBytes ?? 0, truncated: result.meta?.truncated === true });
    return { isError: true, text: JSON.stringify({ schema: 'qlh.reasonix.changes.v1', rollback_id: null, outcome, error: `${reason}; ${rollbackText}`, changes: [] }), meta: { ...result.meta, outcome } };
  }
  if (result.isError) {
    recordRun({ mode: 'implement', cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: result.meta?.outcome ?? 'worker_exit', exitCode: result.meta?.exitCode ?? null, elapsedMs: Date.now() - startedAt, outputBytes: result.meta?.outputBytes ?? 0, truncated: result.meta?.truncated === true });
    return { isError: true, text: JSON.stringify({ schema: 'qlh.reasonix.changes.v1', rollback_id: null, outcome: result.meta?.outcome ?? 'worker_exit', error: 'worker failed; no changes were retained', changes: [] }), meta: result.meta };
  }
  const changeSet = await buildChangeSet(WORKSPACE_ROOT, changed);
  const rollbackId = rememberRollback(WORKSPACE_ROOT, changeSet.changes);
  changeSet.rollback_id = rollbackId;
  recordRun({ mode: 'implement', cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome: 'success', exitCode: 0, elapsedMs: Date.now() - startedAt, outputBytes: result.meta?.outputBytes ?? 0, truncated: result.meta?.truncated === true });
  return { isError: false, text: JSON.stringify(changeSet), meta: { ...result.meta, outcome: 'success', rollbackId } };
}
function estimateTaskTokens(task) {
  return Math.max(1, Math.ceil(Buffer.byteLength(task, 'utf8') / 4));
}
let queue = Promise.resolve(); let queueDepth = 0; let inFlight = 0;
function retryHint() {
  const seconds = lastRun?.elapsedMs > 0 ? Math.max(1, Math.ceil(lastRun.elapsedMs / 1000)) : 1;
  return `retry after about ${seconds}s`;
}
function enqueue(job, meta) {
  if (queueDepth >= LIMITS.queueCap) {
    recordRun({ ...meta, outcome: 'queue_rejected', elapsedMs: 0, outputBytes: 0, truncated: false });
    return Promise.resolve({ isError: true, text: `too many queued requests (depth=${queueDepth}, cap=${LIMITS.queueCap}); ${retryHint()}`, meta: { outcome: 'queue_rejected', exitCode: null, elapsedMs: 0, outputBytes: 0, truncated: false } });
  }
  queueDepth += 1;
  const execute = async () => {
    inFlight += 1;
    try { return await job(); } finally { inFlight -= 1; }
  };
  const run = queue.then(execute, execute);
  queue = run.then(() => undefined, () => undefined);
  return run.finally(() => { queueDepth -= 1; });
}
async function callTool(name, args) {
  if (name === 'reasonix_rollback') return explicitRollback(args?.rollback_id);
  if (name === 'reasonix_status') return { isError: false, text: JSON.stringify({ cli: CLI_PATH, cliExists: existsSync(CLI_PATH), version: VERSION_CHECK.version, versionCheck: VERSION_CHECK.status, versionMinimum: VERSION_CHECK.minimum, versionCheckError: VERSION_CHECK.error || null, versionCheckWarning: VERSION_CHECK.warning || null, workspaceRoot: WORKSPACE_ROOT, allowedRoots: allowedRoots(), subagent: SUBAGENT_NAME, subagentSource: SUBAGENT.source, subagentRole: SUBAGENT_ROLE.role, subagentRoleSource: SUBAGENT_ROLE.source, modelRef: MODEL_REF, modelRefSource: MODEL_REF_SOURCE, provider: MODEL_CAPABILITIES.provider, model: MODEL_CAPABILITIES.model, contextWindow: MODEL_CAPABILITIES.contextWindow, vision: MODEL_CAPABILITIES.vision, base_url_host: MODEL_CAPABILITIES.base_url_host, providerCapabilities: MODEL_CAPABILITIES, bridgeConfig: bridgeConfig.path, workerReadOnlyAssumed: SUBAGENT_ROLE.role === 'read', historyMode: 'stateless-per-call', historyHardCapBytes: HISTORY_HARD_CAP_BYTES, modes: Object.keys(MODES), writePolicy: { allowWrite: WRITE_POLICY.allowWrite, enabled: WRITE_POLICY.enabled, allowedPaths: WRITE_POLICY.allowedPaths, requireCleanTree: WRITE_POLICY.requireCleanTree, errors: WRITE_POLICY.errors }, pendingRollbackCount: rollbackRecords.size, queueDepth, inFlight, lastRun, limits: { maxStepsCap: LIMITS.maxStepsCap, taskCharCap: TASK_CHAR_CAP, timeoutSecondsCap: LIMITS.timeoutSecondsCap, outputCharCap: LIMITS.outputCharCap, queueCap: LIMITS.queueCap } }, null, 2) };
  if (name !== 'reasonix_run') throw new Error(`unknown tool: ${name}`);
  const startedAt = Date.now();
  const mode = args?.mode === undefined ? 'inspect' : String(args.mode);
  const logRejected = (error) => recordRun({ mode: ['inspect', 'review', 'implement', 'plan'].includes(mode) ? mode : 'invalid', cwdRoot: 'unknown', maxSteps: null, timeoutSeconds: null, outcome: 'rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false, error });
  const task = typeof args?.task === 'string' ? args.task.trim() : '';
  if (!task) { logRejected('task_required'); throw new Error('task is required'); }
  if (task.length > TASK_CHAR_CAP) { logRejected('task_too_long'); throw new Error(`task exceeds ${TASK_CHAR_CAP} chars`); }
  if (mode === 'implement' && !WRITE_POLICY.allowWrite) { logRejected('implement_disabled'); return { isError: true, text: 'mode=implement is disabled; set allowWrite=true in bridge.config.json and pass mode=implement explicitly.' }; }
  if (MODEL_CAPABILITIES.contextWindow !== null) {
    const estimatedTokens = estimateTaskTokens(task);
    if (estimatedTokens > MODEL_CAPABILITIES.contextWindow) {
      logRejected('context_window_exceeded');
      throw new Error(`task exceeds model context window (estimated ${estimatedTokens} tokens; limit ${MODEL_CAPABILITIES.contextWindow} tokens)`);
    }
  }
  const preset = MODES[mode];
  if (!preset) { logRejected('mode_invalid'); throw new Error(`mode must be one of ${Object.keys(MODES).join(', ')}`); }
  if (mode !== 'implement' && SUBAGENT_ROLE.role !== 'read') {
    logRejected('write_profile_not_allowed');
    return { isError: true, text: `mode=${mode} requires a read-role subagent; selected role is ${SUBAGENT_ROLE.role}.` };
  }
  if (mode === 'implement' && SUBAGENT_ROLE.role !== 'write') {
    logRejected('write_profile_required');
    return { isError: true, text: 'mode=implement requires an explicit write-role subagent.' };
  }
  let cwd;
  try { cwd = resolveCwd(args?.cwd); } catch (error) { logRejected('cwd_invalid'); throw error; }
  const maxSteps = clampInteger(args?.max_steps, preset.maxSteps, LIMITS.maxStepsCap); const timeoutSeconds = clampInteger(args?.timeout_seconds, preset.timeoutSeconds, LIMITS.timeoutSecondsCap);
  const meta = { mode, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds };
  log(`run mode=${mode} cwd=${cwd} steps<=${maxSteps} timeout=${timeoutSeconds}s`); return enqueue(() => mode === 'implement'
    ? runImplement({ cwd, maxSteps, timeoutSeconds, outputCharCap: LIMITS.outputCharCap, task })
    : runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap: LIMITS.outputCharCap, task, mode }), meta);
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const handlers = { initialize: () => ({ capabilities: { tools: {} }, protocolVersion: '2024-11-05', serverInfo: { name: SERVER_NAME, version: '1.0.0' } }), ping: () => ({}), 'tools/list': () => ({ tools: TOOLS }), 'tools/call': async (params) => { const result = await callTool(params?.name, params?.arguments ?? {}); return { content: [{ type: 'text', text: result.text }], isError: result.isError }; } };
async function handleMessage(message) {
  const { id, method, params } = message ?? {}; const notification = id === undefined || id === null;
  if (notification || typeof method !== 'string' || method.startsWith('notifications/') || method === 'initialized') return;
  const handler = handlers[method]; if (!handler) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  try { send({ jsonrpc: '2.0', id, result: await handler(params) }); } catch (error) { const text = error instanceof Error ? error.message : String(error); if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }); else send({ jsonrpc: '2.0', id, error: { code: -32603, message: text } }); }
}
log(`ready: cli=${CLI_PATH} root=${WORKSPACE_ROOT} subagent=${SUBAGENT_NAME} role=${SUBAGENT_ROLE.role} model=${MODEL_REF} source=${MODEL_REF_SOURCE}`);
const reader = createInterface({ input: process.stdin, terminal: false }); const pendingMessages = new Set();
reader.on('line', (line) => { if (!line.trim()) return; let message; try { message = JSON.parse(line); } catch { log(`ignored invalid JSON input: ${line.slice(0, 200)}`); return; } const task = handleMessage(message).catch((error) => log(`message failed: ${error?.message ?? error}`)); pendingMessages.add(task); void task.finally(() => pendingMessages.delete(task)); });
reader.on('close', () => { void Promise.allSettled([...pendingMessages]).then(() => process.exit(0)); });
