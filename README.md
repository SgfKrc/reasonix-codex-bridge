# Reasonix ↔ Codex MCP Bridge

Zero-dependency stdio MCP server for Codex. It exposes a narrow `reasonix_run` tool that starts the configured read-only Reasonix subagent and a `reasonix_status` diagnostic tool.

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
node src/configure.mjs profile   # inspect the selected profile and report drift
node src/configure.mjs profile --sync        # print the exact edit command (no write)
node src/configure.mjs profile --sync --write # execute edit, enforce read-only, then re-check
node src/configure.mjs verify    # check CLI + model ref + subagent profile
```

`presets.example.json` ships three editable examples (OpenCode Go, Shizi gateway, DeepSeek official) and `node src/configure.mjs presets` lists them once you copy it to `presets.json`. Provider ids are account-specific — always take the refs from `configure list` on the machine you are setting up instead of copying someone else's value.

Doctor inventory responses are cached beside `bridge.config.json` as
`bridge.config.json.doctor-cache.json`. The cache stores only the redacted provider/model summary,
CLI path, CLI mtime, version, and fetch timestamp. It is valid for 10 minutes; a changed CLI file,
expired or malformed cache, or `--refresh` causes a live query. A failed live query is returned as an
error and never replaced with stale inventory.

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
```

Create the named profile once in the global Reasonix profile directory. The bridge passes the target workspace with `--dir`, so a project-only profile will not be found when the bridge is copied to another repository:

```powershell
reasonix subagent create deepseek-worker --scope global --model "<ref shown by: node src/configure.mjs list>" --prompt-file .\prompts\deepseek-worker-prompt.md
reasonix subagent edit deepseek-worker --tools "read_file,grep,glob,ls,code_index"
# `node src/configure.mjs profile --sync --write` can enforce read-only: true and re-check the profile.
```

`configure profile` resolves the profile at `%APPDATA%/reasonix/skills/<name>/SKILL.md` on Windows (or `~/.config/reasonix/skills/<name>/SKILL.md` on POSIX). It compares the frontmatter `model` with the bridge model reference and requires `read-only: true`. The command is preview-only unless `--write` is explicit; after a write it re-reads the file and adds the read-only guard if the Reasonix CLI did not emit it. Set `REASONIX_SKILLS_DIR` to a temporary skills root for offline tests or isolated setup.

## Environment variables

`REASONIX_EXE`, `REASONIX_ROOT`, `REASONIX_SUBAGENT`, and `REASONIX_MODEL_REF` are configurable and always win over `bridge.config.json`. `REASONIX_EXE` is optional: set it to pin a specific `reasonix-cli` executable (a path that does not exist exits with code 2), or omit it to use the probe order above. Any `<provider>/<model>` ref this machine reports is accepted for `REASONIX_MODEL_REF`; an empty value, whitespace, or a ref without `/` exits with code 2. `REASONIX_ADD_DIRS` may contain additional allowed roots separated by the platform path delimiter. `BRIDGE_CONFIG`, `BRIDGE_PRESETS`, `CODEX_CONFIG`, and `CODEX_HOME` relocate the files the helper scripts read and write.

The bridge is deliberately stateless per call. It serializes calls, confines `cwd` to allowed roots, rejects `implement`, limits task/budget/output sizes, and terminates the process tree on timeout. This avoids accumulating one conversation beyond Reasonix's hard 128 MB history limit. A persistent ACP transport is a later extension; it must compact or rotate the session before 128 MB and never treat that limit as configurable.
