# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- ACP-01 newline-delimited JSON-RPC client with capability-gated session lifecycle, prompt update aggregation, cancellation, and process cleanup; it is not enabled by the stateless server yet.
- ACP-02 opt-in `AcpSessionCoordinator` with bounded deterministic summaries, transactional replacement sessions for compact/rotate, redacted decision telemetry, and explicit stateless fallback; it is not enabled by the stateless server yet.
- ACP client `session/delete` support with capability gating and local session-set cleanup.
- ACP-03 opt-in `AcpSessionRegistry` with metadata-only persistence, orphan detection, capability-gated resume/load/delete, per-session prompt serialization, and explicit shutdown cleanup; it is not enabled by the stateless server yet.
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

## [0.1.0] - 2026-09-12

### Added

- Read-only stdio MCP bridge for `reasonix_run` and `reasonix_status`.
- Offline configuration, profile drift verification, redacted doctor cache, limits, queue telemetry, and optional call logging.
- Read-only `plan` mode with machine-readable worker output and hard-disabled `implement` mode.
- ACP transport design prototype with transactional compact, rotate, and per-call fallback rules.
- Provider capability status with context-window preflight rejection.
- Canonical read-only profile tools: `read_file`, `grep`, `glob`, `ls`, `code_index`, `git_log`, and `git_diff`.
- Offline CI checks and local README link validation.

### Security

- Workspace roots, task/output limits, timeout termination, path-free diagnostics, and no model/network dependency in the regression suite.

[0.1.0]: https://github.com/SgfKrc/reasonix-codex-bridge/releases/tag/v0.1.0
