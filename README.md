# Reasonix ↔ Codex MCP 桥

> **Language**: [English](README.en.md) · [简体中文](README.md)

面向 Codex 的零依赖 stdio MCP 服务，暴露 `reasonix_run`、显式 `reasonix_resume`、`reasonix_cancel`、`reasonix_events`、`reasonix_rollback`、`reasonix_exec` 与 `reasonix_status` 七个 MCP 工具。worker 默认保持只读；受控写入需要显式策略。

当前版本：`v0.1.0`，经审计的发布内容见 [CHANGELOG.md](CHANGELOG.md)。

## 运行环境要求

- Node.js 20 或更高。
- Reasonix 1.38.6 或更高（使用重写后的 `reasonix subagent run` 接口）。
- 更低版本有意不支持：默认要求 `1.38.6+`；当安装的 CLI 更旧时，`configure verify` 报失败、MCP server 拒绝启动。
- CLI 路径在启动时解析、从不硬编码：设置了 `REASONIX_EXE` 就用它，否则依次探测 `REASONIX_HOME`、平台安装根 `%LOCALAPPDATA%\Programs\Reasonix`（两者布局相同：先看根下的 `reasonix-cli.exe`，再看其 `versions/v*` 目录、**新版本在前**，预发布目录如 `v1.39.0-rc.1` 同样参与），然后是 `/usr/local/bin|/usr/bin/reasonix-cli`，最后是 `PATH` 上的 `reasonix-cli(.exe)`（Windows 上同时接受 `reasonix.exe` / `reasonix-launcher.exe`）。全部落空（或 `REASONIX_EXE` 指向不存在的文件）时记录原因并以退出码 2 结束。

## 下游消费者

**目前没有 vendor 消费者。** 本仓库的 `src/`、`test/`、`scripts/check-readme-links.mjs`、
`scripts/acp-acceptance.mjs`、`prompts/` 与 `LICENSE` 曾由
[`dsh-codex-bridge`](https://github.com/SgfKrc/dsh-codex-bridge) 原样 vendor（来源 commit 与逐文件
sha256 记在那个仓库的 `VENDOR.json`，用 `scripts/sync-vendor.mjs` 同步）。

⚠️ **该关系已终止**：自 dsh 侧 **v0.2.0**（commit `16ef1ae feat!: 仓库改换用途 —— 由 Reasonix vendor
副本改为 DSH 子 agent 桥接器`）起，那个仓库改为 **DSH 子 agent 桥接器**本身，不再 vendor 任何 Reasonix
代码，`VENDOR.json` 与旧 vendor 内容均已移除。因此：

- 本仓库**仍是 `src/` 与 `test/` 的历史真源**，但**不再有下游需要同步**；
- 改动 `src/`（尤其 `server.mjs` 的导出面、`config.mjs` 的配置解析）或 `test/` 时，**不需要**再提醒
  任何下游重新 vendor；
- 若将来重新建立 vendor 关系，请在两个仓库里**同时**更新本节与 `VENDOR.json`。

## 选择子智能体模型

每台机器可能使用不同的 provider，因此不硬编码任何模型引用。`node src/configure.mjs` 从 `reasonix doctor --json` 读取本机脱敏清单：

```bash
node src/configure.mjs list      # 本机报告的每个 <provider>/<model>（是否已配 key、是否 Reasonix 默认、是否当前）
node src/configure.mjs list --refresh # 绕过 doctor 清单缓存，直接查询 CLI
node src/configure.mjs use <ref> # 写入 bridge.config.json（也可以填预设名）
node src/configure.mjs show      # 生效配置，以及每个值的来源
node src/configure.mjs export    # 打印脱敏、无路径的环境摘要（JSON）
node src/configure.mjs import summary.json # 对照摘要文件；用 '-' 读 stdin，永不写配置
node src/configure.mjs profile   # 检查所选读角色 profile 并报告漂移
node src/configure.mjs profile --sync        # 打印读 profile 的精确编辑命令（不写入）
node src/configure.mjs profile --sync --write # 执行编辑、强制 read-only，然后复检
node src/configure.mjs profile --role write --create --write # 创建独立的写 profile
node src/configure.mjs verify    # 校验 CLI + 模型 ref + 读 profile
node src/configure.mjs verify --role write # 校验显式写 profile
```

`presets.example.json` 附带三个可编辑示例（OpenCode Go、Shizi 网关、DeepSeek 官方）；把它复制成 `presets.json` 后，`node src/configure.mjs presets` 会列出它们。provider id 与账号绑定——请一律用目标机器上 `configure list` 给出的 ref，不要照抄别人的值。

doctor 清单响应会缓存到 `bridge.config.json` 旁的 `bridge.config.json.doctor-cache.json`。缓存只保存脱敏的 provider/model 摘要、CLI 路径、CLI mtime、版本与抓取时间；有效期 10 分钟。CLI 文件变更、缓存过期或损坏、或显式 `--refresh` 都会触发实时查询；实时查询失败时直接报错，绝不回退到过期清单。

`configure export` 只报告平台、Node 主版本、Reasonix 版本状态、provider/model 名称、当前模型 ref，以及 profile 的名称/模型/read-only/工具元数据；它省略 CLI/配置/profile 路径、密钥与端点。`configure import <file|->` 校验该 schema 并只打印字段级差异，永不改动 `bridge.config.json`、Codex 配置或 profile。

模型引用的解析顺序（首个命中生效）：

1. 环境变量 `REASONIX_MODEL_REF`（例如 Codex MCP 块里设置的值）
2. `bridge.config.json` 里的 `modelRef`
3. `reasonix doctor --json` 报告的 `config.default_model`（自动回退；`reasonix_status` 会标注该来源）
4. 都没有 → 桥接器拒绝启动，退出码 2，并提示运行 `configure use`。

## 配置 Codex

不必手写路径，直接生成配置块：

```bash
node src/configure.mjs codex          # 打印 TOML 块
node src/configure.mjs codex --write  # 合并进 Codex 配置（先做时间戳备份）
```

`codex --write` 在写入前校验必需的 bridge 与环境键，合并重复的 `mcp_servers.reasonix_local*` 段，保留无关 TOML 段与既有 LF/CRLF 风格，并通过同目录临时文件原子替换目标文件；目标无法替换时，时间戳备份就是回滚点。

```toml
[mcp_servers.reasonix_local]
command = "node"
args = ["C:/path/to/reasonix-codex-bridge/src/server.mjs"]
startup_timeout_sec = 30

[mcp_servers.reasonix_local.env]
REASONIX_EXE = "C:/path/to/reasonix-cli.exe"   # 可选；省略即使用探测顺序
REASONIX_ROOT = "C:/path/to/workspace"
REASONIX_SUBAGENT = "deepseek-worker"
REASONIX_MODEL_REF = "<用 node src/configure.mjs list 选出的 ref>"
```

改动 MCP 配置后需重启 Codex。接入新机器前先跑 `npm run check`（或 `node --check src/server.mjs src/config.mjs src/configure.mjs`）。

桥接器在调用 `doctor` 或启动 worker 之前会做一次轻量的 `reasonix --version` 门。若确有兼容性测试需要针对旧版 CLI，可把 `REASONIX_MIN_VERSION` 显式调低；`verify` 与 server 日志都会给出警告，使放宽的门可见。版本无法解析或不可用时报告为 `unknown` 且不阻断启动，常规的 CLI/模型检查仍然生效。

离线回归套件不依赖模型与网络：

```bash
npm test       # node --test：配置、configure、MCP 会话与版本桩
npm run check  # 所有 bridge 模块的语法检查
npm run check:links # 仅检查本仓库 README 的本地链接；不访问网络
```

仓库 CI 在 Node 20 上重复这三项离线检查，见 [CI workflow](.github/workflows/ci.yml)。链接检查只解析本仓库内的相对路径，跳过外部 URL、锚点与邮件链接。

读角色 profile 需要**一次**在 Reasonix 全局 profile 目录中创建。桥接器用 `--dir` 传入目标工作区，因此只存在于项目内的 profile 在桥接器被复制到别的仓库时找不到：

```powershell
reasonix subagent create deepseek-worker --scope global --model "<node src/configure.mjs list 显示的 ref>" --prompt-file .\prompts\deepseek-worker-prompt.md
reasonix subagent edit deepseek-worker --tools "read_file,grep,glob,ls,code_index,web_fetch"
# 可用 `node src/configure.mjs profile --sync --write` 强制 read-only: true 并复检 profile。
```

`configure profile` 在 Windows 上按 `%APPDATA%/reasonix/skills/<name>/SKILL.md` 解析 profile（POSIX 上是 `~/.config/reasonix/skills/<name>/SKILL.md`）。默认的 `read` 角色使用配置的 `deepseek-worker` 名称，要求 `read-only: true`，且在未显式 `--write` 时只做预览。`--role write` 指向独立的 `<读 profile 名>-write`（或 `REASONIX_WRITE_SUBAGENT`/`writeSubagent`），使用 `prompts/deepseek-worker-write-prompt.md`，并要求不得出现 `read-only` 字段。两种角色在显式写入后都会重新读取 profile，并在模型或工具漂移时 fail-closed。离线测试或隔离部署可用 `REASONIX_SKILLS_DIR` 指向临时 skills 根。

规范的只读 profile 工具集是 `read_file, grep, glob, ls, code_index, web_fetch`。其中 `web_fetch` 是 Reasonix 原生的可选 URL 抓取能力，按 Reasonix 自己的策略执行；bridge 不提供任意 URL MCP 工具，也不自建网络栈。Reasonix v1.38.7 不识别 `git_log` 与 `git_diff` 这两个 profile 身份；Git 历史和差异由主 agent 通过 host/MCP 或受控命令执行通道审查。不允许任何写、commit、checkout、reset 或 shell 工具。`configure verify` 会同时检查 profile 漂移和 Reasonix doctor 报告的未知工具身份。

规范的写 profile 只在上述只读集合上增加 `edit_file` 与 `write_file`。它没有 `read-only` 字段，同样没有 shell、任意 socket/代理、commit、checkout、reset 或删除类工具；需要 URL 抓取时仍只能使用 Reasonix 原生 `web_fetch`。**创建 profile 并不等于开启桥接写入**：仍然需要 `allowWrite: true`、非空 `allowedPaths`、干净工作区，以及调用方显式传 `mode=implement`。只有在明确授权的那次调用中才把 `REASONIX_SUBAGENT` 指向写 profile。工作流是：主 agent 下达有界任务 → 写子智能体执行编辑 → 桥接器返回结构化变更证据 → 主 agent 审查 diff 并跑测试、确认白名单外路径为零，然后保留改动或调用 `reasonix_rollback`。

## 环境变量

`REASONIX_EXE`、`REASONIX_ROOT`、`REASONIX_SUBAGENT`、`REASONIX_SUBAGENT_ROLE`、`REASONIX_WRITE_SUBAGENT` 与 `REASONIX_MODEL_REF` 均可配置，且始终优先于 `bridge.config.json`。`REASONIX_SUBAGENT_ROLE` 可显式取 `read` 或 `write`；省略时，名字以 `-write` 结尾的 profile 被当作写角色。`REASONIX_EXE` 可选：设置它可固定某个 `reasonix-cli` 可执行文件（路径不存在则退出码 2），省略则按上面的探测顺序。本机报告的任意 `<provider>/<model>` 都可作为 `REASONIX_MODEL_REF`；空值、含空白或不含 `/` 的 ref 以退出码 2 结束。`REASONIX_ADD_DIRS` 可包含额外的允许根，用平台路径分隔符隔开。`BRIDGE_CONFIG`、`BRIDGE_PRESETS`、`CODEX_CONFIG` 与 `CODEX_HOME` 用于改位辅助脚本读写的位置。

资源限额可按机器在 `bridge.config.json` 中调低。桥接器允许每次调用最多 256 个 Reasonix 原始步（128 个工具调用轮）与 1800 秒；这些是**代码硬上限**，不是用户可配的限额：

```json
{"limits":{"MAX_STEPS_CAP":20,"TIMEOUT_SECONDS_CAP":300,"OUTPUT_CHAR_CAP":12000,"queueCap":2}}
```

每个值必须是正整数。非法值回退默认并给出一次启动警告；超过代码硬上限的值被夹紧并给出一次警告。`reasonix_status.limits` 始终报告调用实际生效的值。各模式的默认预设值保持不变；任务确实需要更宽的预算时，显式传 `tool_rounds` 与 `timeout_seconds`。

Reasonix 的 `--max-steps` 是内部原始步预算，不是工具调用轮数。在当前 CLI 下，一次常规的助手/工具往返消耗两个内部步。用 `reasonix_run` 的 `tool_rounds` 表达"任务级预算"更直观：桥接器把它换算成 `--max-steps`，并在状态里报告对应的 `toolRoundsCap`；`max_steps` 仍保留给需要与 CLI 原始口径对齐的场景。若 Reasonix 报告 `paused after ... tool-call rounds (max_steps)`，桥接器记为 `step_limit` 并说明**桥接超时并未触发**——这与 `timeout` 结果是两回事。

worker 提示词同样把 `read_file` 的续读 cursor 当作不透明值：必须按收到的原样逐字节回传，不得编辑或重建。若 Reasonix 报告 cursor 无效或畸形，桥接器返回 `cursor_error`、对 worker 的 cursor 诊断做脱敏，且**不重放**任务；worker 应改用显式路径/区间重新读取文件。

可恢复的 worker 失败（`step_limit`、`timeout`、`worker_exit`、`cursor_error`）会在工作区之外创建持久 checkpoint。响应里带 `checkpoint_id`，需要续跑时显式调用 `reasonix_resume`。checkpoint 保存原始任务、模式、有界预算、Reasonix/配置指纹与 Git 工作区快照，但**绝不保存** worker 的 stdout/stderr。工作区或配置发生变化时 resume 会被拒绝；checkpoint 在启动下一个 worker 前即被消费，因此失败不会被隐式重试。checkpoint 是一次性的，失败的 resume 会生成新 id。用 `BRIDGE_CHECKPOINT_DIR`（或 `bridge.config.json` 的 `checkpointDir`）选择存储目录；落在工作区内的路径会禁用 checkpoint，以免弄脏 Git。

`reasonix_status` 还会报告 checkpoint 持久化（`checkpoint.enabled` 与就绪数）、实时 `queueDepth`（已接受未完成的调用数）、数值型 `inFlight`、并行/独占槽位计数、单任务状态，以及脱敏的 `lastRun` 摘要。调用默认串行；只有显式给 `reasonix_run` 传 `parallel=true` 才会占用并发的只读 inspect/review/plan 槽位；implement、resume 与 rollback 仍为独占，以保护工作区与写策略。`reasonix_cancel` 接受可见的 `job_id`，终止其 worker 进程树并报告回收的槽位；取消**不会**创建 checkpoint。队列满的错误会带当前深度、配置容量与建议重试时间。任务与摘要记录绝不包含任务正文、worker 输出、模型引用或绝对路径。

状态里还会暴露 `reasonix doctor` 报告的选中 provider/model 能力：`contextWindow`、`vision` 与 provider 的脱敏 `base_url_host`。启动 worker 之前，桥接器按 UTF-8 字节估算任务 token 量，超过报告的上下文窗口即拒绝，并在错误里给出具体估算与上限。能力探测是只读的，桥接器启动时不会写 doctor 缓存。

`reasonix_status.providerSearch` 是 provider 原生 `web_search` 的 fail-closed 能力摘要。当前 provider 未显式声明搜索能力时返回 `status=unavailable` 与 `reason=provider_capability_not_advertised`；bridge 不自建搜索后端，也不把模型文本推断当作搜索结果。若将来 provider 明确接通，`reasonix_run` 仍只原样透传 Reasonix 返回的摘要/来源/截断状态。

`reasonix_events` 按 `job_id` 轮询一个有界、按序的生命周期事件流。可选的 `after_seq` 与 `limit` 支持断点式增量读取；响应 schema 为 `qlh.reasonix.events.v1`，事件只包含 job id、阶段、状态、终态结果和有界计数，不返回任务正文、worker 输出、模型引用或路径。事件流覆盖排队、启动、取消请求和终态，进程内 job 记录被清理后对应事件也会过期。

### 显式阶段编排（`plan -> implement -> exec -> review`）

LOOP-01 是主 agent 的显式编排模板，不是 bridge 内的自动流水线。调用方按阶段分别调用现有工具，并在每次 `reasonix_run` 传 `stage=plan|implement|review`，在 `reasonix_exec` 传 `stage=exec`；不传时 bridge 按 mode 推导。`reasonix_status.workflow`、`modeDefaults`、`jobs[*].stage`、`lastRun.stage` 和 `BRIDGE_LOG` 会记录阶段、默认预算、job、checkpoint 与结果摘要。阶段不会自动推进、重试或扩大权限：`implement` 仍要求写 profile/白名单/clean tree，`exec` 仍要求命名命令策略与 clean tree，失败后由调用方显式取消、续跑、审查或回滚。

`reasonix_run` 还接受只读的 `mode=plan`。该模式下桥接器**原样**返回 worker 的 stdout，便于调用方消费机器可读的改动清单，例如：

```json
{"schema":"qlh.reasonix.plan.v1","changes":[{"file":"src/server.mjs","location":"line 1","reason":"...","patch":"..."}]}
```

该清单仅供参考：桥接器不解析也不应用。请使用仓库相对路径，并在清单条目不包含文件内容。

### 受控 implement 模式

除非机器的 `bridge.config.json` 显式选择加入，`mode=implement` 处于关闭状态。最小策略是布尔值恰为 `allowWrite: true`、非空的 `allowedPaths` 数组，以及默认的 `requireCleanTree: true`：

```json
{
  "modelRef": "<provider>/<model>",
  "allowWrite": true,
  "allowedPaths": ["src/example.mjs", "tests/"],
  "requireCleanTree": true
}
```

调用方还必须显式传 `mode=implement`；inspect/review/plan 被强制为读角色调用，选中写 profile 会被拒绝。反过来，implement 要求显式写角色 profile。`allowedPaths` 条目是仓库相对路径的**精确文件或目录前缀**，绝不接受绝对路径或 `..` 逃逸。写入调用前，桥接器要求可验证的 Git 工作区且没有既存改动；`requireCleanTree=false` 会被判定为不安全策略而拒绝——clean-tree 门不可关闭。worker 退出后，桥接器把 Git 状态与调用前快照比对：白名单之外的任何路径、或任何失败的 worker，都会把该次调用的改动全部回滚。成功的写入只返回 `qlh.reasonix.changes.v1` 变更集，包含仓库相对路径、增删计数、`git diff --stat`、SHA-256 哈希、`hash_status`（`readable` / `missing` / `unreadable`）与一次性 `rollback_id`；**worker stdout 与文件内容永不返回**。用该 id 显式调用 `reasonix_rollback` 还原这次改动。回滚与 implement 调用同样被串行化，还原后会复核 Git/哈希状态，并拒绝目标已变化、缺失或不可读的情况。回滚记录只存在于当前桥接进程内。专用写 profile 与默认读 profile 相互独立：**创建 profile** 与 **桥接写授权** 是两个各自独立的门。

### 受控命令执行（`reasonix_exec`）

`reasonix_exec` 是第一阶段的写后验证通道，默认关闭。启用时必须在 `bridge.config.json` 中声明命名命令、参数前缀、工作区相对路径、超时和输出上限：

```json
{
  "execPolicy": {
    "enabled": true,
    "allowedPaths": ["tools/reasonix-codex-bridge"],
    "commands": [
      { "name": "bridge-test", "executable": "node", "argsPrefix": ["--test"], "maxArgs": 8 }
    ],
    "requireCleanTree": true,
    "timeoutSeconds": 300,
    "outputCharCap": 12000
  }
}
```

调用方只能提交已声明的 `command` 名称和 `args` 数组，不能提交可执行文件、shell 字符串、环境变量或网络目标。桥接器以 `shell:false` 启动进程，要求 Git 工作区可验证且干净，执行后报告退出码、截断标记和变更路径；发现工作区变化时结果为 `workspace_modified`，不会自动替用户回滚。命令配置和输出均不包含在 worker 会话中，适合主 agent 在写入后显式运行测试/构建并复核结果。状态中的 `execPolicy` 只展示命令名、参数前缀和有界限制，不泄露可执行路径。

当 `REASONIX_EXE` 指向 Windows 的 `.cmd` 或 `.bat` shim 时，桥接器以 `shell:false` 显式调用 `cmd.exe`。含 cmd 元字符的参数在创建进程前即被拒绝，从而在保持 shim 正常启动的同时，把任务文本挡在 shell 解释之外。

设置 `BRIDGE_LOG` 可为每次 `reasonix_run` 输出一行 JSON。每条记录只含时间戳、模式、工作区根标签、步数/超时限额、结果、退出码、耗时、stdout 字节数与截断标记；任务正文、worker stdout/stderr、模型引用与绝对路径永不写入。若 CLI 透传结构化 usage，记录中的 `usage` 仅包含 prompt/completion/cache hit/cache miss token 数；未透传时明确标记 `status=unavailable` 和原因（如 `cli_usage_not_forwarded`），不会猜测命中量。未设置 `BRIDGE_LOG` 时桥接器不写任何日志。

桥接器有意保持**每次调用无状态**：把 `cwd` 限制在允许根内；写策略未启用时拒绝 `implement`；限制任务/预算/输出规模；超时或取消时终止进程树；写操作保持独占。超出 `OUTPUT_CHAR_CAP` 的输出在内存中有界，并作为**成功结果**返回且 `truncated=true`——输出超限本身不会杀死 worker。显式的只读并行任务各自独立启动并在完成后回收。这一切是为了避免把单一对话累积超过 Reasonix 的 128 MB 历史硬上限。

### 可选的 ACP 持久会话（ACP-01 … ACP-06）

桥接器默认每次调用无状态；持久 ACP 是逐层 opt-in 的能力，默认传输仍是 `per-call`。各层现状：

| 模块 | 职责 | 接线状态 |
|---|---|---|
| `src/acp-client.mjs` | 换行 JSON-RPC 客户端：能力门控的 initialize/session 创建、load/resume、prompt 更新聚合、取消与干净关闭；只管传输，不持久化 session id、不决定写策略 | 未由 server 生产加载 |
| `src/acp-session.mjs` | 会话预算协调器：有界确定性摘要器，把 append/compact/rotate/per-call 决策接到替换会话并记录脱敏遥测；替换失败时保持旧会话原样 | opt-in |
| `src/acp-registry.mjs` | 会话注册表：只持久化会话元数据、按会话串行 prompt、把崩溃传输标为 orphaned、支持能力门控的 resume/load 与删除、显式关闭时关掉活跃客户端 | 未由 server 生产接线 |
| `src/acp-security.mjs` | 安全门：把持久调用绑定到不透明的调用方/任务作用域，会话 cwd 限制在配置的工作区根内，implement 预检复用 fail-closed 写白名单，内容进入续接历史前脱敏凭据类信息 | 仅在显式 `transport: "acp"` 时启用 |
| `src/acp-transport.mjs` | 切换器：`transport: "acp"` 加不透明 `session_id` 才复用只读 ACP 会话；缺 session ID、implement 与显式并行任务仍走 per-call；启动/协议/超时失败降级 per-call，状态只报有界计数 | 默认 `per-call` |
| `scripts/acp-acceptance.mjs` | 无模型离线验收：在 `build/bridge-test/` 内启动并强杀 registry 子进程，验证 orphan/resume、metadata-only 持久化、compact/rotate、并发串行、取消、子进程清理与工件删除 | 离线回归 `92 passed / 0 failed` |

`npm run acceptance:acp:real` 只探测真实 Reasonix 控制面、不发送模型 prompt；provider 未持久化空会话时输出结构化 `status: "blocked"` 并以退出码 2 返回，**不能**当作跨进程恢复通过。生命周期与失败契约见 `ACP-TRANSPORT-DESIGN.md`；128 MiB 历史硬上限与 75% 触发比不可配置。

