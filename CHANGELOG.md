# Changelog

## Unreleased

- 新增内置 OpenAI-compatible 网关，将 Claude Code Anthropic Messages 请求转换为 OpenAI Chat Completions，支持非流式、SSE、工具调用、并行工具调用、usage、错误恢复和客户端断连取消。
- 新增 `openai-gateway` 与 `custom-gateway` profile，使用 `.ccp.json`、`.ccp-gateway.json`、派生 `settings.json` 分离路由元数据、上游密钥和 Claude Code 启动配置。
- 多个 gateway profile 复用一个 loopback 共享进程，并按请求隔离 profile 快照、模型、凭据、工具映射、流状态与 AbortController。
- 新增 `ccp gateway status|start|stop|restart`，包含启动锁、进程身份、PID 创建时间、runtime 原子写入和 Windows detached 启停保护。
- `ccp start` 现在按 profile type 显式分派 CCR 或内置网关；Web UI 可只读查看 gateway profile，但不会返回 local token 或开放不完整的 secret 编辑入口。
- 网关方案参考 Claude Code Gateway Protocol、Anthropic Messages API、OpenAI Chat Completions、LiteLLM、claude-code-router 和 `@the-next-ai/ai-gateway` 的成熟协议边界与回归测试。

## 0.1.9

- `ccp ccr install` 固定安装 `@musistudio/claude-code-router@2.0.0`，避免默认装到不兼容的 CCR 3.x。

## 0.1.8

- 修复 CCR `Router` 为数组等非法结构时无法写入的问题，补全缺失的路由绑定（`default`/`background`/`think`/`longContext`/`webSearch`），保留已有的可用绑定与 `longContextThreshold`。
- 新增配置变更后自动重启 CCR 运行时（`reloadCcrRuntimeWhenChanged`），以及检测 preset 在服务启动后被修改时按需重启（`reloadCcrRuntimeIfPresetOutdated`，通过 PID 文件与进程启动时间比对）。
- 删除 profile 时对 Windows 文件锁（`EBUSY`/`EACCES`/`ENOTEMPTY`/`EPERM`）增加重试，失败时给出可读的错误提示。
- `CcpError` 支持 `cause` 选项以保留错误链。

## 0.1.7

- 添加会话同步可视化 UI。

## 0.1.6

- 支持通过预设模板自动配置 CCR provider。

## 0.1.5

- 添加终端启动和设置文件位置显示功能。
- 将预设描述从英文翻译为简体中文。

## 0.1.4

- 添加本地 Web UI 管理界面。
- 添加预设模板和交互式创建界面。

## 0.1.3

- 将模型名称设为可选，留空则使用 Claude Code 默认模型。

## 0.1.2

- 添加会话同步功能。
- 在创建配置前检查是否已存在同名配置。
- 从 `package.json` 读取版本号而非硬编码。
- 移除未使用的环境变量配置。

## 0.1.1

- 实现 CCR 配置文件和预设管理功能。

## 0.1.0

- Initial TypeScript npm package scaffold.
- Added cross-platform profile core for API and Claude login profiles.
- Added CLI commands for `list`, `add`, `add-login`, `remove`, `status`, `path`, `edit`, and `start`.
- Added Vitest coverage for core profile behavior.
- Added CCR base commands for `status`, `install`, `start`, `stop`, `restart`, `ui`, and `model`.
- Added CCR preset-bound profile creation with `add-ccr`.
- Added CCR profile gateway preparation before `ccp start`.
- Added session synchronization with `sync-session`.
