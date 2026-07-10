# multi-ccp

[![NPM Version][npm-version]][npm-url]
[![NPM Downloads][npm-downloads]][npm-url]
[![License][license]][license-url]

[English](README.md) | 简体中文

`multi-ccp` 是一个 Claude Code profile 和历史会话管理工具。它会安装 `ccp` 命令，帮助你运行多个 Claude Code 会话窗口，并让每个窗口拥有独立隔离的配置目录、模型 provider、登录状态和历史记录。

当你希望为工作、个人项目、不同 API provider、不同模型路由分别使用独立 Claude Code 会话时，可以使用 `multi-ccp`，无需手动切换环境变量或反复编辑配置文件。

![multi-ccp](docs/images/image.png)

## 功能特性

- 使用独立 profile 运行多个 Claude Code 会话窗口。
- 每个 profile 的 Claude Code 配置、登录状态、环境变量和项目历史记录互相隔离。
- 创建兼容 Anthropic API 的 profile，自定义 `ANTHROPIC_BASE_URL`、token 和模型配置。
- 创建 Claude 登录 profile，使用 Claude Code 正常账号登录流程，不保存账号密码。
- 创建 [Claude Code Router](https://github.com/musistudio/claude-code-router) preset profile，支持多个模型 provider 和 route。
- 通过同一个 CLI 管理 [Claude Code Router](https://github.com/musistudio/claude-code-router)。
- 使用内置网关让 Claude Code 连接 OpenAI 或 OpenAI-compatible Chat Completions provider。
- 多个 gateway profile 可以并发复用一个本地进程，同时按请求隔离上游 URL、模型、凭据、工具映射、流状态和取消信号。
- 在不同 profile 之间，或在 `main` 与 profile 之间同步 Claude Code 历史会话。
- 快速查看、打开和编辑 profile 配置。

## 安装

```bash
npm install -g multi-ccp
```

验证安装：

```bash
ccp --version
ccp help
```

## 快速开始

想走最短路径？可以先问 AI 如何使用 `multi-ccp`。复制这句提示词：

```text
How do I use multi-ccp to manage multiple Claude Code profiles?
```

如果你想查看完整命令说明，可以继续阅读下面的示例。

打开本地 Web UI，用可视化方式查看 profile 和创建配置：

```bash
ccp ui
```

Web UI 是 CLI 的本地辅助界面，可用于查看 profile、基于预设创建 profile、编辑 profile 配置，以及打开 CCR 管理入口。

![multi-ccp](docs/images/cli-ui.png)

交互式创建一个 profile：

```bash
ccp add
ccp start <profile-name>
```

`ccp add` 会让你选择内置预设模板或自定义配置，例如 OpenAI Gateway、Custom OpenAI-Compatible Gateway、DeepSeek、AI CodeMirror、Mimo、CCR GPT、Manual CCR、Claude Login 或 Custom API。

如果你想直接使用某个内置预设，也可以指定 `--preset`：

```bash
ccp add --preset deepseek
ccp add --preset deepseek my-ds
ccp start my-ds
```

为另一个 provider、账号或项目上下文创建独立 profile：

```bash
ccp add
ccp start <profile-name>
```

列出和查看 profile：

```bash
ccp list
ccp status work
ccp path work
```

## Profile 类型

### API Profiles

API profile 用于兼容 Anthropic API 的 provider。它会将 API 环境变量写入该 profile 的 `settings.json`。

```bash
ccp add
ccp start <profile-name>
```

选择 API 预设时，命令会提示你输入 profile 名称和 token。选择 Custom API 时，命令会提示你输入：

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- 模型名称（可选；留空则使用 Claude Code 默认模型）

#### 自定义 provider 模型

为了简化 provider 配置，`ccp add` 会把你输入的模型名称默认写入所有 Claude Code 默认模型槽位。如果留空，`multi-ccp` 不会写入任何模型环境变量，由 Claude Code 使用默认模型。以填写了模型的 DeepSeek profile 为例，初始配置可能类似：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-",
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro",
    "ANTHROPIC_MODEL": "deepseek-v4-pro"
  }
}
```

如果你的 provider 为快速任务、子代理或长上下文任务提供了不同模型，可以手动编辑 profile：

```bash
ccp edit deepseek
```

例如，把轻量模型分配给快速任务，把支持 1M 上下文的模型分配给主模型槽位：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-",
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1M]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1M]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_MODEL": "deepseek-v4-pro[1M]"
  }
}
```

具体模型名称和 endpoint 请参考 [DeepSeek API 文档](https://api-docs.deepseek.com/)。

### Login Profiles

Login profile 用于 Claude Code 的账号登录模式。它不会设置 `ANTHROPIC_BASE_URL` 或 `ANTHROPIC_AUTH_TOKEN`。

```bash
ccp add
ccp start <profile-name>
```

当 Claude Code 要求你登录时，登录状态会保存在这个 profile 的配置目录下。另一个 profile 可以使用不同账号或不同登录状态：

```bash
ccp add-login personal
ccp start personal
```

`ccp add-login <profile>` 仍可作为直接创建登录 profile 的兼容入口。

### Claude Code Router Profiles

CCR profile 绑定到 [Claude Code Router](https://github.com/musistudio/claude-code-router) preset。Claude Code Router 是一个独立的开源项目，可以将 Claude Code 请求路由到不同模型 provider。`multi-ccp` 会集成它的 config 和 preset system，让每个 profile 可以使用自己的 provider route。

```bash
ccp ccr status
ccp ccr model
ccp add
ccp start <profile-name>
```

CCR profile 会把 route 写入 `.ccp.json`，并让 Claude Code 指向类似这样的 preset endpoint：

```text
http://127.0.0.1:3456/preset/gpt-route
```

### 内置 Gateway Profiles

Gateway profile 会把 Claude Code 的 Anthropic Messages 协议转换为 OpenAI-compatible Chat Completions。供应商没有提供 Anthropic-compatible endpoint 时，可以使用这种 profile。

创建 OpenAI profile：

```bash
ccp add --preset openai-gateway openai-work
ccp start openai-work
```

创建其他 OpenAI-compatible provider profile：

```bash
ccp add --preset custom-gateway company-model
ccp start company-model
```

自定义流程会询问完整 Chat Completions URL、上游模型、API key、instruction role、token limit 字段、sampling/stop 支持、并行工具调用支持以及流式 usage 行为。

所有 gateway profile 共用一个仅监听 loopback 的服务：`http://127.0.0.1:3921`。每个 Claude Code 进程使用独立的 profile path 和本地 token，因此不同供应商 profile 可以安全并发运行。启动第二个 gateway profile 时会复用现有服务，不会重启或中断正在执行的流。

第一期支持 Messages 请求、非流式和 SSE 响应、文本与工具调用、并行工具调用、usage 转换、客户端取消，以及 Claude Code 的 `?beta=true` 和 `HEAD` 探测。可选的 token count 和模型发现端点会明确返回 `404`，由 Claude Code 使用自身 fallback。

## 历史会话同步

`sync-session` 会同步当前项目的 Claude Code 历史会话。你可以交互式选择要同步的会话，也可以一次同步全部会话。

从 `main` 同步到某个 profile：

```bash
ccp sync-session work
ccp sync-session work --all
```

在两个命名 profile 之间同步：

```bash
ccp sync-session work to personal
ccp sync-session work to personal --all
```

从 profile 同步回 `main`：

```bash
ccp sync-session work to main
```

同步命令会在 `.ccp-sync` 中记录 hash，复制 session assets，并在目标文件存在冲突时提示是否覆盖。

## 命令

```bash
ccp help
ccp list
ccp ui
ccp add [profile]
ccp add --preset <preset> [profile]
ccp add-login <profile>
ccp add-ccr <profile>
ccp remove <profile>
ccp status <profile|main>
ccp start <profile> [claude args...]
ccp path <profile|main>
ccp edit <profile>
```

内置网关命令：

```bash
ccp gateway status
ccp gateway start
ccp gateway stop
ccp gateway restart
```

[Claude Code Router](https://github.com/musistudio/claude-code-router) 相关命令：

```bash
ccp ccr status
ccp ccr install
ccp ccr start
ccp ccr stop
ccp ccr restart
ccp ccr ui
ccp ccr model
```

`ccp ccr install` 会固定安装 `@musistudio/claude-code-router@2.0.0`。CCR 3.x 是一次不兼容重写，当前 multi-ccp 不支持。

历史会话同步命令：

```bash
ccp sync-session <target-profile> [--all]
ccp sync-session <source-profile|main> to <target-profile|main> [--all]
```

## 配置目录

Profiles 默认存放在：

```text
~/.claude-profiles/<profile>
```

Gateway profile 还包含 `.ccp-gateway.json`，它是生成的本地 token 和上游 API key 的唯一真相来源。共享 runtime 状态保存在 `~/.claude-profiles/.gateway/`。profile 的 `settings.json` 会在启动前自动派生和修复，不应作为 gateway 路由配置的真相来源。

Claude Code 默认配置目录仍然可以通过 `main` 访问：

```text
main
```

例如：

```bash
ccp status main
ccp sync-session main to work
ccp sync-session work to main
```

## 安全说明

- `ccp remove <profile>` 删除前会要求你输入 profile 名称确认。
- `ccp add`、`ccp add-login` 和 `ccp add-ccr` 不会覆盖已经存在的 profile。
- `sync-session` 使用 SHA-256 hash 检测冲突，并在覆盖目标文件前询问确认。
- Login profile 不保存 Claude 账号密码。
- Gateway API key 不会写入 `.ccp.json`、Web UI 响应、日志或上游错误 envelope。Web UI 暂时只读展示 gateway profile，直到能够原子更新路由元数据和 secret。
- 内置网关只监听 `127.0.0.1`，每个 profile path 都使用生成的本地 token 鉴权，并且不会携带凭据跟随上游重定向。

## 开发

```bash
git clone <repository-url>
cd multi-ccp
npm install
npm run typecheck
npm test
npm run build
```

从源码运行 CLI：

```bash
npm run dev -- help
```

预览 npm 包内容：

```bash
npm pack --dry-run
```

## License

MIT

[npm-version]: https://img.shields.io/npm/v/multi-ccp?style=flat-square
[npm-downloads]: https://img.shields.io/npm/dm/multi-ccp?style=flat-square
[npm-url]: https://www.npmjs.com/package/multi-ccp
[license]: https://img.shields.io/npm/l/multi-ccp?style=flat-square
[license-url]: LICENSE
