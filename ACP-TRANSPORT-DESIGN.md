# ACP Transport Design (E2)

Status: ACP-01 client layer and ACP-02 session budget coordinator landed; production transport
remains design-only. `src/server.mjs` remains stateless per call; the client, coordinator, and
`src/acp-prototype.mjs` are not imported by the server until the later coexistence/switching ticket.

The bridge now has a separate task-level checkpoint/`reasonix_resume` path. It is not ACP session
resume: it starts a new Reasonix process with an explicit continuation instruction after validating
the saved configuration and workspace fingerprints. Persistent ACP history remains design-only.

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
Reasonix operation. The coordinator remains opt-in and must be wired by the later ACP-03/04/05
tickets after lifecycle, write-policy, and transport-switching tests are complete.

## Failure and observability contract

The adapter may record only enum outcomes (`append`, `compact`, `rotate`, `per_call`), bounded
counts/byte sizes, elapsed time, and a redacted session state. It must not record message bodies.
Compaction failure is recoverable: the request still gets a stateless attempt, while the failed
persistent session remains unchanged for inspection or explicit closure. Persistent ACP remains
opt-in until a real transport, crash recovery, and provider-specific context contract are reviewed.
