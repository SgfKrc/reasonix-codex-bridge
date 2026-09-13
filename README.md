# Reasonix ↔ Codex MCP Bridge

Zero-dependency stdio MCP server for Codex. It exposes `reasonix_run`, explicit `reasonix_resume`, `reasonix_cancel`, `reasonix_rollback`, and `reasonix_status` MCP tools. The worker remains read-only by default; controlled writes require an explicit policy.

Current release: `v0.1.0`. See [CHANGELOG.md](CHANGELOG.md) for the audited release contents.

## Supported runtime

- Node.js 20 or newer.
- Reasonix 1.38.6 or newer, using the post-rewrite `reasonix subagent run` interface.
- Lower Reasonix versions are intentionally unsupported. The bridge requires `1.38.6` or newer by default; `configure verify` reports a failure and the MCP server refuses to start when the installed CLI is older.
- The CLI path is resolved at startup and never hard-coded: `REASONIX_EXE` wins when set, otherwise the bridge probes `%LOCALAPPDATA%\Programs\Reasonix\reasonix-cli.exe`, the newest `%LOCALAPPDATA%\Programs\Reasonix\versions\v*\reasonix-cli.exe`, `/usr/local/bin|/usr/bin/reasonix-cli`, then `reasonix-cli(.exe)` on `PATH`. If nothing is found (or `REASONIX_EXE` points to a missing file) the server logs the reason and exits with code 2.

## Pick the subagent model

Every machine may use a different provider, so no model reference is hard-coded. `node src/configure.mjs` reads this machine's redacted inventory from `reasonix doctor --json`:

```bash
node src/configure.mjs list      # every <provider>/<model> ref this machine reports (key present, Reasonix default, current)
node src/configure.mjs list --refresh # bypass the doctor inventory cache and query the CLI
node src/configure.mjs use <ref> # write it to bridge.config.json (a preset name works too)
node src/configure.mjs show      # effective configuration and where each value comes from
node src/configure.mjs export    # print a redacted, path-free environment summary as JSON
node src/configure.mjs import summary.json # compare a summary; use '-' to read stdin, never writes config
node src/configure.mjs profile   # inspect the selected read profile and report drift
node src/configure.mjs profile --sync        # print the exact read-profile edit command (no write)
node src/configure.mjs profile --sync --write # execute edit, enforce read-only, then re-check
node src/configure.mjs profile --role write --create --write # create the separate write profile
node src/configure.mjs verify    # check CLI + model ref + read profile
node src/configure.mjs verify --role write # check the explicit write profile
```

`presets.example.json` ships three editable examples (OpenCode Go, Shizi gateway, DeepSeek official) and `node src/configure.mjs presets` lists them once you copy it to `presets.json`. Provider ids are account-specific — always take the refs from `configure list` on the machine you are setting up instead of copying someone else's value.

Doctor inventory responses are cached beside `bridge.config.json` as
`bridge.config.json.doctor-cache.json`. The cache stores only the redacted provider/model summary,
CLI path, CLI mtime, version, and fetch timestamp. It is valid for 10 minutes; a changed CLI file,
expired or malformed cache, or `--refresh` causes a live query. A failed live query is returned as an
error and never replaced with stale inventory.

`configure export` reports only platform, Node major, Reasonix version status, provider/model names,
the current model ref, and profile name/model/read-only/tools metadata. It omits CLI/config/profile
paths, keys, and endpoints. `configure import <file|->` validates that schema and prints only
field-level differences; it never changes `bridge.config.json`, Codex config, or profiles.

Resolution order for the model reference (first hit wins):

1. `REASONIX_MODEL_REF` from the environment (for example the Codex MCP block)
2. `modelRef` in `bridge.config.json`
3. `config.default_model` reported by `reasonix doctor --json` (auto fallback; `reasonix_status` shows it as the source)
4. nothing available → the bridge refuses to start with exit code 2 and points at `configure use`.

## Configure Codex

Generate the block instead of typing paths by hand:

```bash
node src/configure.mjs codex          # print the TOML block
node src/configure.mjs codex --write  # upsert it into the Codex config (timestamped backup first)
```

`codex --write` validates the required bridge and environment keys before writing, merges duplicate
`mcp_servers.reasonix_local*` sections, preserves unrelated TOML sections and the existing LF/CRLF
style, and replaces the file through a same-directory temporary. The timestamped backup remains the
rollback point if the destination cannot be replaced.

```toml
[mcp_servers.reasonix_local]
command = "node"
args = ["C:/path/to/reasonix-codex-bridge/src/server.mjs"]
startup_timeout_sec = 30

[mcp_servers.reasonix_local.env]
REASONIX_EXE = "C:/path/to/reasonix-cli.exe"   # optional; omit to use the probe order
REASONIX_ROOT = "C:/path/to/workspace"
REASONIX_SUBAGENT = "deepseek-worker"
REASONIX_MODEL_REF = "<the ref you selected with: node src/configure.mjs list>"
```

Restart Codex after changing MCP configuration. Run `npm run check` (or `node --check src/server.mjs src/config.mjs src/configure.mjs`) before connecting a new machine.

The bridge performs a cheap `reasonix --version` gate before it calls `doctor` or starts a worker. If a deliberate compatibility test needs to run against an older CLI, set `REASONIX_MIN_VERSION` to an explicit lower value; `verify` and the server log a warning so the relaxed gate is visible. An unparseable or unavailable version is reported as `unknown` and does not block startup, while the normal CLI/model checks still apply.

The offline regression suite has no model or network dependency:

```bash
npm test       # node --test: config, configure, MCP session and version stubs
npm run check  # syntax checks for all bridge modules
npm run check:links # local README links only; no network access
```

The repository CI repeats these three offline checks on Node 20; see the [CI workflow](.github/workflows/ci.yml).
The link check resolves only relative paths in this repository and skips external URLs, anchors, and mail links.

Create the named read profile once in the global Reasonix profile directory. The bridge passes the target workspace with `--dir`, so a project-only profile will not be found when the bridge is copied to another repository:

```powershell
reasonix subagent create deepseek-worker --scope global --model "<ref shown by: node src/configure.mjs list>" --prompt-file .\prompts\deepseek-worker-prompt.md
reasonix subagent edit deepseek-worker --tools "read_file,grep,glob,ls,code_index,git_log,git_diff"
# `node src/configure.mjs profile --sync --write` can enforce read-only: true and re-check the profile.
```

`configure profile` resolves profiles at `%APPDATA%/reasonix/skills/<name>/SKILL.md` on Windows (or `~/.config/reasonix/skills/<name>/SKILL.md` on POSIX). The default `read` role uses the configured `deepseek-worker` name, requires `read-only: true`, and is preview-only unless `--write` is explicit. `--role write` targets a separate `<read-profile>-write` profile (or `REASONIX_WRITE_SUBAGENT`/`writeSubagent`), uses `prompts/deepseek-worker-write-prompt.md`, and requires that no `read-only` field is present. Both roles re-read the profile after an explicit write and fail closed on model or tool drift. Set `REASONIX_SKILLS_DIR` to a temporary skills root for offline tests or isolated setup.

The canonical read-only profile tool set is `read_file, grep, glob, ls, code_index, git_log, git_diff`.
`git_log` and `git_diff` are inspection-only viewers; no write, commit, checkout, reset, network, or
shell tool is allowed. `configure verify` prints the installed `allowed-tools` list and fails when
it differs from this documented set.

The canonical write profile adds only `edit_file` and `write_file` to that read set. It has no
`read-only` field and still has no shell, network, commit, checkout, reset, or delete tool. Creating
the profile does not enable bridge writes: `allowWrite: true`, a non-empty `allowedPaths`, a clean
tree, and `mode=implement` are still required. Set `REASONIX_SUBAGENT` to the write profile only
for an explicitly authorized call. The operating workflow is: main agent gives a bounded task ->
write subagent edits -> bridge returns structured change evidence -> main agent reviews the diff and
tests, checks that out-of-scope paths are zero, then keeps or calls `reasonix_rollback`.

## Environment variables

`REASONIX_EXE`, `REASONIX_ROOT`, `REASONIX_SUBAGENT`, `REASONIX_SUBAGENT_ROLE`, `REASONIX_WRITE_SUBAGENT`, and `REASONIX_MODEL_REF` are configurable and always win over `bridge.config.json`. `REASONIX_SUBAGENT_ROLE` may explicitly be `read` or `write`; when omitted, a profile name ending in `-write` is treated as the write role. `REASONIX_EXE` is optional: set it to pin a specific `reasonix-cli` executable (a path that does not exist exits with code 2), or omit it to use the probe order above. Any `<provider>/<model>` ref this machine reports is accepted for `REASONIX_MODEL_REF`; an empty value, whitespace, or a ref without `/` exits with code 2. `REASONIX_ADD_DIRS` may contain additional allowed roots separated by the platform path delimiter. `BRIDGE_CONFIG`, `BRIDGE_PRESETS`, `CODEX_CONFIG`, and `CODEX_HOME` relocate the files the helper scripts read and write.

Resource limits can be lowered per machine in `bridge.config.json`. The bridge permits up to
256 raw Reasonix steps (128 tool-call rounds) and 1800 seconds per call; these are finite code
hard caps, not user-configurable limits:

```json
{"limits":{"MAX_STEPS_CAP":20,"TIMEOUT_SECONDS_CAP":300,"OUTPUT_CHAR_CAP":12000,"queueCap":2}}
```

Each value must be a positive integer. Invalid values fall back to the defaults with one startup
warning; values above the code hard caps are clamped with one warning. `reasonix_status.limits`
always reports the effective values used for calls. Defaults for the mode presets remain unchanged;
pass `tool_rounds` and `timeout_seconds` explicitly when a task needs the wider bounded budget.

Reasonix's `--max-steps` is a raw internal step budget, not a tool-call-round count. With the
current CLI, a normal assistant/tool exchange consumes two internal steps. Use `tool_rounds` on
`reasonix_run` when expressing a task-sized budget; the bridge converts it to `--max-steps` and
reports the corresponding `toolRoundsCap`. `max_steps` remains available for raw CLI-compatible
overrides. If Reasonix reports `paused after ... tool-call rounds (max_steps)`, the bridge records
`step_limit` and explains that the bridge timeout was not reached; this is distinct from a
`timeout` outcome.

The worker prompts also treat `read_file` continuation cursors as opaque values: they must be
returned byte-for-byte as received, never edited or reconstructed. If Reasonix reports an invalid
or malformed cursor, the bridge returns `cursor_error`, redacts the worker's cursor diagnostic, and
does not replay the task; the worker should re-read the file from an explicit path/range instead.

Recoverable worker failures (`step_limit`, `timeout`, `worker_exit`, and `cursor_error`) create a
durable checkpoint outside the workspace. The response includes a `checkpoint_id`; call
`reasonix_resume` explicitly to continue. A checkpoint stores the original task, mode, bounded
budget, Reasonix/config fingerprints, and a Git workspace snapshot, but never worker stdout/stderr.
Resume refuses a changed workspace or configuration and consumes the checkpoint before starting the
next worker, so failures are never retried implicitly. Checkpoints are one-shot; a failed resume
creates a new id. Set `BRIDGE_CHECKPOINT_DIR` (or `checkpointDir` in `bridge.config.json`) to choose
the storage directory; paths inside the workspace disable checkpointing to avoid dirtying Git.

`reasonix_status` also reports checkpoint persistence (`checkpoint.enabled` and ready count), the live
`queueDepth` (accepted calls not yet completed), numeric `inFlight` count, parallel/exclusive slot
counts, per-job state, and a redacted `lastRun` summary. Calls remain serialized by default. A caller
must pass `parallel=true` to `reasonix_run` to use a concurrent read-only inspect/review/plan slot;
implement, resume, and rollback jobs remain exclusive to protect the workspace and write policy.
`reasonix_cancel` accepts a visible `job_id`, terminates its worker tree, and reports the reclaimed
slot; cancellation never creates a checkpoint. A full queue error includes the current depth,
configured capacity, and a retry-after hint. Job and summary records never contain task text, worker
output, model references, or absolute paths.

The status also exposes the selected provider/model capabilities reported by `reasonix doctor`:
`contextWindow`, `vision`, and the provider's redacted `base_url_host`. Before spawning a worker,
the bridge estimates task tokens from UTF-8 bytes and rejects a task whose estimate exceeds the
reported context window, with the concrete estimate and limit in the error. Capability discovery
is read-only and does not write the doctor cache during bridge startup.

`reasonix_run` also accepts read-only `mode=plan`. In this mode the bridge returns worker stdout
unchanged so callers can consume a machine-readable change list, for example:

```json
{"schema":"qlh.reasonix.plan.v1","changes":[{"file":"src/server.mjs","location":"line 1","reason":"...","patch":"..."}]}
```

The plan is advisory only: the bridge does not parse or apply it. Use repository-relative file names
and omit file contents from plan entries.

### Controlled implement mode

`mode=implement` is disabled unless the per-machine `bridge.config.json` explicitly opts in. The
minimum policy is an exact boolean `allowWrite: true`, a non-empty `allowedPaths` array, and the
default `requireCleanTree: true`:

```json
{
  "modelRef": "<provider>/<model>",
  "allowWrite": true,
  "allowedPaths": ["src/example.mjs", "tests/"],
  "requireCleanTree": true
}
```

The caller must also pass `mode=implement`; inspect/review/plan are enforced as read-role calls and
reject a selected write profile. Conversely, implement requires an explicit write-role profile.
`allowedPaths` entries
are repository-relative exact files or directory prefixes, never absolute paths or `..` escapes.
Before a write call the bridge requires a verifiable Git workspace and no existing changes.
`requireCleanTree=false` is rejected as an unsafe policy; the clean-tree gate cannot be disabled.
After the worker exits it compares Git status with the pre-call snapshot. Any path outside
the whitelist, or any failed worker, causes the changes from that call to be rolled back. A successful write returns
only a `qlh.reasonix.changes.v1` change set with repository-relative paths, add/delete counts,
`git diff --stat`, SHA-256 hashes, `hash_status` (`readable`, `missing`, or `unreadable`), and a one-shot `rollback_id`; worker stdout and file contents are
never returned. Call `reasonix_rollback` explicitly with that id to restore the call's changes.
Rollback is serialized with implement calls, rechecks the target Git/hash state after restore, and
refuses changed, missing, or unreadable targets. Rollback records live only in the current bridge
process. The dedicated write profile is separate from the default read profile; profile creation and
bridge write authorization remain independent gates.

When `REASONIX_EXE` points to a Windows `.cmd` or `.bat` shim, the bridge invokes `cmd.exe` explicitly
with `shell:false`. Arguments containing cmd metacharacters are rejected before process creation;
this keeps task text out of shell interpretation while preserving normal shim startup.

Set `BRIDGE_LOG` to opt into one JSON object per `reasonix_run` call. Each record contains only
the timestamp, mode, workspace-root label, step/timeout limits, outcome, exit code, elapsed time,
stdout byte count, and truncation flag. Task text, worker stdout/stderr, model refs, and absolute
paths are never written. With `BRIDGE_LOG` unset, the bridge performs no log writes.

The bridge is deliberately stateless per call. It confines `cwd` to allowed roots, rejects
`implement` unless the write policy is enabled, limits task/budget/output sizes, terminates the
process tree on timeout/cancel, and keeps write operations exclusive. Output beyond
`OUTPUT_CHAR_CAP` is bounded in memory and returned as a successful result with
`truncated=true`; output overflow alone does not kill the worker. Explicit read-only parallel
jobs are independently spawned and reclaimed when they finish. This avoids accumulating one
conversation beyond Reasonix's hard 128 MB history limit.

`src/acp-client.mjs` now provides the ACP-01 newline JSON-RPC client: it performs capability-gated
initialize/session creation, load/resume, prompt update aggregation, cancellation and clean process
shutdown. It is transport-only and does not persist session ids or decide write policy. The server
still defaults to stateless per-call execution and does not import the client until the later
coexistence/switching ticket is accepted.

`src/acp-session.mjs` provides the ACP-02 opt-in session budget coordinator. It uses a bounded
deterministic summarizer, connects the prototype's append/compact/rotate/per-call decisions to
replacement sessions, records redacted decision telemetry, and leaves the old session untouched
when replacement fails. Persistent ACP remains opt-in and the server remains stateless; see
`ACP-TRANSPORT-DESIGN.md` for the lifecycle and failure contract. The fixed 128 MiB Reasonix
history cap and 75% trigger are not configurable.
