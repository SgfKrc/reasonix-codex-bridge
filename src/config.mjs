/**
 * Shared configuration resolution for the Reasonix ↔ Codex bridge.
 *
 * Zero runtime dependencies.  The model reference is never hard-coded:
 *   REASONIX_MODEL_REF (env) → bridge.config.json → `reasonix doctor --json`
 *   reported default_model → refuse to start.
 * The CLI path is probed (see README) and can be pinned with REASONIX_EXE.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'reasonix-local-bridge';
export const DEFAULT_SUBAGENT = 'deepseek-worker';
export const DEFAULT_MIN_REASONIX_VERSION = '1.38.6';
export const BRIDGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SERVER_PATH = path.join(BRIDGE_ROOT, 'src', 'server.mjs');

function envPath(name, fallback) {
  const value = (process.env[name] ?? '').trim();
  return value ? path.resolve(value) : fallback;
}

export const BRIDGE_CONFIG_PATH = envPath('BRIDGE_CONFIG', path.join(BRIDGE_ROOT, 'bridge.config.json'));
export const DOCTOR_CACHE_PATH = `${BRIDGE_CONFIG_PATH}.doctor-cache.json`;
export const DEFAULT_DOCTOR_CACHE_TTL_MS = 10 * 60 * 1000;
export const PRESETS_PATH = envPath('BRIDGE_PRESETS', path.join(BRIDGE_ROOT, 'presets.json'));
export const PRESETS_EXAMPLE_PATH = path.join(BRIDGE_ROOT, 'presets.example.json');
export const CODEX_HOME = envPath('CODEX_HOME', path.join(os.homedir(), '.codex'));
export const CODEX_CONFIG_PATH = envPath('CODEX_CONFIG', path.join(CODEX_HOME, 'config.toml'));
const REASONIX_HOME = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'reasonix')
  : path.join(os.homedir(), '.config', 'reasonix');
export const REASONIX_SKILLS_PATH = envPath('REASONIX_SKILLS_DIR', path.join(REASONIX_HOME, 'skills'));

export class ConfigError extends Error {}

/** Parse the numeric portion of a Reasonix/semver-like version string. */
export function parseVersion(value) {
  const match = String(value ?? '').match(/\bv?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.-]+)?\b/i);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    normalized: `${Number(match[1])}.${Number(match[2])}.${Number(match[3] ?? 0)}`,
  };
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left;
  const b = typeof right === 'string' ? parseVersion(right) : right;
  if (!a || !b) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }
  return 0;
}

export function resolveMinReasonixVersion() {
  const configured = (process.env.REASONIX_MIN_VERSION ?? '').trim();
  if (!configured) return { version: DEFAULT_MIN_REASONIX_VERSION, source: 'bridge default', warning: '' };
  const parsed = parseVersion(configured);
  if (!parsed) {
    return {
      version: DEFAULT_MIN_REASONIX_VERSION,
      source: 'bridge default',
      warning: `REASONIX_MIN_VERSION is invalid (${configured}); using ${DEFAULT_MIN_REASONIX_VERSION}`,
    };
  }
  const version = parsed.normalized;
  return {
    version,
    source: 'REASONIX_MIN_VERSION',
    warning: compareVersions(version, DEFAULT_MIN_REASONIX_VERSION) < 0
      ? `REASONIX_MIN_VERSION=${version} relaxes the documented minimum ${DEFAULT_MIN_REASONIX_VERSION}`
      : '',
  };
}

/** Spawn options shared by doctor/version/worker calls, including Windows shims. */
export function cliSpawnOptions(cliPath, options = {}) {
  return {
    ...options,
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath),
  };
}

export function readCliVersion(cliPath, timeoutMs = 30_000) {
  if (!cliPath) return { status: 'unknown', version: null, raw: '', error: 'reasonix CLI is not available' };
  const result = spawnSync(cliPath, ['--version'], cliSpawnOptions(cliPath, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  }));
  const raw = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
  if (result.error) return { status: 'unknown', version: null, raw, error: `cannot run reasonix --version: ${result.error.message}` };
  if (result.status !== 0) return { status: 'unknown', version: null, raw, error: `reasonix --version exited with code ${result.status}` };
  const parsed = parseVersion(raw);
  if (!parsed) return { status: 'unknown', version: null, raw, error: 'reasonix --version output has no parseable semver' };
  return { status: 'ok', version: parsed.normalized, raw, error: '' };
}

export function checkCliVersion(cliPath, { minimum } = {}) {
  const configured = minimum ? { version: String(minimum), source: 'argument', warning: '' } : resolveMinReasonixVersion();
  const minimumParsed = parseVersion(configured.version) ?? parseVersion(DEFAULT_MIN_REASONIX_VERSION);
  const observed = readCliVersion(cliPath);
  const base = {
    ...observed,
    minimum: minimumParsed.normalized,
    minimumSource: configured.source,
    warning: configured.warning,
  };
  if (observed.status !== 'ok') return base;
  if (compareVersions(observed.version, minimumParsed) < 0) {
    return { ...base, status: 'fail', error: `Reasonix ${observed.version} is below minimum ${minimumParsed.normalized}` };
  }
  return base;
}

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

export function doctorCachePath(configPath = BRIDGE_CONFIG_PATH) {
  return `${path.resolve(configPath)}.doctor-cache.json`;
}

function cliMtimeMs(cliPath) {
  try {
    const stats = statSync(cliPath);
    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

function cacheableDoctorData(data) {
  const providers = Array.isArray(data?.providers) ? data.providers.flatMap((provider) => {
    if (!provider || typeof provider.name !== 'string' || !provider.name.trim()) return [];
    const safe = { name: provider.name.trim() };
    if (Array.isArray(provider.models)) safe.models = provider.models.filter((model) => typeof model === 'string' && model.trim()).map((model) => model.trim());
    else if (typeof provider.model === 'string' && provider.model.trim()) safe.model = provider.model.trim();
    if (typeof provider.key_present === 'boolean') safe.key_present = provider.key_present;
    if (typeof provider.base_url_host === 'string') safe.base_url_host = provider.base_url_host;
    if (typeof provider.context_window === 'number' && Number.isFinite(provider.context_window)) safe.context_window = provider.context_window;
    if (typeof provider.vision === 'boolean') safe.vision = provider.vision;
    return [safe];
  }) : [];
  return {
    version: typeof data?.version === 'string' ? data.version : null,
    config: { default_model: typeof data?.config?.default_model === 'string' ? data.config.default_model.trim() : '' },
    providers,
  };
}

function isCacheableDoctorData(data) {
  if (!data || typeof data !== 'object' || (data.version !== null && typeof data.version !== 'string')
    || !data.config || typeof data.config !== 'object' || typeof data.config.default_model !== 'string'
    || !Array.isArray(data.providers)) return false;
  return data.providers.every((provider) => {
    if (!provider || typeof provider !== 'object' || typeof provider.name !== 'string') return false;
    if (provider.models !== undefined && (!Array.isArray(provider.models) || provider.models.some((model) => typeof model !== 'string'))) return false;
    if (provider.model !== undefined && typeof provider.model !== 'string') return false;
    if (provider.key_present !== undefined && typeof provider.key_present !== 'boolean') return false;
    if (provider.base_url_host !== undefined && typeof provider.base_url_host !== 'string') return false;
    if (provider.context_window !== undefined && (typeof provider.context_window !== 'number' || !Number.isFinite(provider.context_window))) return false;
    return provider.vision === undefined || typeof provider.vision === 'boolean';
  });
}

function readDoctorCache(cliPath, cachePath, ttlMs) {
  const currentMtimeMs = cliMtimeMs(cliPath);
  if (currentMtimeMs === null || !isFile(cachePath)) return null;
  try {
    const cached = JSON.parse(readFileSync(cachePath, 'utf8'));
    const fetchedAt = Number(cached?.fetchedAt);
    const age = Date.now() - fetchedAt;
    if (cached?.schema !== 1 || path.resolve(String(cached.cliPath ?? '')) !== path.resolve(cliPath)
      || cached.cliMtimeMs !== currentMtimeMs || !Number.isFinite(fetchedAt) || age < 0 || age >= ttlMs
      || !isCacheableDoctorData(cached.data)) return null;
    return { ok: true, error: '', data: cached.data, cache: 'hit', cachePath, fetchedAt };
  } catch {
    return null;
  }
}

function writeDoctorCache(cliPath, cachePath, data) {
  const currentMtimeMs = cliMtimeMs(cliPath);
  if (currentMtimeMs === null) return;
  const payload = {
    schema: 1,
    cliPath: path.resolve(cliPath),
    cliMtimeMs: currentMtimeMs,
    fetchedAt: Date.now(),
    data: cacheableDoctorData(data),
  };
  try { atomicWriteFile(cachePath, `${JSON.stringify(payload, null, 2)}\n`); } catch { /* cache is an optimization; live doctor already succeeded */ }
}

/** Redacted machine inventory straight from the CLI: providers, models, default_model. */
export function readDoctor(cliPath, timeoutMs = 30_000, options = {}) {
  if (typeof timeoutMs === 'object') {
    options = timeoutMs;
    timeoutMs = 30_000;
  }
  if (!options || typeof options !== 'object') options = {};
  if (!cliPath) return { ok: false, error: 'reasonix CLI is not available', data: null };
  const cachePath = path.resolve(options.cachePath ?? DOCTOR_CACHE_PATH);
  const ttlMs = Number.isFinite(options.ttlMs) ? Math.max(0, Number(options.ttlMs)) : DEFAULT_DOCTOR_CACHE_TTL_MS;
  if (!options.refresh) {
    const cached = readDoctorCache(cliPath, cachePath, ttlMs);
    if (cached) return cached;
  }
  const result = spawnSync(cliPath, ['doctor', '--json'], cliSpawnOptions(cliPath, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
  if (result.error) return { ok: false, error: `cannot run reasonix doctor: ${result.error.message}`, data: null, cache: 'live' };
  if (result.status !== 0) return { ok: false, error: `reasonix doctor exited with code ${result.status}`, data: null, cache: 'live' };
  try {
    const data = JSON.parse(result.stdout);
    if (options.writeCache !== false) writeDoctorCache(cliPath, cachePath, data);
    return { ok: true, error: '', data, cache: options.refresh ? 'refreshed' : 'miss', cachePath, fetchedAt: Date.now() };
  } catch (error) {
    return { ok: false, error: `cannot parse reasonix doctor output: ${error.message}`, data: null, cache: 'live' };
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
        vision: typeof provider.vision === 'boolean' ? provider.vision : null,
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
export function resolveModelRef({ cliPath, bridgeConfig, doctorOptions } = {}) {
  const fromEnv = (process.env.REASONIX_MODEL_REF ?? '').trim();
  if (fromEnv) return { ref: fromEnv, source: 'REASONIX_MODEL_REF environment variable', doctor: null };
  const fromFile = typeof bridgeConfig?.data?.modelRef === 'string' ? bridgeConfig.data.modelRef.trim() : '';
  if (fromFile) return { ref: fromFile, source: bridgeConfig.path, doctor: null };
  const resolvedDoctorOptions = doctorOptions?.cachePath
    ? doctorOptions
    : { ...(doctorOptions ?? {}), cachePath: doctorCachePath(bridgeConfig?.path ?? BRIDGE_CONFIG_PATH) };
  const doctor = readDoctor(cliPath, 30_000, resolvedDoctorOptions);
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

function validProfileName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(String(name ?? '').trim());
}

export function profilePath(name, skillsPath = REASONIX_SKILLS_PATH) {
  const value = String(name ?? '').trim();
  if (!validProfileName(value)) throw new ConfigError(`invalid subagent profile name: ${value || '(empty)'}`);
  return path.join(path.resolve(skillsPath), value, 'SKILL.md');
}

function scalarValue(value) {
  const trimmed = String(value ?? '').trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.lastIndexOf('"');
    if (end > 0) return trimmed.slice(1, end);
  }
  if (trimmed.startsWith("'")) {
    const end = trimmed.lastIndexOf("'");
    if (end > 0) return trimmed.slice(1, end);
  }
  return trimmed.replace(/\s+#.*$/, '');
}

/** Parse the small YAML frontmatter contract used by Reasonix profiles. */
export function parseProfileFrontmatter(text) {
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { exists: false, fields: {}, error: 'profile has no YAML frontmatter' };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return { exists: false, fields: {}, error: 'profile frontmatter is not closed' };
  const fields = {};
  let blockListKey = '';
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (match) {
      const [, key, raw] = match;
      const trimmedRaw = raw.trim();
      if ((key === 'allowed-tools' || key === 'allowed_tools') && trimmedRaw === '') {
        fields[key] = [];
        blockListKey = key;
      } else {
        fields[key] = scalarValue(raw);
        blockListKey = '';
      }
      continue;
    }
    const item = line.match(/^\s+-\s*(.+)$/);
    if (item && blockListKey) fields[blockListKey].push(scalarValue(item[1]));
    else if (line.trim()) blockListKey = '';
  }
  const model = typeof fields.model === 'string' ? fields.model : '';
  const readOnlyRaw = fields['read-only'] ?? fields.read_only ?? fields.readOnly;
  const readOnly = typeof readOnlyRaw === 'string' ? /^(true|yes)$/i.test(readOnlyRaw) : null;
  const toolsKey = Object.prototype.hasOwnProperty.call(fields, 'allowed-tools') ? 'allowed-tools' : 'allowed_tools';
  const toolsRaw = fields[toolsKey] ?? '';
  let tools = [];
  let toolsKnown = Object.prototype.hasOwnProperty.call(fields, toolsKey);
  if (Array.isArray(toolsRaw)) {
    tools = toolsRaw;
  } else if (typeof toolsRaw === 'string' && toolsRaw.startsWith('[') && toolsRaw.endsWith(']')) {
    tools = toolsRaw.slice(1, -1).split(',').map((item) => scalarValue(item)).filter(Boolean);
  } else if (typeof toolsRaw === 'string' && toolsRaw !== '') {
    toolsKnown = false;
  }
  return { exists: true, fields, model, readOnly, tools, toolsKnown, error: '' };
}

export function readSubagentProfile(name, skillsPath = REASONIX_SKILLS_PATH) {
  let filePath;
  try {
    filePath = profilePath(name, skillsPath);
  } catch (error) {
    return { path: '', exists: false, frontmatter: null, error: error.message };
  }
  if (!isFile(filePath)) return { path: filePath, exists: false, frontmatter: null, error: 'profile file is missing' };
  try {
    const frontmatter = parseProfileFrontmatter(readFileSync(filePath, 'utf8'));
    return { path: filePath, exists: true, frontmatter, error: frontmatter.error };
  } catch (error) {
    return { path: filePath, exists: true, frontmatter: null, error: `cannot read profile: ${error.message}` };
  }
}

/** Add or normalize the read-only guard only after an explicit profile --write. */
export function ensureProfileReadOnly(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') throw new ConfigError('profile has no YAML frontmatter');
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) throw new ConfigError('profile frontmatter is not closed');
  const readOnlyIndex = lines.findIndex((line, index) => index > 0 && index < end && /^\s*(read-only|read_only|readOnly)\s*:/i.test(line));
  if (readOnlyIndex >= 0) lines[readOnlyIndex] = 'read-only: true';
  else lines.splice(end, 0, 'read-only: true');
  writeFileSync(filePath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}

export function profileDrift(profile, modelRef) {
  const issues = [];
  if (!profile?.exists) return [profile?.error || 'profile file is missing'];
  if (!profile.frontmatter?.exists) return [profile.error || 'profile frontmatter is invalid'];
  if (modelRef && profile.frontmatter.model !== modelRef) issues.push(`model=${profile.frontmatter.model || '(missing)'} expected ${modelRef}`);
  if (profile.frontmatter.readOnly !== true) issues.push('read-only: true is missing');
  return issues;
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

export function validateCodexBlock(block) {
  const lines = String(block ?? '').split(/\r?\n/).map((line) => line.trim());
  const sections = new Map();
  let section = '';
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      section = header[1];
      if (!sections.has(section)) sections.set(section, new Set());
      continue;
    }
    const key = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (key && section) sections.get(section).add(key[1]);
  }
  if (!sections.has('mcp_servers.reasonix_local')) return 'missing [mcp_servers.reasonix_local] section';
  if (!sections.has('mcp_servers.reasonix_local.env')) return 'missing [mcp_servers.reasonix_local.env] section';
  for (const key of ['command', 'args', 'startup_timeout_sec']) {
    if (!sections.get('mcp_servers.reasonix_local').has(key)) return `missing ${key} in [mcp_servers.reasonix_local]`;
  }
  for (const key of ['REASONIX_ROOT', 'REASONIX_SUBAGENT', 'REASONIX_MODEL_REF']) {
    if (!sections.get('mcp_servers.reasonix_local.env').has(key)) return `missing ${key} in [mcp_servers.reasonix_local.env]`;
  }
  return '';
}

function isReasonixSection(line) {
  const match = String(line).trim().match(/^\[([^\]]+)\]$/);
  return match && (match[1] === 'mcp_servers.reasonix_local' || match[1].startsWith('mcp_servers.reasonix_local.'));
}

function isSectionHeader(line) {
  return /^\s*\[[^\]]+\]\s*$/.test(String(line));
}

/** Replace all existing `[mcp_servers.reasonix_local*]` sections, or append one canonical block. */
export function upsertReasonixBlock(text, block) {
  const validation = validateCodexBlock(block);
  if (validation) throw new ConfigError(`invalid Codex bridge block: ${validation}`);
  const original = String(text ?? '');
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const lines = original.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === '[mcp_servers.reasonix_local]');
  const blockLines = block.replace(/\s*$/, '').split(/\r?\n/);
  if (start === -1) {
    const base = lines.join('\n').replace(/\s*$/, '');
    const result = base ? `${base}\n\n${blockLines.join('\n')}\n` : `${blockLines.join('\n')}\n`;
    return result.replace(/\n/g, newline);
  }
  const targetRanges = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isReasonixSection(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && !isSectionHeader(lines[end])) end += 1;
    targetRanges.push([index, end]);
  }
  const first = targetRanges[0]?.[0] ?? start;
  const remove = new Set(targetRanges.flatMap(([from, to]) => Array.from({ length: to - from }, (_, offset) => from + offset)));
  const retained = lines.filter((_, index) => !remove.has(index));
  let insertion = 0;
  for (let index = 0; index < first; index += 1) if (!remove.has(index)) insertion += 1;
  retained.splice(insertion, 0, ...blockLines);
  const result = retained.join('\n').replace(/^\s*\n/, '').replace(/\s*$/, '');
  return `${result}\n`.replace(/\n/g, newline);
}

/** Write through a same-directory temporary and replace the destination, restoring it on failure. */
export function atomicWriteFile(filePath, content) {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const displacedPath = `${filePath}.old-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, content, 'utf8');
  let displaced = false;
  try {
    if (process.platform === 'win32' && existsSync(filePath)) {
      renameSync(filePath, displacedPath);
      displaced = true;
    }
    renameSync(tempPath, filePath);
    if (displaced && existsSync(displacedPath)) unlinkSync(displacedPath);
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    if (displaced && !existsSync(filePath) && existsSync(displacedPath)) renameSync(displacedPath, filePath);
    throw new ConfigError(`cannot atomically replace ${filePath}: ${error.message}`);
  } finally {
    if (existsSync(tempPath)) unlinkSync(tempPath);
  }
}
