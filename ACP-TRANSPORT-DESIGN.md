# ACP Transport Design (E2)

Status: design-only. `src/server.mjs` remains stateless per call; this document and
`src/acp-prototype.mjs` do not enable a persistent production transport.

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

## Failure and observability contract

The adapter may record only enum outcomes (`append`, `compact`, `rotate`, `per_call`), bounded
counts/byte sizes, elapsed time, and a redacted session state. It must not record message bodies.
Compaction failure is recoverable: the request still gets a stateless attempt, while the failed
persistent session remains unchanged for inspection or explicit closure. Persistent ACP remains
opt-in until a real transport, crash recovery, and provider-specific context contract are reviewed.
