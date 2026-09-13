# ACP Transport Design (E2)

Status: ACP-01 through ACP-05 have landed. The ACP-06 offline acceptance drill passes. Production
default transport remains stateless per-call; `transport: "acp"` is an explicit, read-only,
process-local opt-in with automatic per-call fallback. Real Reasonix cross-process resume is
blocked until a session that has produced a prompt is persisted by the provider.

The bridge now has a separate task-level checkpoint/`reasonix_resume` path. It is not ACP session
resume: it starts a new Reasonix process with an explicit continuation instruction after validating
the saved configuration and workspace fingerprints. Durable ACP history remains opt-in and
provider-gated.

## Goals and boundaries

- Keep the current per-call MCP bridge as the canonical fallback.
- Model a future ACP adapter with explicit session lifecycle and transactional history changes.
- Never make Reasonix's 128 MiB conversation-history limit configurable.
- Never put task text, worker output, credentials, model refs, or absolute paths in lifecycle logs.

## Lifecycle

1. `idle -> active`: create a session with an empty history and an adapter-owned session id.
2. `active -> compacting`: estimate the candidate history before sending the next message. The
   prototype triggers compaction at 75% of the hard cap, leaving headroom for protocol framing.
3. `compacting -> active`: summarize the oldest non-system messages while preserving system
   messages and the two most recent non-system messages. Commit the replacement atomically only
   after the summary is valid and the resulting byte count is below the hard cap.
4. `compacting -> rotating`: if a valid compacted history is still at or above 128 MiB, close the
   old session and start a new one containing only the next message.
5. `compacting -> fallback_per_call`: if summarization throws or returns invalid output, discard
   the candidate copy, leave persistent history unchanged, and execute this request through the
   existing stateless per-call path.
6. `active -> closed`: close on explicit shutdown, transport error, or process exit. A reconnect
   starts from a fresh session unless a future durable store has its own integrity contract.

The transition is deliberately transactional: there is no partially compacted history and no
retry that mutates the original messages. `src/acp-prototype.mjs` exposes the pure decision and
compaction functions used by the offline tests.

## Budget and rotation rules

`128 * 1024 * 1024` bytes is a fixed Reasonix hard constraint. The 75% trigger is an adapter
policy, not a replacement for the limit. Every candidate is measured before append; no request may
be sent with a history at or above the hard cap. If compaction cannot produce a smaller valid
history, rotation is preferred when compaction succeeded, otherwise per-call fallback is used.

The current bridge already enforces stateless per-call execution, output caps, timeouts, queue
limits, and read-only mode. A future ACP adapter must reuse those limits and must not silently
change `mode=implement` or turn a plan into a write.

## ACP-01 client boundary

`src/acp-client.mjs` owns one ACP child process and exposes newline-delimited JSON-RPC requests for
`initialize`, `session/new`, `session/load`, `session/resume`, `session/prompt`, `session/cancel`,
`session/close`, and capability-gated `session/delete`. It rejects load/resume when the agent does not advertise the corresponding
capability, aggregates `session/update` notifications for a prompt, rejects permission requests by
default, and sends `session/cancel` before surfacing a prompt timeout. It bounds captured stderr and
terminates the child tree during shutdown. The module deliberately does not persist sessions,
compact history, authorize writes, or alter the MCP server's default per-call path.

## ACP-02 session budget coordinator

`src/acp-session.mjs` now connects the pure budget decision to an `AcpClient` without changing the
server entry point. `summarizeAcpMessages` is deterministic and bounded (512 characters per source
message and 12,000 characters total by default); callers may inject a later LLM summarizer. Each
prompt records only action, reason, bounded byte counts, summarized message count, elapsed time, and
whether a fallback was used.

The `append` branch prompts the active session and commits adapter history only after success. The
`compact` and `rotate` branches create a replacement session, send a bounded context envelope, and
close/delete the old session only after the replacement prompt succeeds. A replacement failure
closes the new session and invokes the explicit stateless fallback, leaving the old session and
history unchanged. Summarizer failure or an invalid summary follows the same per-call fallback; the
fallback receives only the next message and reason, never persistent history.

This is an adapter-level implementation, not a claim that ACP history replacement is a native
Reasonix operation. The coordinator remains opt-in and is wired by the ACP-05 transport manager;
durable cross-process recovery is accepted only after the ACP-06 provider persistence gate passes.

## ACP-03 session registry and lifecycle

`src/acp-registry.mjs` provides the next opt-in layer: a durable metadata registry keyed by
`sessionId`, with `cwd`, profile, model, state, and timestamps. The registry file never stores task
or response bodies. `prompt` calls are chained per session, so concurrent callers cannot interleave
requests or cross session state. `close` and `delete` are serialized behind pending prompts; delete
sends ACP `session/delete` before closing the client process and removes the metadata only after
success.

On a new bridge process, persisted entries are loaded as `orphaned` until a caller supplies a
client factory and successfully completes capability-gated `session/resume` (or `session/load` as a
fallback). A crashed transport is detected before prompt dispatch and cannot be used until resumed.
`shutdown` closes every live entry and reports failures, while `installProcessHandlers` exposes the
embedding layer's signal/exit cleanup hook. The registry is not imported by `server.mjs`; process
ownership and durable recovery remain gated by the real-provider persistence
acceptance described in ACP-06. An embedding layer
may attach the ACP-04 `AcpSecurityPolicy` to the registry; each queued prompt is then checked again
before dispatch so a caller cannot bypass the session scope through queue timing.

## ACP-04 security gate and history hygiene

`src/acp-security.mjs` is the opt-in security layer for a persistent session. `AcpSecurityPolicy`
binds each call to an opaque `owner` and `taskId`, requires the session cwd to remain unchanged and
inside the configured workspace/allowed roots, and rejects profile/model drift. Implement calls
must use the explicit write role and the same fail-closed `allowWrite`, `requireCleanTree`, and
repository-relative `allowedPaths` policy resolved by `resolveWritePolicy`; a requested path outside
that whitelist is rejected before transport dispatch. The existing server-side Git diff and rollback
audit remains authoritative for actual writes, so this preflight does not weaken the write contract.

`scrubAcpContent`/`scrubAcpMessages` redact `.env`-style file payloads, credential assignments,
Bearer tokens, and private-key blocks. `AcpSessionCoordinator` accepts an opt-in `sanitizePrompt`
function and always scrubs assistant responses before retaining local continuation history. The
registry persists only the opaque scope metadata, never prompts or responses. ACP-04 remains opt-in:
`server.mjs` loads the security gate through the ACP-05 transport manager only when
`transport: "acp"` is selected; the registry remains unwired in the production
server path pending the real-provider persistence gate from ACP-06.

## ACP-05 coexistence and switching

`resolveTransport` accepts only `per-call` (the default) or explicit `acp`; malformed values fail
closed to `per-call`. When `transport: "acp"` is configured, read-only `reasonix_run` calls use an
in-process `AcpTransportManager` only when the caller supplies an opaque `session_id`. Calls without
that id remain one-shot ACP sessions, while `implement` and explicit `parallel=true` calls always
stay on the existing per-call path so Git write auditing and the read-only parallel lane are unchanged.

The manager creates one `AcpClient`/coordinator per session key, routes compact/fallback results back
through the normal per-call worker, and marks ACP degraded after a startup, protocol, timeout, or
process failure. Degraded and unsupported ACP calls automatically use the same per-call worker with
the original limits and checkpoint behavior. `reasonix_status` reports the configured transport and
bounded ACP session/fallback counters; no prompt or response body is placed in status or logs.
The switch is explicit and process-local in ACP-05. ACP-06 now supplies the offline lifecycle
gate, while provider-backed cross-process recovery remains blocked until the persistence
semantics are demonstrated with a non-empty session.

## ACP-06 acceptance drill

`scripts/acp-acceptance.mjs` is a deterministic, model-free acceptance entry point. It writes
only under the ignored project-local `build/bridge-test/` root (with no task or response bodies),
starts a separate registry child, strongly terminates it, reloads the metadata registry as an
orphan, resumes and prompts through a fixture, and verifies compact/rotate, serialized
concurrency, cancellation, child cleanup, and artifact removal. Run:

```text
npm run check
npm run acceptance:acp
```

The offline command returns a bounded JSON report with
`process.childExited=true`, `resume.resumed=true`, `compact.replacementCleanup=true`,
`transport.serialized=true`, `transport.cancelled=true`, `realClient.childClosed=true`, and
`artifacts.retainedBodies=false`. The current bridge regression is `92 passed / 0 failed`.

The opt-in real-provider control-plane probe is:

```text
npm run acceptance:acp:real
```

On 2026-09-13 with Reasonix CLI v1.38.7 it created a session, strongly killed the ACP child, and
then received `unknown session` when resuming the empty session. The command intentionally emits
`qlh.reasonix.acp.acceptance.real.v1` with `status: "blocked"`,
`reason: "empty_session_not_persisted"`, and exit code 2. This is an external provider
persistence boundary, not an offline bridge failure. No model prompt is sent by this probe; rerun
after a provider-backed persistence fixture or an explicitly approved real prompt test.

## Failure and observability contract

The adapter may record only enum outcomes (`append`, `compact`, `rotate`, `per_call`), bounded
counts/byte sizes, elapsed time, and a redacted session state. It must not record message bodies.
Compaction failure is recoverable: the request still gets a stateless attempt, while the failed
persistent session remains unchanged for inspection or explicit closure. Persistent ACP remains
opt-in until a real transport, crash recovery, and provider-specific context/persistence contract
are reviewed. A real provider result of `blocked` is surfaced as such and never treated as a pass.
