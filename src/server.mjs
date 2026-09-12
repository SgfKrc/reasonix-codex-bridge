/** Local stdio MCP facade for the read-only Reasonix worker. */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  ConfigError,
  SERVER_NAME,
  checkCliVersion,
  cliSpawnOptions,
  readBridgeConfig,
  resolveCliPath,
  resolveModelRef,
  resolveSubagent,
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
const MODES = { inspect: { maxSteps: 12, timeoutSeconds: 180 }, review: { maxSteps: 16, timeoutSeconds: 240 }, plan: { maxSteps: 16, timeoutSeconds: 240 } };
const BRIDGE_LOG_PATH = (process.env.BRIDGE_LOG ?? '').trim() ? path.resolve(process.env.BRIDGE_LOG.trim()) : '';

const TOOLS = [
  { name: 'reasonix_run', description: 'Run the read-only DeepSeek worker in inspect, review or machine-readable plan mode.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, cwd: { type: 'string' }, max_steps: { type: 'integer' }, mode: { type: 'string', enum: ['inspect', 'implement', 'review', 'plan'] }, timeout_seconds: { type: 'integer' } }, required: ['task'] } },
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
function runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap, task, mode }) {
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
      recordRun({ mode, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds, outcome, exitCode, elapsedMs: Date.now() - startedAt, outputBytes: Buffer.byteLength(stdout, 'utf8'), truncated: truncatedOutput || stdout.length > outputCharCap });
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
  if (name === 'reasonix_status') return { isError: false, text: JSON.stringify({ cli: CLI_PATH, cliExists: existsSync(CLI_PATH), version: VERSION_CHECK.version, versionCheck: VERSION_CHECK.status, versionMinimum: VERSION_CHECK.minimum, versionCheckError: VERSION_CHECK.error || null, versionCheckWarning: VERSION_CHECK.warning || null, workspaceRoot: WORKSPACE_ROOT, allowedRoots: allowedRoots(), subagent: SUBAGENT_NAME, subagentSource: SUBAGENT.source, modelRef: MODEL_REF, modelRefSource: MODEL_REF_SOURCE, bridgeConfig: bridgeConfig.path, workerReadOnlyAssumed: true, historyMode: 'stateless-per-call', historyHardCapBytes: HISTORY_HARD_CAP_BYTES, modes: Object.keys(MODES), queueDepth, inFlight, lastRun, limits: { maxStepsCap: LIMITS.maxStepsCap, taskCharCap: TASK_CHAR_CAP, timeoutSecondsCap: LIMITS.timeoutSecondsCap, outputCharCap: LIMITS.outputCharCap, queueCap: LIMITS.queueCap } }, null, 2) };
  if (name !== 'reasonix_run') throw new Error(`unknown tool: ${name}`);
  const startedAt = Date.now();
  const mode = args?.mode === undefined ? 'inspect' : String(args.mode);
  const logRejected = (error) => recordRun({ mode: ['inspect', 'review', 'implement', 'plan'].includes(mode) ? mode : 'invalid', cwdRoot: 'unknown', maxSteps: null, timeoutSeconds: null, outcome: 'rejected', exitCode: null, elapsedMs: Date.now() - startedAt, outputBytes: 0, truncated: false, error });
  const task = typeof args?.task === 'string' ? args.task.trim() : '';
  if (!task) { logRejected('task_required'); throw new Error('task is required'); }
  if (task.length > TASK_CHAR_CAP) { logRejected('task_too_long'); throw new Error(`task exceeds ${TASK_CHAR_CAP} chars`); }
  if (mode === 'implement') { logRejected('implement_disabled'); return { isError: true, text: 'mode=implement is disabled; Codex applies all changes.' }; }
  const preset = MODES[mode];
  if (!preset) { logRejected('mode_invalid'); throw new Error('mode must be inspect or review'); }
  let cwd;
  try { cwd = resolveCwd(args?.cwd); } catch (error) { logRejected('cwd_invalid'); throw error; }
  const maxSteps = clampInteger(args?.max_steps, preset.maxSteps, LIMITS.maxStepsCap); const timeoutSeconds = clampInteger(args?.timeout_seconds, preset.timeoutSeconds, LIMITS.timeoutSecondsCap);
  const meta = { mode, cwdRoot: cwdRootLabel(cwd), maxSteps, timeoutSeconds };
  log(`run mode=${mode} cwd=${cwd} steps<=${maxSteps} timeout=${timeoutSeconds}s`); return enqueue(() => runWorker({ cwd, maxSteps, timeoutSeconds, outputCharCap: LIMITS.outputCharCap, task, mode }), meta);
}
function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
const handlers = { initialize: () => ({ capabilities: { tools: {} }, protocolVersion: '2024-11-05', serverInfo: { name: SERVER_NAME, version: '1.0.0' } }), ping: () => ({}), 'tools/list': () => ({ tools: TOOLS }), 'tools/call': async (params) => { const result = await callTool(params?.name, params?.arguments ?? {}); return { content: [{ type: 'text', text: result.text }], isError: result.isError }; } };
async function handleMessage(message) {
  const { id, method, params } = message ?? {}; const notification = id === undefined || id === null;
  if (notification || typeof method !== 'string' || method.startsWith('notifications/') || method === 'initialized') return;
  const handler = handlers[method]; if (!handler) return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method: ${method}` } });
  try { send({ jsonrpc: '2.0', id, result: await handler(params) }); } catch (error) { const text = error instanceof Error ? error.message : String(error); if (method === 'tools/call') send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } }); else send({ jsonrpc: '2.0', id, error: { code: -32603, message: text } }); }
}
log(`ready: cli=${CLI_PATH} root=${WORKSPACE_ROOT} subagent=${SUBAGENT_NAME} model=${MODEL_REF} source=${MODEL_REF_SOURCE} readOnly=true`);
const reader = createInterface({ input: process.stdin, terminal: false }); const pendingMessages = new Set();
reader.on('line', (line) => { if (!line.trim()) return; let message; try { message = JSON.parse(line); } catch { log(`ignored invalid JSON input: ${line.slice(0, 200)}`); return; } const task = handleMessage(message).catch((error) => log(`message failed: ${error?.message ?? error}`)); pendingMessages.add(task); void task.finally(() => pendingMessages.delete(task)); });
reader.on('close', () => { void Promise.allSettled([...pendingMessages]).then(() => process.exit(0)); });
