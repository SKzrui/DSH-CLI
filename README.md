# DSH-CLI（dcli）— DeepSeek agent 命令行工具

> **DSH-CLI** 是仓库名（GitHub: [SKzrui/DSH-CLI](https://github.com/SKzrui/DSH-CLI)），
> 命令行工具名是 **`dcli`** —— 两者不冲突：仓库名决定网址，`dcli` 决定你敲的命令。

**dcli** 是一个简单的命令行工具：在终端里和 DeepSeek agent 对话，一条命令启动，
无需启动服务、无需端口、聊完即走。支持流式回复、工具调用、会话恢复、
API key / 模型配置。

It is a thin launcher around the Harness's own profile system: it maintains a
`cli` profile (bundles `dsh-base` + `dsh-headless`) under `$DSH_HOME/profiles`
and injects a small interactive runner plugin (`runner/runner.js`) that drives
one Agent across many turns, so conversation state, tool results, and the
model's request prefix stay warm between messages.

## Features

- **Interactive REPL** — one live agent per process; streaming replies, real
  multi-turn continuity (tool state and the model's KV cache stay warm).
- **Streaming output with a live view of what the agent is doing** — thinking
  (dim), tool calls (`⚙ write …`), tool results (`✔`), turn status.
- **Markdown beautification** — tables render as aligned bordered grids
  (CJK-aware), `**bold**` / `*italic*` / `` `code` `` / `~~strike~~` /
  `[links](url)` get ANSI styling, headings are bold, bullets and task lists
  get pretty markers, blockquotes are dimmed, code fences pass through
  verbatim. Disable with `DCLI_FORMAT=0`; force on when piped with
  `DCLI_FORMAT=1`.
- **Blue ASCII whale banner** with an animated water spout on TTYs.
- **Per-directory session resume** — `dcli -r` / `-c` / `--resume <id>` reopen
  the last conversation in the current directory with full context; `dcli
--list` shows recent sessions; a fresh `dcli` offers to resume.
- **One-shot scripting** — `dcli "task"` answers and exits (exit code reflects
  the turn outcome); `dcli -c "task"` continues the latest session.
- **Interactive permissions** — tool calls that need approval ask
  `Allow <tool>? [y/N]` right in the terminal.
- **Interrupt handling** — Ctrl+C cancels a live turn, twice force-quits;
  Ctrl+C/D at the prompt exits cleanly; piped EOF exits cleanly.
- **Full harness toolset** — file read/write/edit/search, PowerShell, bash,
  subagents, skills, web search, goals, plan mode, … exactly like the web GUI.
- **No extra dependencies** — only Node built-ins + the existing
  `@deepseek-ai/dsh` install; zero npm packages to fetch.

## Requirements

- Node.js >= 20
- The DeepSeek API key (via `dcli config set-api-key <key>`, or
  `DEEPSEEK_API_KEY` env, or `$DSH_HOME/.credentials.yaml`).
- `@deepseek-ai/dsh` — **auto-installed** as a dependency of dcli; it can also
  be installed already (global or in the current directory's `node_modules`)
  and dcli will find it.

## Install

```powershell
# 方式 1：GitHub 拉取（获取源码 / 最新版）
git clone https://github.com/SKzrui/DSH-CLI.git
cd DSH-CLI
npm install        # 安装依赖（@deepseek-ai/dsh 自动装）
npm link           # 把 `dcli` 命令放到 PATH

# 方式 2：直接装发布包（任何机器，一条命令装好 dcli + dsh 运行时）
npm install -g dcli-0.1.1.tgz

# 配置 API key 并启动
dcli config set-api-key sk-...
dcli
```

No other setup is needed: the launcher self-heals the profile on every run
(copies the runner, writes missing manifest/patch files). Machines that
already have dsh (global or local) just work too — the launcher searches the
global prefix, `~/node_modules`, the current directory's `node_modules`, and
every ancestor, in that order.

## Usage

```powershell
dcli                          # interactive session (offers to resume the last
                              # conversation in this directory)
dcli -r, --resume             # resume the most recent session in this directory
dcli -r <id>, --resume <id>   # resume a specific session
dcli -c, --continue           # continue the most recent session, no prompting
dcli --list                   # list recent sessions in this directory
dcli "fix the failing test"   # one-shot: answer and exit (scriptable)
dcli -c "continue the work"   # one-shot: run the task in the latest session
```

**Configuration** — `dcli config` writes the same files the web GUI's Models
page uses (`$DSH_HOME/.credentials.yaml` + `settings.yaml`):

```powershell
dcli config                           # show provider/model/api-key status
dcli config set-api-key <key>         # store the DeepSeek API key
dcli config unset-api-key             # remove the stored key
dcli config set-model <id> [--provider <p>] [--reasoning off|high|max]
dcli config list-models               # available models (deepseek-v4-flash/pro)
```

Sessions persist per directory under `$DSH_HOME/sessions`, so `dcli -c` /
`dcli -r` inside a project picks up exactly that project's conversations —
exit any time and continue later, context intact.

Interactive commands:

| command                       | meaning                                   |
| ----------------------------- | ----------------------------------------- |
| `/help`                       | show this list                            |
| `/sessions`                   | list recent sessions in this directory    |
| `/resume <id>`                | switch to another session                 |
| `/new`                        | start a fresh session                     |
| `/apikey <key>`               | save the DeepSeek API key immediately     |
| `/model`                      | show available models + current selection |
| `/model pro`                  | switch model (fuzzy match; same session)  |
| `/reasoning <off\|high\|max>` | set reasoning effort                      |
| `/session`                    | print the session id (for `--resume`)     |
| `/clear`                      | clear the screen                          |
| `/quit`                       | leave (also Ctrl+C at an empty prompt)    |

The prompt supports shell-style editing: **↑/↓** browse command history,
**←/→** move the caret, **Home/End**, **Backspace/Delete**. History is
per-session and capped at 200 entries.

While an agent turn is running, Ctrl+C interrupts it; a second Ctrl+C
force-quits. When a tool call needs permission, dcli asks `Allow <tool>? [y/N]`
right in the terminal.

## How it works

1. `bin/dcli.js` resolves the `dsh` launcher and ensures the `cli` profile
   exists under `$DSH_HOME/profiles/cli` (manifest, patch layer, runner copy).
2. It spawns `dsh --profile cli <args…>`.
3. The profile boots `dsh-base` (agent, session, tools, sandbox, approvals,
   persistence, …) plus the `dsh-headless` coding bundle (persona, tool mode,
   code runtime), with the one-shot `headless-runner` disabled.
4. `runner/runner.js` creates one Agent (`ctx.agents.create`), then loops:
   read a line → `agent.followup(userMessage)` → `agent.whenIdle()` →
   `sessions.flush()`. Live `session/event` appends render streaming
   `assistant/chunk`s, `tool/call`s and `tool/result`s; the runner also answers
   `approval/request` waterfalls with interactive y/N prompts.

## Layout

```
bin/dcli.js       launcher (resolve dsh → self-heal profile → spawn)
runner/runner.js  interactive runner plugin (copied into the profile dir)
install.ps1       convenience installer (npm link)
```

## Notes / limitations

- Sessions persist under `$DSH_HOME/sessions`, grouped per project directory;
  `dcli -c` / `-r` / `--resume <id>` reopen them with full context.
- One-shot mode prints only the final answer (no streaming UI), so it pipes
  cleanly: `dcli "list the files" | Out-String`.
- ANSI colors are used only on a TTY (disable with `NO_COLOR=1`).
- `DSH_HOME` overrides where the profile and sessions live.
- If your PowerShell blocks npm's `.ps1` shims (execution policy), call
  `dcli.cmd` instead — identical behavior, no policy change needed.
- The first run self-initializes `$DSH_HOME/profiles/cli` (manifest, patch
  layer, runner copy) — nothing else to configure.
