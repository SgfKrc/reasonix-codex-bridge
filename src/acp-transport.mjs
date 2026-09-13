/**
 * Opt-in ACP/per-call transport switch.
 *
 * This adapter owns only read-mode ACP sessions. Implement calls continue to
 * use the bridge's existing Git-audited path. A transport fault is isolated to
 * ACP, marks the adapter degraded, and retries the same request through the
 * explicit per-call fallback supplied by the embedding server.
 */
import { randomUUID } from 'node:crypto';
import { AcpError } from './acp-client.mjs';
import { AcpSessionCoordinator } from './acp-session.mjs';

const SECURITY_ERROR_PREFIXES = ['session_scope_', 'write_', 'read_mode_', 'mode_'];

function clone(value) {
  return structuredClone(value);
}

function validSessionKey(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\r\n]/u.test(value)) {
    throw new AcpError('session_id must be a short opaque identifier', { code: 'session_scope_invalid' });
  }
  return value.trim();
}

function truncate(value, cap) {
  const text = String(value ?? '');
  if (text.length <= cap) return { text, truncated: false, originalLength: text.length };
  return { text: `${text.slice(0, cap)}\n\n[output truncated; original ${text.length} chars]`, truncated: true, originalLength: text.length };
}

function securityError(error) {
  return SECURITY_ERROR_PREFIXES.some((prefix) => String(error?.code ?? '').startsWith(prefix));
}

function transportError(error) {
  return ['spawn_rejected', 'spawn_error', 'timeout', 'process_exit', 'not_started', 'not_initialized', 'capability_missing', 'invalid_response', 'protocol_error', 'write_error', 'closed'].includes(error?.code);
}

/**
 * Coordinates ACP sessions for an embedding server. `fallback` receives the
 * original request and `{ reason, error, cancelRef }`; it must execute the
 * existing per-call path and retain its normal audit/checkpoint behavior.
 */
export class AcpTransportManager {
  constructor({ clientFactory, fallback, securityPolicy = null, outputCharCap = 24_000, owner = 'mcp-stdio', onEvent = null } = {}) {
    if (typeof clientFactory !== 'function') throw new TypeError('clientFactory is required');
    if (typeof fallback !== 'function') throw new TypeError('fallback is required');
    if (securityPolicy !== null && (typeof securityPolicy !== 'object' || typeof securityPolicy.authorizeCall !== 'function')) throw new TypeError('securityPolicy must expose authorizeCall or be null');
    if (!Number.isInteger(outputCharCap) || outputCharCap < 1) throw new RangeError('outputCharCap must be a positive integer');
    if (typeof owner !== 'string' || !owner.trim()) throw new TypeError('owner must be a non-empty string');
    this.clientFactory = clientFactory;
    this.fallback = fallback;
    this.securityPolicy = securityPolicy;
    this.outputCharCap = outputCharCap;
    this.owner = owner.trim();
    this.onEvent = onEvent;
    this.sessions = new Map();
    this.degraded = false;
    this.fallbackCount = 0;
    this.lastFallback = null;
  }

  get status() {
    return { degraded: this.degraded, persistentSessions: this.sessions.size, fallbackCount: this.fallbackCount, lastFallback: this.lastFallback ? { reason: this.lastFallback.reason, code: this.lastFallback.code } : null };
  }

  async run({ sessionId = null, taskId = null, owner = this.owner, task, mode = 'inspect', cwd, profile = '', model = '', maxSteps = null, timeoutSeconds = null, timeoutMs, outputCharCap = this.outputCharCap, cancelRef = null, requestedPaths = [] } = {}) {
    const startedAt = Date.now();
    const key = validSessionKey(sessionId);
    const scopedTaskId = taskId ?? key ?? randomUUID();
    const request = { sessionId: key, taskId: scopedTaskId, owner, task, mode, cwd, profile, model, maxSteps, timeoutSeconds, timeoutMs, outputCharCap, cancelRef, requestedPaths };
    request.startedAt = startedAt;
    if (mode === 'implement') return this.#fallback(request, 'write_mode_per_call');
    if (this.degraded) return this.#fallback(request, 'acp_degraded');
    let entry = null;
    let client = null;
    let coordinator = null;
    let ephemeral = false;
    try {
      entry = key ? this.sessions.get(key) : null;
      if (entry) {
        this.#authorize(entry, request);
      } else {
        const metadata = { sessionId: key ?? `ephemeral-${randomUUID()}`, cwd, profile, model, owner, taskId: scopedTaskId };
        this.#authorize(metadata, request);
        client = await this.clientFactory({ cwd, profile, model, owner, taskId: scopedTaskId, sessionId: key, timeoutMs });
        coordinator = new AcpSessionCoordinator({
          client,
          fallbackPrompt: (text, context) => {
            const reason = context.error?.code ? `acp_${context.error.code}` : `acp_${context.reason ?? 'per_call'}`;
            return this.#fallback({ ...request, task: text }, reason, context.error);
          },
          sanitizePrompt: this.securityPolicy?.sanitizeText ? this.securityPolicy.sanitizeText.bind(this.securityPolicy) : undefined,
        });
        await coordinator.start({ cwd });
        entry = { key, metadata, client, coordinator, internalSessionId: coordinator.sessionId };
        if (key) this.sessions.set(key, entry);
        else ephemeral = true;
      }
      this.#authorize(entry, request);
      if (cancelRef && typeof cancelRef === 'object') {
        let cancelSent = false;
        cancelRef.cancel = () => {
          if (cancelSent) return;
          cancelSent = true;
          void entry.client.cancel?.(entry.internalSessionId).catch?.(() => {});
        };
        if (cancelRef.requested) cancelRef.cancel();
      }
      const result = await entry.coordinator.prompt(task, { timeoutMs });
      if (cancelRef?.requested) return this.#cancelled(request, entry);
      if (result?.transport === 'per_call' || result?.meta?.transport === 'per-call') {
        const reason = result.meta?.transportFallback ?? '';
        if (/^acp_(?:timeout|process_exit|spawn_|protocol_error|write_error|closed|not_started|not_initialized)/u.test(reason)) {
          this.degraded = true;
          await this.#closeEntry(entry, key);
        }
        return { ...result, meta: { ...(result.meta ?? {}), transport: 'per-call', transportFallback: result.meta?.transportFallback ?? 'acp_per_call' } };
      }
      const body = truncate(result?.text ?? '', Math.max(1, Math.min(outputCharCap, this.outputCharCap)));
      this.onEvent?.({ action: 'acp_success', sessionId: key, mode, truncated: body.truncated });
      return {
        isError: false,
        text: `[mode=${mode} cwd=${cwd} model=${model} transport=acp session=${key ?? 'ephemeral'}]\n\n${body.text || '[worker returned no content]'}`,
        meta: { outcome: 'success', transport: 'acp', sessionId: key, internalSessionId: entry.internalSessionId, outputBytes: Buffer.byteLength(body.text, 'utf8'), truncated: body.truncated, originalOutputChars: body.originalLength, elapsedMs: Date.now() - startedAt, maxSteps, timeoutSeconds },
      };
    } catch (error) {
      if (cancelRef?.requested) return this.#cancelled(request, entry);
      if (securityError(error)) throw error;
      if (!transportError(error) && !(error instanceof AcpError)) throw error;
      this.degraded = true;
      this.lastFallback = { reason: `acp_${error?.code ?? 'error'}`, code: error?.code ?? 'error' };
      this.onEvent?.({ action: 'acp_fallback', sessionId: key, reason: this.lastFallback.reason, code: this.lastFallback.code });
      if (entry) {
        await this.#closeEntry(entry, key);
      } else {
        try { await coordinator?.close?.(); } catch { /* best effort */ }
        try { await client?.close?.(); } catch { /* best effort */ }
      }
      return this.#fallback(request, this.lastFallback.reason, error);
    } finally {
      if (ephemeral) await this.#closeEntry(entry, null);
      if (cancelRef && typeof cancelRef === 'object') cancelRef.cancel = null;
    }
  }

  async close() {
    const entries = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(entries.map((entry) => this.#closeEntry(entry, null)));
  }

  #authorize(entry, request) {
    this.securityPolicy?.authorizeCall(entry.metadata ?? entry, {
      mode: request.mode,
      role: request.mode === 'implement' ? 'write' : 'read',
      owner: request.owner,
      taskId: request.taskId,
      cwd: request.cwd,
      profile: request.profile,
      model: request.model,
      requestedPaths: request.requestedPaths,
    });
  }

  async #closeEntry(entry, key) {
    if (!entry) return;
    if (key) this.sessions.delete(key);
    try { await entry.coordinator?.close?.(); } catch { /* best effort */ }
    try { await entry.client?.close?.(); } catch { /* best effort */ }
  }

  #cancelled(request, entry) {
    return { isError: true, text: `worker cancelled (transport=acp session=${request.sessionId ?? 'ephemeral'})`, meta: { outcome: 'cancelled', transport: 'acp', sessionId: request.sessionId, internalSessionId: entry?.internalSessionId ?? null, exitCode: null, elapsedMs: Date.now() - request.startedAt, outputBytes: 0, truncated: false } };
  }

  async #fallback(request, reason, error = null) {
    this.fallbackCount += 1;
    this.lastFallback = { reason, code: error?.code ?? null };
    const result = await this.fallback(request, { reason, error, cancelRef: request.cancelRef });
    return { ...result, meta: { ...(result?.meta ?? {}), transport: 'per-call', transportFallback: reason } };
  }
}
