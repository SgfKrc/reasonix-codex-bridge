/**
 * Shared configuration resolution for the Reasonix ↔ Codex bridge.
 *
 * Zero runtime dependencies.  The model reference is never hard-coded:
 *   REASONIX_MODEL_REF (env) → bridge.config.json → `reasonix doctor --json`
 *   reported default_model → refuse to start.
 * The CLI path is probed (see README) and can be pinned with REASONIX_EXE.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'reasonix-local-bridge';
export const DEFAULT_SUBAGENT = 'deepseek-worker';
export const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_PATH = path.join(BRIDGE_ROOT, 'src', 'server.mjs');

function envPath(name, fallback) {
  const value = (process.env[name] ?? '').trim();
  return value ? path.resolve(value) : fallback;
}

export const BRIDGE_CONFIG_PATH = envPath('BRIDGE_CONFIG', path.join(BRIDGE_ROOT, 'bridge.config.json'));
export const PRESETS_PATH = envPath('BRIDGE_PRESETS', path.join(BRIDGE_ROOT, 'presets.json'));
export const PRESETS_EXAMPLE_PATH = path.join(BRIDGE_ROOT, 'presets.example.json');
export const CODEX_HOME = envPath('CODEX_HOME', path.join(os.homedir(), '.codex'));
export const CODEX_CONFIG_PATH = envPath('CODEX_CONFIG', path.join(CODEX_HOME, 'config.toml'));

export class ConfigError extends Error {}

export function isFile(candidate) {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

/** Explicit REASONIX_EXE wins; otherwise probe standard install locations and PATH. */
export function resolveCliPath() {
  const configured = (process.env.REASONIX_EXE ?? '').trim();
  if (configured) {
    const explicit = path.resolve(configured);
    if (isFile(explicit)) return explicit;
    throw new ConfigError(`REASONIX_EXE is set but is not a readable file: ${explicit}`);
  }
  const candidates = cliCandidates();
  for (const candidate of candidates) if (isFile(candidate)) return candidate;
  throw new ConfigError(`reasonix CLI not found and REASONIX_EXE is unset (probed ${candidates.length} standard location(s))`);
}

function cliCandidates() {
  if (process.platform !== 'win32') {
    return ['/usr/local/bin/reasonix-cli', '/usr/bin/reasonix-cli', '/opt/reasonix/reasonix-cli', ...pathCandidates(['reasonix-cli'])];
  }
  const programs = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Reasonix') : '';
  const candidates = [];
  if (programs) {
    candidates.push(path.join(programs, 'reasonix-cli.exe'));
    const versionsRoot = path.join(programs, 'versions');
    let entries = [];
    try { entries = readdirSync(versionsRoot, { withFileTypes: true }); } catch { entries = []; }
    const versions = entries
      .filter((entry) => entry.isDirectory() && /^v?\d+(?:\.\d+)*$/.test(entry.name))
      .map((entry) => entry.name)
      .sort(compareVersions)
      .reverse();
    for (const version of versions) candidates.push(path.join(versionsRoot, version, 'reasonix-cli.exe'));
  }
  return [...candidates, ...pathCandidates(['reasonix-cli.exe'])];
}

function pathCandidates(names) {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function compareVersions(left, right) {
  const a = left.replace(/^v/i, '').split('.').map(Number);
  const b = right.replace(/^v/i, '').split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/** Redacted machine inventory straight from the CLI: providers, models, default_model. */
export function readDoctor(cliPath, timeoutMs = 30_000) {
  if (!cliPath) return { ok: false, error: 'reasonix CLI is not available', data: null };
  const result = spawnSync(cliPath, ['doctor', '--json'], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) return { ok: false, error: `cannot run reasonix doctor: ${result.error.message}`, data: null };
  if (result.status !== 0) return { ok: false, error: `reasonix doctor exited with code ${result.status}`, data: null };
  try {
    return { ok: true, error: '', data: JSON.parse(result.stdout) };
  } catch (error) {
    return { ok: false, error: `cannot parse reasonix doctor output: ${error.message}`, data: null };
  }
}

/** Flatten doctor output into selectable `<provider>/<model>` refs. */
export function doctorRefs(doctor) {
  const defaultRef = typeof doctor?.config?.default_model === 'string' ? doctor.config.default_model.trim() : '';
  const refs = [];
  for (const provider of Array.isArray(doctor?.providers) ? doctor.providers : []) {
    if (!provider || typeof provider.name !== 'string' || !provider.name.trim()) continue;
    const models = Array.isArray(provider.models) && provider.models.length
      ? provider.models
      : (typeof provider.model === 'string' ? [provider.model] : []);
    for (const model of models) {
      if (typeof model !== 'string' || !model.trim()) continue;
      const ref = `${provider.name.trim()}/${model.trim()}`;
      refs.push({
        ref,
        provider: provider.name.trim(),
        model: model.trim(),
        keyPresent: provider.key_present === true,
        baseHost: typeof provider.base_url_host === 'string' ? provider.base_url_host : '',
        contextWindow: typeof provider.context_window === 'number' ? provider.context_window : null,
        isReasonixDefault: ref === defaultRef,
      });
    }
  }
  return { refs, defaultRef };
}

export function readBridgeConfig(configPath = BRIDGE_CONFIG_PATH) {
  if (!isFile(configPath)) return { path: configPath, exists: false, data: {} };
  let text;
  try { text = readFileSync(configPath, 'utf8'); } catch (error) { throw new ConfigError(`cannot read ${configPath}: ${error.message}`); }
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('expected a JSON object');
    return { path: configPath, exists: true, data };
  } catch (error) {
    throw new ConfigError(`invalid bridge config ${configPath}: ${error.message}`);
  }
}

/** Resolves the subagent model ref, recording where it came from. */
export function resolveModelRef({ cliPath, bridgeConfig } = {}) {
  const fromEnv = (process.env.REASONIX_MODEL_REF ?? '').trim();
  if (fromEnv) return { ref: fromEnv, source: 'REASONIX_MODEL_REF environment variable', doctor: null };
  const fromFile = typeof bridgeConfig?.data?.modelRef === 'string' ? bridgeConfig.data.modelRef.trim() : '';
  if (fromFile) return { ref: fromFile, source: bridgeConfig.path, doctor: null };
  const doctor = readDoctor(cliPath);
  if (doctor.ok) {
    const ref = typeof doctor.data?.config?.default_model === 'string' ? doctor.data.config.default_model.trim() : '';
    if (ref) return { ref, source: 'reasonix default_model (auto fallback)', doctor };
  }
  return { ref: '', source: '', doctor, error: doctor.error || 'reasonix reported no default_model' };
}

export function validateModelRef(ref) {
  const value = (ref ?? '').trim();
  if (!value) return 'model reference is empty';
  if (/\s/.test(value)) return 'model reference must not contain whitespace';
  if (!value.includes('/')) return 'model reference must look like <provider>/<model>';
  return '';
}

export function resolveSubagent(bridgeConfig) {
  const fromEnv = (process.env.REASONIX_SUBAGENT ?? '').trim();
  if (fromEnv) return { name: fromEnv, source: 'REASONIX_SUBAGENT environment variable' };
  const fromFile = typeof bridgeConfig?.data?.subagent === 'string' ? bridgeConfig.data.subagent.trim() : '';
  if (fromFile) return { name: fromFile, source: bridgeConfig.path };
  return { name: DEFAULT_SUBAGENT, source: 'bridge default' };
}

export function resolveWorkspaceRoot(bridgeConfig) {
  const fromEnv = (process.env.REASONIX_ROOT ?? '').trim();
  if (fromEnv) return path.resolve(fromEnv);
  const fromFile = typeof bridgeConfig?.data?.root === 'string' ? bridgeConfig.data.root.trim() : '';
  if (fromFile) return path.resolve(fromFile);
  return process.cwd();
}

export function readPresets(presetsPath = PRESETS_PATH) {
  if (!isFile(presetsPath)) return { path: presetsPath, exists: false, presets: [] };
  let data;
  try { data = JSON.parse(readFileSync(presetsPath, 'utf8')); } catch (error) { throw new ConfigError(`invalid presets file ${presetsPath}: ${error.message}`); }
  const presets = Array.isArray(data?.presets) ? data.presets : [];
  return {
    path: presetsPath,
    exists: true,
    presets: presets.filter((item) => item && typeof item.name === 'string' && typeof item.modelRef === 'string' && item.modelRef.includes('/')),
  };
}

/** TOML-safe value: forward slashes avoid the `\U` escape trap on Windows paths. */
function tomlValue(value) {
  return String(value).replace(/\\/g, '/').replace(/"/g, '\\"');
}

export function buildCodexBlock({ modelRef, subagent, root, cliPath }) {
  const lines = [
    '[mcp_servers.reasonix_local]',
    'command = "node"',
    `args = ["${tomlValue(SERVER_PATH)}"]`,
    'startup_timeout_sec = 30',
    '',
    '[mcp_servers.reasonix_local.env]',
  ];
  if (cliPath) lines.push(`REASONIX_EXE = "${tomlValue(cliPath)}"`);
  lines.push(
    `REASONIX_ROOT = "${tomlValue(root)}"`,
    `REASONIX_SUBAGENT = "${tomlValue(subagent)}"`,
    `REASONIX_MODEL_REF = "${tomlValue(modelRef)}"`,
  );
  return `${lines.join('\n')}\n`;
}

/** Replace the existing `[mcp_servers.reasonix_local*]` block, or append it. */
export function upsertReasonixBlock(text, block) {
  const lines = String(text ?? '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '[mcp_servers.reasonix_local]');
  const blockLines = block.replace(/\s*$/, '').split('\n');
  if (start === -1) {
    const base = lines.join('\n').replace(/\s*$/, '');
    return base ? `${base}\n\n${blockLines.join('\n')}\n` : `${blockLines.join('\n')}\n`;
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (trimmed.startsWith('[') && !trimmed.startsWith('[mcp_servers.reasonix_local')) { end = index; break; }
  }
  const before = lines.slice(0, start).join('\n').replace(/\s*$/, '');
  const after = lines.slice(end).join('\n').replace(/^\s*\n/, '');
  const parts = [before, blockLines.join('\n'), after].filter((part) => part.trim() !== '');
  return `${parts.join('\n\n')}\n`;
}
