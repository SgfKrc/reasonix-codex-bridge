# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- `reasonix_exec` controlled command runner: named executable profiles, argv-only invocation with `shell:false`, clean-tree/workspace guards, bounded output, cancellation, mutation detection, redacted structured results, and disabled-by-default policy.
- Aligned the canonical read/write profile tool sets with Reasonix v1.38.7 by removing unknown `git_log`/`git_diff` identities; `configure verify` now fails on matching doctor warnings.
- Delegated the optional native `web_fetch` capability to both Reasonix profiles without adding a bridge network stack or arbitrary-URL MCP tool.
- Added fail-closed `reasonix_status.providerSearch` reporting for provider-owned `web_search`; unavailable providers are never represented by fabricated results or a bridge-side search backend.
- Added explicit workflow-stage metadata for the main-agent `plan -> implement -> exec -> review` template; stages are visible in status, job summaries, checkpoints, and optional call logs without automatic advancement or retry.
- Added `reasonix_events` for bounded, ordered, redacted job lifecycle polling with incremental per-job cursors and terminal cancellation/completion events.
- ACP-01 newline-delimited JSON-RPC client with capability-gated session lifecycle, prompt update aggregation, cancellation, and process cleanup.
- ACP-02 opt-in `AcpSessionCoordinator` with bounded deterministic summaries, transactional replacement sessions for compact/rotate, redacted decision telemetry, and explicit stateless fallback.
- ACP client `session/delete` support with capability gating and local session-set cleanup.
- ACP-03 opt-in `AcpSessionRegistry` with metadata-only persistence, orphan detection, capability-gated resume/load/delete, per-session prompt serialization, and explicit shutdown cleanup; production registry wiring remains gated by the ACP-06 real-provider persistence acceptance.
- ACP-04 opt-in `AcpSecurityPolicy` for owner/task isolation, workspace and profile/model pinning, fail-closed write-path preflight, and bounded credential/history scrubbing; ACP-05 loads it only for explicit read-only ACP transport.
- ACP-05 explicit `transport: "acp"` coexistence manager for read-only session ids, with per-call fallback on startup/protocol/timeout failures; default transport and implement/parallel lanes remain per-call.
- ACP-06 model-free acceptance drill under `build/bridge-test/`: strong-kill orphan/resume, metadata-only persistence, compact/rotate, serialized concurrency, cancellation, child cleanup, and artifact removal; real-provider probe reports a structured blocked result when an empty session is not persisted.
- Separate `read` and `write` profile contracts via `configure profile --role read|write`.
- The write profile uses only `edit_file` and `write_file` beyond the canonical read tools, omits `read-only`, and has a dedicated implementation prompt.
- Role-aware verification and status reporting for the explicit write profile workflow.
- Run-mode authorization now rejects write profiles in inspect/review/plan and requires a write profile for implement.
- Unsafe `requireCleanTree=false` write policies are rejected; controlled writes always require a clean Git tree.
- Durable, one-shot `reasonix_resume` checkpoints for recoverable worker failures. Resume validates the selected profile/configuration and Git workspace snapshot, consumes the checkpoint before spawning, and never replays a task implicitly.
- Explicit read-only parallel worker jobs with per-job status, cancellation, slot reclamation, and an exclusive lane for implement/resume/rollback operations.

### Changed

- Widened the finite runtime budget envelope to 256 raw Reasonix steps (128 tool-call rounds) and 1800 seconds; callers still opt in per call via `tool_rounds`/`timeout_seconds` and the hard caps remain enforced.
- Made output-cap handling deterministic across platforms: output overflow is bounded and reported as `truncated=true` without terminating the worker; timeout and explicit cancellation still terminate it.
- Test fixtures now prefer project-local `build/bridge-test/` (covered by `.gitignore`) and fall back to the system temp directory only when the project path cannot be created.
- Added `AcpClient.abort()` for strong-kill lifecycle drills and single-flight ACP session creation plus per-session prompt serialization in the coexistence manager; failed registry creation now closes a started client before propagating the error.

## [0.1.0] - 2026-09-12

### Added

- Read-only stdio MCP bridge for `reasonix_run` and `reasonix_status`.
- Offline configuration, profile drift verification, redacted doctor cache, limits, queue telemetry, and optional call logging.
- Read-only `plan` mode with machine-readable worker output and hard-disabled `implement` mode.
- ACP transport design prototype with transactional compact, rotate, and per-call fallback rules.
- Provider capability status with context-window preflight rejection.
- Canonical read-only profile tools: `read_file`, `grep`, `glob`, `ls`, `code_index`, and Reasonix-owned `web_fetch`.
- Offline CI checks and local README link validation.

### Security

- Workspace roots, task/output limits, timeout termination, path-free diagnostics, and no model/network dependency in the regression suite.

[0.1.0]: https://github.com/SgfKrc/reasonix-codex-bridge/releases/tag/v0.1.0
