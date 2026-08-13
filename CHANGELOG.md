# Changelog

## Unreleased

- Gateway Profile 会关闭 Claude Code 对未知 Gateway 模型窗口的强制 200k 预压缩，避免 `claude-ccp-*` 模型启动时显示未知模型警告；实际上下文限制由上游响应决定。
- Gateway Profile 现在会通过 Claude Code 的 `/model` 选择器展示当前 Upstream 配置的全部模型，并使用稳定的 `claude-ccp-*` 别名把选择映射回实际 Upstream 模型；选择不会改写共享 Upstream 或 `.ccp.json` 默认绑定，已移除的旧别名会返回明确错误。
- Gateway 内部协议版本升级到 v3，升级后会替换受 multi-ccp 管理的旧协议进程，确保模型发现能力立即生效；旧 Profile 首次启动会补齐默认模型别名，已有 `/model` 选择则保持不变。

## 0.3.1

- Gateway 兼容 AICodeMirror Responses 流中的 `codex.response.metadata` 事件，并按 OpenAI Responses 契约消费 `image_generation_call`：校验并原子保存最终 PNG/JPEG/WebP、按 SHA-256 去重，再向 Claude Code 返回绝对路径；partial/base64 不会写入 Anthropic SSE 或日志。
- Gateway 脱敏请求日志新增失败阶段/错误码、上游 HTTP 状态与 request ID、SSE 首事件耗时、最后事件和终止事件状态，用于区分本地校验、上游 HTTP 错误、协议转换错误与提前断流；Web UI 可打开请求详情查看安全诊断，并将 `count_tokens`/`models` 404 标记为预期兼容回退。
- Claude Code 普通图片输入和图片型 `tool_result` 现在会原生转换为 Responses `input_image` 或 Chat `image_url`，保留内容顺序且不再使用文本占位符；不支持 vision 的上游错误会直接返回，不会删图重试。
- 增加 Claude Code 2.1.209 脱敏图片请求契约 fixtures，用于检测客户端 request shape 漂移。

## 0.3.0

- 内置 Gateway 新增 OpenAI Responses 上游协议，同时保留既有 OpenAI Chat Completions 上游兼容路径。
- Gateway Upstream 配置升级为 v2，显式保存 `protocol` 与 `endpointUrl`；旧 v1 Chat Completions 配置可继续读取，并只在编辑后写回为 v2。
- OpenAI official、xAI Grok 4.5 与 AICodeMirror Upstream 模板默认使用 Responses；自定义上游可选择 Responses 或 Chat Completions。
- 新增 Responses 请求转换、非流式解析、SSE 流式转换、usage 映射、工具调用、结构化输出、reasoning effort 映射与协议级日志元数据。
- Web UI 与 CLI 支持更灵活的 endpoint/base URL 配置；Web UI 会按所选协议自动补全 `/v1/responses` 或 `/v1/chat/completions`。
- 支持重命名 Upstream，并自动更新已绑定的 Gateway Profile。
- 多模态 `tool_result` 现在会被安全接收，并为 OpenAI 格式上游降级为文本占位符，避免图片内容导致请求转换失败。
- Gateway 请求日志继续记录 endpoint host，并将 endpoint URL 脱敏为 scheme/host/path，移除 userinfo、query string 与 fragment。

## 0.2.1

- Web UI 补全 Profile 名称、API 模型、Upstream ID、Chat Completions URL 和 API Key 等输入提示，并使用当前 Claude Code 支持的完整模型 ID 示例。
- Gateway 管理面板新增创建 Gateway Profile 的快捷入口；创建弹窗可叠加在管理面板上，创建成功后刷新网关状态并自动打开新 Profile 详情。
- CCR 与 Gateway 状态卡增加明确的悬停和无障碍提示，嵌套弹窗中的校验与接口错误会显示在最上层。

## 0.2.0

- Profile 创建合并为单一 Gateway 模板，可选择任意已创建的 Upstream 和模型；OpenAI official 与 OpenAI-compatible 仅保留为 Upstream 创建预设，无可用上游时 Web UI 会显示管理引导。
- Web UI 顶部显示可跳转 GitHub 仓库的 multi-ccp 版本号；CCR 状态弹窗新增 2.x 固定版本、3.x 不兼容说明，以及使用内置 Gateway 接入 OpenAI 格式供应商的引导。
- 新增内置 OpenAI-compatible 网关，将 Claude Code Anthropic Messages 请求转换为 OpenAI Chat Completions，支持非流式、SSE、工具调用、并行工具调用、usage、错误恢复和客户端断连取消。
- 网关配置重构为共享服务、可复用 Upstream 和 Profile Binding 三层：Upstream 独立保存 endpoint、API key、兼容参数和模型列表，Profile 只保存 `upstreamId`、选中模型与本地 token。
- 多个 gateway profile 复用一个 loopback 共享进程，并按请求隔离 profile 快照、模型、凭据、工具映射、流状态与 AbortController。
- 新增 `ccp gateway status|start|stop|restart|list|add|edit|remove|use`，既管理共享服务，也可独立管理 Upstream 和实时切换 Profile 的模型绑定。
- `ccp start` 现在按 profile type 显式分派 CCR 或内置网关；网关运行时会按文件指纹热加载 Profile Binding、Upstream 配置和 API key，无需重启即可切换后续请求。
- 内置网关兼容 Claude Code 2.1.206 的 message-level `system` role 与 `output_config`，可按 profile 将 effort 映射为 `reasoning_effort`，并将 JSON Schema 映射为 OpenAI strict `response_format`。
- `openai` Upstream 是固定官方 endpoint 与官方兼容参数的预设模板；`openai-compatible` 用于 Mimo、OpenRouter 等输出 OpenAI Chat Completions 格式的第三方供应商，并提供现代、传统与高级三档兼容配置。
- Profile 名称现在允许中间包含点号，例如 `gpt-5.6`，同时继续拒绝路径分隔符、尾随点号和 Windows 保留设备名。
- OpenAI-compatible 响应解析现在兼容 Mimo 的 nullable 工具字段，包括 `message.tool_calls: null`、`delta.tool_calls: null`，以及工具参数增量中的 `id/name: null`；最终工具调用仍执行完整性和 JSON 校验。
- 流式协议错误在客户端 SSE 已开始后仍通过 error event 返回，但请求日志改为记录内部 502；profile 解析也统一执行名称校验，阻止路径段绕过。
- 后台网关使用独立的运行目录，不再继承调用方位于 `dist` 下的当前工作目录；构建前会完整清理 `dist`，npm 发布白名单只包含编译代码、声明、source map 与 Web 静态资源，避免本地 Claude Code 配置进入发布包。
- Web UI 新增独立 Gateway 模块，可管理共享服务、Upstream 列表与编辑器、Profile 的 Upstream/Model 实时绑定，以及脱敏请求日志查看和清理；被 Profile 引用的 Upstream 和模型会受到删除保护。
- Web UI 为 AICodeMirror、OpenAI、DeepSeek、Mimo、xAI 等已知供应商增加品牌图标，并在 Profile、创建预设、Upstream 列表和编辑器中保留未知供应商的通用图标回退。
- 新增共享 Upstream 预设模板：OpenAI official 会预填最新 GPT-5.6 模型家族，xAI 会预填 `grok-4.5`，AICodeMirror 会复用 Codex endpoint 和当前模型列表；CLI 与 Web UI 使用同一份模板定义。
- xAI Grok 4.5 预设按官方文档保留 `system` 指令角色、禁用 reasoning model 不支持的 `stop`，并启用受支持的 `temperature/top_p` sampling 参数。
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
