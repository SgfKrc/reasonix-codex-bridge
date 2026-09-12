# Reasonix ↔ Codex MCP Bridge

Zero-dependency stdio MCP server for Codex. It exposes a narrow `reasonix_run` tool that starts the configured read-only Reasonix subagent and a `reasonix_status` diagnostic tool.

## Supported runtime

- Node.js 20 or newer.
- Reasonix 1.38.6 or newer, using the post-rewrite `reasonix subagent run` interface.
- Lower Reasonix versions are intentionally unsupported.

## Configure Codex

Add this to the Codex configuration that the local client loads:

```toml
[mcp_servers.reasonix_local]
command = "node"
args = ["C:\\path\\to\\reasonix-codex-bridge\\src\\server.mjs"]
startup_timeout_sec = 30

[mcp_servers.reasonix_local.env]
REASONIX_EXE = "C:\\path\\to\\reasonix-cli.exe"
REASONIX_ROOT = "C:\\path\\to\\workspace"
REASONIX_SUBAGENT = "deepseek-worker"
REASONIX_MODEL_REF = "example-inventory-name/deepseek-flash"
```

Restart Codex after changing MCP configuration. Run `npm run check` (or `node --check src/server.mjs`) before connecting a new machine.

Create the named profile once in the global Reasonix profile directory. The bridge passes the target workspace with `--dir`, so a project-only profile will not be found when the bridge is copied to another repository:

```powershell
reasonix subagent create deepseek-worker --scope global --model "example-inventory-name/deepseek-flash" --prompt-file .\prompts\deepseek-worker-prompt.md
reasonix subagent edit deepseek-worker --tools "read_file,grep,glob,ls,code_index"
# Add read-only: true to the profile frontmatter after the CLI edit.
```

## Environment variables

`REASONIX_EXE`, `REASONIX_ROOT`, `REASONIX_SUBAGENT`, and `REASONIX_MODEL_REF` are configurable. The model reference is hard-locked to `example-inventory-name/deepseek-flash`; changing it makes the server exit with code 2. `REASONIX_ADD_DIRS` may contain additional allowed roots separated by the platform path delimiter.

The bridge is deliberately stateless per call. It serializes calls, confines `cwd` to allowed roots, rejects `implement`, limits task/budget/output sizes, and terminates the process tree on timeout. This avoids accumulating one conversation beyond Reasonix's hard 128 MB history limit. A persistent ACP transport is a later extension; it must compact or rotate the session before 128 MB and never treat that limit as configurable.
