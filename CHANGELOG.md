# Changelog

All notable changes to this project are documented here.

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
