# Changelog

## Unreleased

- 新增内置 OpenAI-compatible 网关，将 Claude Code Anthropic Messages 请求转换为 OpenAI Chat Completions，支持非流式、SSE、工具调用、并行工具调用、usage、错误恢复和客户端断连取消。
- 新增 `openai-gateway` 与 `custom-gateway` profile，使用 `.ccp.json`、`.ccp-gateway.json`、派生 `settings.json` 分离路由元数据、上游密钥和 Claude Code 启动配置。
- 多个 gateway profile 复用一个 loopback 共享进程，并按请求隔离 profile 快照、模型、凭据、工具映射、流状态与 AbortController。
- 新增 `ccp gateway status|start|stop|restart`，包含启动锁、进程身份、PID 创建时间、runtime 原子写入和 Windows detached 启停保护。
- `ccp start` 现在按 profile type 显式分派 CCR 或内置网关；Web UI 可只读查看 gateway profile，但不会返回 local token 或开放不完整的 secret 编辑入口。
- 内置网关兼容 Claude Code 2.1.206 的 message-level `system` role 与 `output_config`，可按 profile 将 effort 映射为 `reasoning_effort`，并将 JSON Schema 映射为 OpenAI strict `response_format`。
- 自定义网关创建流程新增现代、传统与高级三档兼容配置，统一重复的默认值，并在可轮转的 `gateway.log` 写入不含正文与密钥的逐请求诊断元数据。
- Profile 名称现在允许中间包含点号，例如 `gpt-5.6`，同时继续拒绝路径分隔符、尾随点号和 Windows 保留设备名。
- OpenAI-compatible 响应解析现在兼容 Mimo 的 nullable 工具字段，包括 `message.tool_calls: null`、`delta.tool_calls: null`，以及工具参数增量中的 `id/name: null`；最终工具调用仍执行完整性和 JSON 校验。
- 流式协议错误在客户端 SSE 已开始后仍通过 error event 返回，但请求日志改为记录内部 502；profile 解析也统一执行名称校验，阻止路径段绕过。
- 后台网关使用独立的运行目录，不再继承调用方位于 `dist` 下的当前工作目录；构建前会完整清理 `dist`，npm 发布白名单只包含编译代码、声明、source map 与 Web 静态资源，避免本地 Claude Code 配置进入发布包。
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
