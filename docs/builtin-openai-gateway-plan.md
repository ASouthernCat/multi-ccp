# multi-ccp 内置 OpenAI 兼容网关方案

## 1. 文档状态

本文定义 multi-ccp 第一期内置网关的可实现契约。

核心目标不是只让一个 Claude Code 连接一个 OpenAI 服务，而是支持多个 Claude Code 进程通过不同 gateway profile 并发使用不同供应商，同时保证路由、凭据、模型、错误和流式状态彼此隔离。

本方案的参考优先级为：

1. LiteLLM、claude-code-router 和 `@the-next-ai/ai-gateway` 用于确定成熟的模块边界、转换算法、取消语义和回归测试集合。
2. Claude Code、Anthropic 和 OpenAI 官方文档只用于确定 wire protocol 和验收契约。
3. 不把任何“官方网关”服务、部署或可用性作为前提；网关完全由 multi-ccp 本地实现和运行。
4. 当成熟实现与官方字段定义不一致时，以官方协议字段为准，并为差异补测试。

本文中的关键设计决策如下：

1. 使用一个共享的本地网关进程，不为每个 profile 单独启动端口和进程。
2. 网关不存在全局活动 profile、全局活动供应商或全局活动模型。
3. 每个请求通过 URL 中的 profile 名和该 profile 的本地 token 绑定到不可变配置快照。
4. 正在执行的请求继续使用其启动时的快照；配置变化只影响后续请求。
5. 新建、修改或删除 gateway profile 不需要重启共享网关。
6. settings.json 是 Claude Code 的派生启动配置，不是 gateway 配置的真相来源。
7. 上游 API key 永远不会作为 ANTHROPIC_AUTH_TOKEN 传给 Claude Code。
8. 第一期只实现 Anthropic Messages 到 OpenAI Chat Completions 的转换，不发展成通用路由平台。
9. 协议转换采用精简规范化模型：Anthropic source parser -> Canonical IR -> OpenAI target serializer；非流式和流式共享同一套语义映射。
10. Claude Code 官方 Gateway Protocol 是入口契约；`?beta=true`、启动探测、请求头和错误恢复语义都必须被显式支持。
11. `count_tokens` 是可选能力。第一期不暴露不可靠估算接口，让 Claude Code 在端点缺失时使用本地 fallback。
12. 不直接依赖 LiteLLM、CCR core gateway 或任何官方网关进程；复用的是经过验证的结构和测试边界，而不是引入整套平台。

## 2. 目标与范围

### 2.1 第一期目标

- OpenAI Chat Completions 及标准 OpenAI-compatible 上游。
- 本地 Anthropic Messages API 入口。
- 非流式响应。
- SSE 流式响应。
- 文本消息和基础工具调用转换。
- Claude Code 官方 Gateway Protocol 的入口兼容。
- 同一网关内多个 gateway profile 并发运行。
- 不同 Claude Code 进程并发使用不同供应商。
- 与 multi-ccp profile、ccp start 和 CLI 生命周期集成。
- Windows 11、macOS 和 Linux 下的基本进程管理。
- 无 Python、LiteLLM 或额外全局 npm 网关依赖。

### 2.2 第一期不做

- CCR 3.x 适配。
- OpenAI Responses API。
- 多模型 fallback 链。
- 按请求动态选择模型。
- 复杂规则路由。
- transformer 插件系统。
- 图片、音频和文档内容转换。
- Anthropic extended thinking 内容转换。
- Anthropic server tools。
- 精确计费系统。
- API key 轮换池。
- 桌面应用。
- gateway profile 的完整 Web UI 编辑。
- `/v1/models` 网关模型发现。
- 对未知模型暴露估算型 `/v1/messages/count_tokens`。

CCR 2.x 集成继续保留，避免破坏现有 profile。

## 3. 必须支持的并发场景

multi-ccp 允许用户同时开启多个 Claude Code：

~~~text
Claude Code A
  -> profile=openai-work
  -> http://127.0.0.1:3921/p/openai-work
  -> OpenAI

Claude Code B
  -> profile=deepseek-personal
  -> http://127.0.0.1:3921/p/deepseek-personal
  -> DeepSeek-compatible upstream

Claude Code C
  -> profile=company-gateway
  -> http://127.0.0.1:3921/p/company-gateway
  -> Company OpenAI-compatible upstream
~~~

三个 Claude Code 进程共享同一个本地网关，但每个请求必须独立绑定：

- profile 名。
- 本地鉴权 token。
- 上游 Chat Completions URL。
- 上游 API key。
- 上游模型。
- 兼容性参数。
- AbortController。
- 超时状态。
- SSE 转换状态。
- 请求日志上下文。

禁止出现以下全局可变状态：

- currentProfile。
- currentProvider。
- currentModel。
- currentApiKey。
- 当前请求的 stream state。
- 供所有请求复用并可被修改的 headers 对象。

一个 profile 的上游超时、429、无效响应、配置更新或客户端断连，不得改变其他 profile 的请求结果。

## 4. 当前架构与目标架构

### 4.1 当前 CCR 架构

~~~text
Claude Code
  -> multi-ccp profile
  -> ANTHROPIC_BASE_URL=http://127.0.0.1:3456/preset/<name>
  -> CCR 2.x
  -> provider
~~~

multi-ccp 当前负责：

- profile 创建、隔离和切换。
- Claude Code 环境变量生成。
- CCR provider、route 和 preset 配置。
- CCR 生命周期管理。

### 4.2 内置网关目标架构

~~~text
                        +-> OpenAI
Claude Code A --+      |
Claude Code B --+--> multi-ccp builtin gateway
Claude Code C --+      |
                        +-> OpenAI-compatible providers
~~~

本地入口：

~~~text
http://127.0.0.1:3921/p/<profile>
~~~

Claude Code 在该 base URL 后发起的正式推理请求为：

~~~text
POST /v1/messages?beta=true
~~~

网关必须按 pathname 匹配，不能把 query string 当成路由的一部分。最终正式路由为：

~~~text
POST /p/:profile/v1/messages
~~~

Claude Code 还可能发送以下请求：

~~~text
HEAD /
HEAD /p/:profile/
POST /p/:profile/v1/messages/count_tokens
GET  /p/:profile/v1/models?limit=1000
~~~

- `HEAD /` 是官方记录的 best-effort 启动连通性探测，第一期返回 204；同时兼容 profile base path 的 HEAD。
- `count_tokens` 是可选接口；第一期返回 404，使 Claude Code 使用本地估算。
- 模型发现默认关闭，第一期不实现 `/v1/models`。

## 5. 设计原则

1. multi-ccp 继续以 profile 管理为核心。
2. 网关是共享单实例、按 profile 隔离的协议转换器。
3. 每个 gateway profile 固定绑定一个上游 Chat Completions URL 和模型。
4. Claude Code 请求中的 model 不决定实际上游模型，但必须保留为 clientModel，用于诊断、能力判断和错误说明。
5. 每个请求只能读取自己的 profile 快照和 secret。
6. 配置读取失败时 fail closed，不使用旧 profile 的 secret 兜底。
7. 默认且第一期仅监听 127.0.0.1。
8. 网关进程是否存活与某个 Claude Code 进程是否退出无关。
9. ccp start 不得因为另一个 profile 正在使用网关而重启网关。
10. profile 更新通过原子快照生效，不中断其他正在进行的请求。
11. 上游 URL、参数和错误必须经过 provider 层规范化。
12. 不支持的 Anthropic 功能必须返回明确错误，不静默转换成错误语义。
13. CCR profile 与 gateway profile 在过渡期并行存在。
14. 上游 400 的原始错误 message 是 Claude Code 能力降级和自动重试协议的一部分，不能统一改写为泛化错误。
15. `x-claude-code-*` 请求头只用于追踪和归属，不参与 profile 鉴权，也不能当作用户身份。

## 6. Profile 与配置模型

### 6.1 ProfileType

~~~ts
export type ProfileType =
  | "api"
  | "login"
  | "ccr"
  | "gateway"
  | "unknown";
~~~

### 6.2 Provider 与兼容性配置

第一期不根据模型名临时猜测所有供应商行为。创建 profile 时生成明确的兼容性配置，使运行时行为稳定且可检查。

~~~ts
export type GatewayProvider =
  | "openai"
  | "openai-compatible";

export interface GatewayCompatibility {
  instructionRole: "system" | "developer";
  maxTokensField: "max_tokens" | "max_completion_tokens";
  supportsStop: boolean;
  supportsSampling: boolean;
  parallelToolCalls: "supported" | "unsupported";
  streamUsage: "include" | "omit";
}

export interface GatewayProfileConfig {
  provider: GatewayProvider;
  protocol: "openai_chat_completions";
  chatCompletionsUrl: string;
  model: string;
  compatibility: GatewayCompatibility;
}
~~~

chatCompletionsUrl 存储最终的请求 URL，而不是语义不明确的 baseUrl。例如：

~~~text
https://api.openai.com/v1/chat/completions
~~~

CLI 可以接受用户输入的 API Base URL，并在创建时将它规范化为最终 URL：

- 输入以 /chat/completions 结尾时直接使用。
- 否则去掉尾斜杠并追加 /chat/completions。
- 只允许 http 和 https。
- 禁止 URL 中包含用户名或密码。
- 第一期开启 redirect: manual，不携带 API key 跟随重定向。

### 6.3 默认兼容性配置

OpenAI preset 使用保守且面向当前 Chat Completions API 的默认值：

~~~json
{
  "instructionRole": "developer",
  "maxTokensField": "max_completion_tokens",
  "supportsStop": false,
  "supportsSampling": false,
  "parallelToolCalls": "supported",
  "streamUsage": "include"
}
~~~

这样可以避免向推理模型发送已知可能不支持的 stop、temperature 和 top_p。后续可以由显式 profile 编辑能力开启这些参数。

Custom OpenAI-Compatible 默认值：

~~~json
{
  "instructionRole": "system",
  "maxTokensField": "max_tokens",
  "supportsStop": true,
  "supportsSampling": true,
  "parallelToolCalls": "unsupported",
  "streamUsage": "omit"
}
~~~

Custom profile 创建流程应展示这些默认值。高级用户可以在确认前调整，不能依靠运行时模型名正则偷偷改变行为。

### 6.4 ProfileMeta

~~~ts
export interface ProfileMeta {
  version: number;
  type: Exclude<ProfileType, "unknown">;
  createdAt?: string;
  preset?: string;

  gateway?: GatewayProfileConfig;

  // Existing CCR metadata remains during migration.
  endpoint?: string;
  autoStart?: boolean;
  ccrPreset?: string;
  ccrRoute?: string;
}
~~~

gateway profile 不把 endpoint 作为真相来源。它的本地 endpoint 由全局 gateway runtime 配置和 profile 名派生。

### 6.5 Secret 模型

~~~ts
export interface GatewayProfileSecret {
  version: 1;
  localToken: string;
  apiKey: string;
}
~~~

localToken 和 apiKey 的唯一真相来源是 .ccp-gateway.json。

settings.json 中的 ANTHROPIC_AUTH_TOKEN 是为了启动 Claude Code 而生成的派生副本。每次 ccp start 前必须从 secret 修复 settings.json，避免用户手工编辑后产生漂移。

localToken 使用 node:crypto 生成至少 32 字节随机值并编码成 base64url。

## 7. 文件布局与真相来源

### 7.1 Profile 文件

~~~text
~/.claude-profiles/<profile>/
  settings.json
  .ccp.json
  .ccp-gateway.json
~~~

职责：

| 文件 | 职责 | 是否真相来源 |
|---|---|---|
| settings.json | Claude Code 启动配置 | 否，可修复派生文件 |
| .ccp.json | 非敏感 profile 元数据和上游配置 | 是 |
| .ccp-gateway.json | 本地 token 和上游 API key | 是 |

### 7.2 settings.json 示例

~~~json
{
  "theme": "dark",
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3921/p/openai-work",
    "ANTHROPIC_AUTH_TOKEN": "ccp-local-generated-token",
    "NO_PROXY": "127.0.0.1,localhost",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_COST_WARNINGS": "1",
    "API_TIMEOUT_MS": "600000",
    "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
    "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    "CLAUDE_CODE_DISABLE_THINKING": "1",
    "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING": "1",
    "MAX_THINKING_TOKENS": "0",
    "ENABLE_TOOL_SEARCH": "false"
  }
}
~~~

gateway profile 不写 ANTHROPIC_MODEL 和各类 Claude model override。Claude Code 发来的模型名由网关接收但不用于上游路由。

以上六个 Claude Code 兼容变量有明确目的：

- `CLAUDE_CODE_ATTRIBUTION_HEADER=0`：本方案会重组 system blocks，应由客户端省略 attribution block，不能在网关中移动或合并该 block。
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`：第一期不支持 context management、beta tool schema 字段和其他预发布 Anthropic 能力。
- `CLAUDE_CODE_DISABLE_THINKING=1`：第一期的主要兼容开关，要求 Claude Code 从 gateway 请求中省略 `thinking` 参数。
- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`：对仍允许关闭 adaptive thinking 的 Claude Code / 模型组合减少不兼容请求，但不能把它视为完整保证；新模型可能忽略该变量。
- `MAX_THINKING_TOKENS=0`：对支持关闭 thinking 的模型显式禁用扩展思考；Fable 5 等不可关闭模型可能忽略它。
- `ENABLE_TOOL_SEARCH=false`：第一期不转换 `tool_reference` 和 MCP tool search blocks。

`ccp start` 每次都从 profile 真相来源修复这些派生值。即使环境变量已经设置，网关仍必须对实际收到的未知字段做协议校验，因为 Claude Code 的能力和默认行为会随版本变化。

### 7.3 .ccp.json 示例

~~~json
{
  "version": 1,
  "type": "gateway",
  "createdAt": "2026-07-10T00:00:00.000Z",
  "gateway": {
    "provider": "openai",
    "protocol": "openai_chat_completions",
    "chatCompletionsUrl": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-5",
    "compatibility": {
      "instructionRole": "developer",
      "maxTokensField": "max_completion_tokens",
      "supportsStop": false,
      "supportsSampling": false,
      "parallelToolCalls": "supported",
      "streamUsage": "include"
    }
  }
}
~~~

### 7.4 .ccp-gateway.json 示例

~~~json
{
  "version": 1,
  "localToken": "ccp-local-generated-token",
  "apiKey": "sk-..."
}
~~~

### 7.5 写入要求

- .ccp.json、.ccp-gateway.json 和 settings.json 使用临时文件加 rename 原子替换。
- POSIX 下创建 secret 文件时使用 0600。
- Windows 下依赖用户主目录 ACL，并确保不主动放宽权限。
- 写入失败时不得留下半个 JSON 文件。
- 日志不得记录 secret 文件内容。
- 删除 profile 时同时删除 secret。

## 8. 全局 Gateway Runtime

端口属于共享网关，不属于 profile。

~~~ts
export interface GatewayRuntimeConfig {
  version: 1;
  host: "127.0.0.1";
  port: number;
}
~~~

全局文件：

~~~text
~/.claude-profiles/.gateway/
  config.json
  runtime.json
  gateway.log
  startup.lock
~~~

config.json 示例：

~~~json
{
  "version": 1,
  "host": "127.0.0.1",
  "port": 3921
}
~~~

第一期不提供运行中修改 host 或 port 的热更新。全局 runtime 配置变化必须通过显式 ccp gateway restart 生效。

如果 runtime.json 指向一个仍存活、但 endpoint 与当前 config.json 不一致的自有网关，ccp gateway start 必须拒绝启动第二个实例，并提示用户执行 restart。

runtime.json 只在网关运行期间有效：

~~~ts
export interface GatewayRuntimeState {
  version: 1;
  service: "multi-ccp-gateway";
  protocolVersion: 1;
  instanceId: string;
  pid: number;
  processStartedAt: string;
  endpoint: string;
}
~~~

runtime.json 必须原子写入。进程正常停止时删除；异常退出后允许残留，但 status 和 stop 不能只相信该文件。

## 9. Profile Registry 与热更新

### 9.1 Registry 职责

registry.ts 提供：

~~~ts
export interface GatewayRouteSnapshot {
  profileName: string;
  config: Readonly<GatewayProfileConfig>;
  secret: Readonly<GatewayProfileSecret>;
  fingerprint: string;
}

export interface GatewayRegistry {
  resolve(profileName: string): Promise<GatewayRouteSnapshot>;
  countProfiles(): Promise<number>;
}
~~~

### 9.2 按请求解析

每次请求按以下流程执行：

1. 严格校验 profile 名，禁止路径穿越。
2. 定位 profile 目录。
3. stat .ccp.json 和 .ccp-gateway.json。
4. 使用 mtime、size 和文件路径生成缓存 fingerprint。
5. fingerprint 未变化时复用已验证的不可变快照。
6. fingerprint 变化或首次访问时重新读取并校验两个文件。
7. 文件不存在、类型不是 gateway、JSON 无效或字段缺失时立即失败。
8. 返回冻结的 request-local snapshot。

同一 profile 同时发生多个 cache miss 时，应合并为一个加载 Promise，避免重复读取。

### 9.3 更新语义

- 新建 profile：第一次请求自动加载，不重启网关。
- 修改 profile：新请求读取新快照。
- 删除 profile：新请求返回 404；已经开始的请求继续使用旧快照直到结束。
- 修改 API key：进行中的请求不切换 key；新请求使用新 key。
- 修改模型或 URL：进行中的请求不迁移；新请求使用新配置。

这种语义保证配置更新不会中断其他正在运行的 Claude Code。

### 9.4 禁止共享可变路由对象

请求开始后必须创建独立 RequestContext：

~~~ts
export interface GatewayRequestContext {
  requestId: string;
  profile: GatewayRouteSnapshot;
  abortController: AbortController;
  startedAt: number;
  client: {
    model?: string;
    sessionId?: string;
    agentId?: string;
    parentAgentId?: string;
  };
  toolNames: {
    targetToSource: Map<string, string>;
  };
}
~~~

provider headers、request body 和 stream state 都从该 context 创建，不允许修改 registry 中的对象。

`sessionId`、`agentId` 和 `parentAgentId` 分别来自：

~~~text
x-claude-code-session-id
x-claude-code-agent-id
x-claude-code-parent-agent-id
~~~

它们只用于日志关联、并发诊断和未来可选成本归属。agent ID 标识 Claude Code agent，不标识用户、设备或操作系统账号。

## 10. 模块结构

~~~text
src/gateway/
  types.ts
  canonical.ts
  paths.ts
  storage.ts
  registry.ts
  auth.ts
  server.ts
  lifecycle.ts
  errors.ts
  source/
    anthropic-messages.ts
  target/
    openai-chat.ts
    openai-compatible.ts
    tools.ts
  stream/
    openai-sse-parser.ts
    canonical-stream.ts
    anthropic-sse-emitter.ts
  providers/
    openai-compatible.ts
~~~

职责：

- types.ts：Anthropic、OpenAI、profile 和运行时类型。
- canonical.ts：协议无关的精简请求、响应和流事件模型。
- paths.ts：全局 runtime 与 profile secret 路径。
- storage.ts：原子 JSON 读写和 secret 权限。
- registry.ts：按 profile 解析、校验和缓存不可变快照。
- auth.ts：本地 token 提取与常量时间比较。
- server.ts：HTTP 路由、body 限制、请求上下文和错误出口。
- lifecycle.ts：启动锁、实例识别、启动、停止、重启和状态检查。
- source/anthropic-messages.ts：解析和校验 Claude Code 的 Anthropic Messages 请求，生成 CanonicalRequest。
- target/openai-chat.ts：把 CanonicalRequest 序列化为 OpenAI Chat Completions，并把非流式响应解析为 CanonicalResponse。
- target/openai-compatible.ts：按 profile compatibility 做供应商特定字段改写，不负责路由。
- target/tools.ts：工具名、schema、tool_use、tool_result 和 tool_choice 映射。
- stream/openai-sse-parser.ts：只负责 SSE 分帧和 OpenAI chunk 解析。
- stream/canonical-stream.ts：把 OpenAI chunk 转成 CanonicalStreamEvent 并维护请求级状态。
- stream/anthropic-sse-emitter.ts：把 canonical events 按 Anthropic SSE 顺序输出。
- providers/openai-compatible.ts：上游 HTTP、超时、redirect 和响应校验。

### 10.1 Canonical IR

参考 LiteLLM 和 `@the-next-ai/ai-gateway` 后，本方案不再让 request、response 和 stream 三套代码各自重复理解 Anthropic / OpenAI 语义。第一期只定义完成当前目标所需的最小 IR：

~~~ts
export type CanonicalContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface CanonicalTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface GatewayError {
  type: "invalid_request_error" | "authentication_error" | "rate_limit_error" | "api_error";
  message: string;
}

export interface CanonicalMessage {
  role: "user" | "assistant";
  content: CanonicalContent[];
}

export interface CanonicalToolChoice {
  mode: "auto" | "required" | "none" | "tool";
  name?: string;
  disableParallelToolUse?: boolean;
}

export interface CanonicalRequest {
  clientModel: string;
  system: string[];
  messages: CanonicalMessage[];
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  stop?: string[];
  tools?: CanonicalTool[];
  toolChoice?: CanonicalToolChoice;
  stream: boolean;
}

export interface CanonicalResponse {
  id: string;
  model: string;
  content: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
  >;
  finishReason: "end_turn" | "tool_use" | "max_tokens";
  usage: CanonicalUsage;
}
~~~

Canonical IR 的边界：

- 不是通用 provider SDK，不包含路由、credential pool、fallback、计费或插件信息。
- 保留内容 block 顺序；目标协议无法无损表达某种顺序时，由 target serializer 明确拒绝。
- `clientModel` 与实际上游 `profile.gateway.model` 分开，禁止覆盖或混用。
- stream state 只引用本请求的 canonical block，不引用全局 adapter 状态。
- 不支持的 Anthropic 字段在 source parser 阶段失败，不进入半转换状态。

### 10.2 Canonical Stream Event

流式转换使用更小的事件集合：

~~~ts
export type CanonicalStreamEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "text_delta"; blockKey: string; text: string }
  | { type: "tool_start"; blockKey: string; id: string; name: string }
  | { type: "tool_arguments_delta"; blockKey: string; partialJson: string }
  | { type: "block_stop"; blockKey: string }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "finish"; reason: CanonicalResponse["finishReason"] }
  | { type: "error"; error: GatewayError };
~~~

OpenAI chunk index 只用于 canonical stream state 的 `blockKey` 映射；Anthropic content block index 由 emitter 单调分配，两者不能混为一个 index。

## 11. 本地 HTTP API

默认 endpoint：

~~~text
http://127.0.0.1:3921
~~~

接口：

~~~text
HEAD /
HEAD /p/:profile/
GET  /health
POST /p/:profile/v1/messages
~~~

第一期不提供可以修改配置的本地 control API。配置由 CLI 原子写入，registry 按请求感知变化。

以下接口第一期明确不提供：

~~~text
POST /p/:profile/v1/messages/count_tokens -> 404
GET  /p/:profile/v1/models              -> 404
~~~

### 11.1 Health

~~~json
{
  "ok": true,
  "service": "multi-ccp-gateway",
  "protocolVersion": 1,
  "instanceId": "generated-instance-id",
  "pid": 12345,
  "endpoint": "http://127.0.0.1:3921",
  "profileCount": 3,
  "uptime": 120
}
~~~

lifecycle 只有在 service、protocolVersion 和 instanceId 符合预期时，才能把端口判断为自己的网关。

`HEAD /` 和 `HEAD /p/:profile/` 不读取 profile、不验证 local token，也不返回 body，只返回 204。前者是 Claude Code 官方记录的 best-effort 连通性探测，后者用于兼容不同 base path URL 解析行为；两者都不能作为网关健康检查或鉴权结果。

### 11.2 请求限制

- 只接受已声明路由对应的方法；正式推理只接受 POST，连通性探测只接受 HEAD。
- Content-Type 必须为 application/json。
- 默认请求体上限 64 MiB，超出返回 413。
- JSON 无效返回 invalid_request_error。
- 只处理 choice index 0，并强制上游 n=1。
- 每个请求生成 requestId。
- `/v1/messages?beta=true` 与 `/v1/messages` 命中同一路由。
- 未识别 query 参数不得改变 profile 路由，但可在 debug 日志中记录参数名集合。

### 11.3 Claude Code 请求头

入口必须按大小写不敏感方式读取：

| Header | 第一阶段行为 |
|---|---|
| Authorization / x-api-key | 本地 profile token 鉴权 |
| anthropic-version | 校验存在时的基本格式；不转发到 OpenAI 上游 |
| anthropic-beta | 记录存在性和哈希，不把 beta allowlist 固化进代码 |
| x-claude-code-session-id | 写入 request context |
| x-claude-code-agent-id | 写入 request context |
| x-claude-code-parent-agent-id | 写入 request context |
| ANTHROPIC_CUSTOM_HEADERS 产生的其他头 | 默认不转发；只允许 profile 明确配置的安全 header |

对 Anthropic-format 上游应把 `anthropic-*` 视为开放集合并原样转发；但第一期目标是 OpenAI Chat Completions，不能把 Anthropic header 或 beta body 字段盲目发送到上游。source parser 必须逐项决定“转换、明确拒绝或仅作为本地元数据消费”。

## 12. 本地鉴权

支持 Claude Code 常用的两种形式：

~~~text
x-api-key: <localToken>
Authorization: Bearer <localToken>
~~~

处理流程：

1. 从 URL 解析并校验 profile 名。
2. registry.resolve 获取该 profile 快照。
3. 提取本地 token。
4. 对期望 token 和实际 token 做固定长度摘要。
5. 使用 timingSafeEqual 比较摘要。
6. 鉴权成功后才构建上游请求。

安全要求：

- A profile 的 token 不能访问 B profile。
- 401 响应不区分 profile 不存在、secret 缺失或 token 错误，避免额外泄露。
- GET /health 不返回 profile 名、URL、模型或任何 token。
- 上游 API key 只存在于 request-local headers。

## 13. Anthropic 请求转换

### 13.1 顶层字段

| Anthropic Messages | OpenAI Chat Completions |
|---|---|
| model | 保存为 clientModel；实际上游 model 来自 profile |
| system | developer 或 system message，由 compatibility 决定 |
| messages | 转换后的 OpenAI messages |
| max_tokens | max_tokens 或 max_completion_tokens |
| temperature | supportsSampling=true 时传递 |
| top_p | supportsSampling=true 时传递 |
| stop_sequences | supportsStop=true 时映射为 stop |
| stream | stream |
| tools | function tools |
| tool_choice | OpenAI tool_choice |

无论 Claude Code 请求中的 model 是什么，上游 model 始终使用 profile.gateway.model。source parser 必须保留原始 clientModel，但 target serializer 不得直接复制它。

第一期对新增能力字段的处理：

| 字段 | 行为 |
|---|---|
| thinking | 返回 400，message 必须包含字段名和 adaptive / unsupported 原因 |
| context_management | 返回 400，不静默丢弃 |
| output_config.effort | 保存到 Canonical IR，由 target compatibility 映射为 `reasoning_effort`、`output_config.effort` 或明确省略 |
| output_config.format | 保存到 Canonical IR，映射为 OpenAI strict `response_format`、`output_config.format`，或在不支持时返回 400 |
| top_k | 返回 400；OpenAI Chat Completions 没有等价标准字段 |
| metadata | 仅保留安全的本地诊断字段，不转发到上游 |
| 未知顶层字段 | 返回 400，并包含精确字段名 |

Claude Code 会把未识别 gateway model alias 当作当前模型并可能发送 adaptive thinking，因此不能认为“忽略 request model”就等价于“不需要处理 thinking”。`CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` 只是降低出现概率；source parser 仍必须有确定行为。

本地拒绝示例：

~~~json
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "thinking.type: adaptive thinking is not supported by this gateway profile; Extra inputs are not permitted"
  }
}
~~~

错误 message 需要保留 `thinking`、`adaptive` 和 `Extra inputs are not permitted` 这类可识别语义，因为 Claude Code 会根据部分 400 错误文字禁用能力并重试。不能统一替换成 `Unsupported request`。

上游请求固定：

~~~json
{
  "n": 1
}
~~~

流式请求固定 `stream=true`。只有 `compatibility.streamUsage=include` 时才增加：

~~~json
{
  "stream": true,
  "stream_options": {
    "include_usage": true
  }
}
~~~

### 13.2 System

Anthropic system 可以是字符串或 text block 数组。

处理规则：

- 只提取 text block。
- cache_control 第一期忽略，但不能把它序列化进文本。
- 使用 compatibility.instructionRole 决定 role。
- 多个 text block 按原顺序以换行拼接。
- 遇到非 text system block 返回 invalid_request_error。

由于转换过程会把 system block 数组合并成 OpenAI instruction message，`settings.json` 必须设置 `CLAUDE_CODE_ATTRIBUTION_HEADER=0`。不要依靠在网关中查找、移动或合并 `x-anthropic-billing-header` block；CCR 的兼容清理逻辑只能作为历史实现参考，不是本方案的主契约。

### 13.3 支持的 content block

| Anthropic block | 第一期行为 |
|---|---|
| text | 支持 |
| tool_use | 支持 |
| tool_result | 支持 |
| image | 返回 invalid_request_error |
| document | 返回 invalid_request_error |
| thinking | 返回 invalid_request_error |
| redacted_thinking | 返回 invalid_request_error |
| server_tool_use | 返回 invalid_request_error |
| web_search_tool_result | 返回 invalid_request_error |
| 未知 block | 返回 invalid_request_error |

显式失败优于丢弃内容后继续请求。

### 13.4 User 消息

普通 text block 转成 OpenAI user content。

包含 tool_result 时执行以下规则：

1. tool_result 必须位于该 Anthropic user message 的文本之前。
2. 多个 tool_result 分别转换成多个 role=tool message。
3. 所有 tool message 保持原始顺序。
4. tool_result 后的剩余 text 合并成一个新的 role=user message。
5. 如果 text 出现在 tool_result 之前，返回 invalid_request_error。

Anthropic：

~~~json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_1",
      "content": "result 1"
    },
    {
      "type": "tool_result",
      "tool_use_id": "toolu_2",
      "content": "result 2",
      "is_error": true
    },
    {
      "type": "text",
      "text": "Continue."
    }
  ]
}
~~~

OpenAI：

~~~json
[
  {
    "role": "tool",
    "tool_call_id": "toolu_1",
    "content": "result 1"
  },
  {
    "role": "tool",
    "tool_call_id": "toolu_2",
    "content": "Tool execution failed:\nresult 2"
  },
  {
    "role": "user",
    "content": "Continue."
  }
]
~~~

tool_result.content 为 text block 数组时按顺序拼接。包含非 text block 时返回 invalid_request_error。

### 13.5 Assistant 消息

Anthropic assistant message 可以包含 text 和一个或多个 tool_use。

第一期要求：

- text block 必须位于 tool_use 之前。
- 所有 text 合并为 OpenAI assistant content。
- 所有 tool_use 按顺序转换成 tool_calls。
- tool_use 后再次出现 text 时返回 invalid_request_error，因为 Chat Completions 无法保留这种交错顺序。

Anthropic tool_use：

~~~json
{
  "type": "tool_use",
  "id": "toolu_1",
  "name": "Bash",
  "input": {
    "command": "pwd"
  }
}
~~~

OpenAI tool call：

~~~json
{
  "id": "toolu_1",
  "type": "function",
  "function": {
    "name": "Bash",
    "arguments": "{\"command\":\"pwd\"}"
  }
}
~~~

### 13.6 Tool 定义

~~~text
tools[].name
  -> tools[].function.name

tools[].description
  -> tools[].function.description

tools[].input_schema
  -> tools[].function.parameters
~~~

第一期不自动设置 strict=true，因为 Claude Code 提供的 JSON Schema 不保证满足 OpenAI strict mode 对 required 和 additionalProperties 的约束。

`tools[].cache_control` 可以被 source parser 接受但不转发，也不能错误地合并进 `function.parameters`。`strict`、`defer_loading`、`eager_input_streaming` 等额外 schema 字段在第一期返回包含字段路径的 400。

OpenAI-compatible 上游通常要求工具名长度不超过 64，并限制为字母、数字、下划线和短横线。target serializer 必须：

1. 对不符合目标约束的名称做确定性规范化。
2. 超过 64 字符时使用前缀加 8 位 SHA-256 摘要。
3. 处理规范化后的名称碰撞。
4. 在 request-local `targetToSource` map 中保存映射。
5. 响应和流式 tool call 返回 Claude Code 前恢复原始工具名。

该映射属于单个请求，不能存进全局 provider 或跨请求缓存。

### 13.7 Tool Choice

| Anthropic | OpenAI |
|---|---|
| auto | auto |
| any | required |
| none | none |
| tool + name | 指定 function |

`tool_choice.disable_parallel_tool_use` 必须参与映射：

~~~text
disable_parallel_tool_use = true
  -> parallel_tool_calls = false

disable_parallel_tool_use = false 或缺失
  -> parallel_tool_calls = true
~~~

具体规则：

- `compatibility.parallelToolCalls=supported`：显式写入上述布尔值。
- `compatibility.parallelToolCalls=unsupported` 且请求要求禁用并行：返回 400，不能假装已限制为单工具调用。
- `compatibility.parallelToolCalls=unsupported` 且请求未要求禁用：省略该字段，使用供应商默认行为。

profile compatibility 描述的是上游是否支持 `parallel_tool_calls` 参数，不是覆盖 Claude Code 请求意图的全局开关。

转换器必须支持一个 assistant turn 返回多个 tool calls，以及下一轮 user message 返回多个 tool results。

## 14. Provider 请求策略

providers/openai-compatible.ts 的输入必须是 request-local snapshot，不能读取全局活动 profile。

请求要求：

- Authorization: Bearer <profile secret apiKey>。
- Content-Type: application/json。
- redirect: manual。
- 使用独立 AbortController。
- 上游连接和响应读取共享同一个取消信号。
- 客户端断开时立即 abort 对应上游请求。
- 一个请求 abort 不得取消其他请求。
- abort 时取消或销毁上游 response body，不能只停止向客户端写入。
- 读取上游错误体时限制最大字节数。
- 不复用可修改的 headers 或 body 对象。
- 第一期不在网关内部自动重试 completion 请求，避免重复生成和重复计费；`maxAttempts=1`。

超时：

~~~ts
export interface GatewayTimeouts {
  connectMs: number;
  totalMs: number;
}
~~~

第一期可以使用全局默认值，但 timeout state 必须属于单个请求。

上游 HTTP 层和协议转换层必须分离。HTTP 层只返回状态、headers 和原始 body/byte stream；它不判断 Anthropic stop reason，也不维护 tool block index。

## 15. 非流式响应转换

OpenAI：

~~~json
{
  "id": "chatcmpl_123",
  "model": "gpt-5",
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": "hello",
        "tool_calls": []
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 3
  }
}
~~~

Anthropic：

~~~json
{
  "id": "msg_chatcmpl_123",
  "type": "message",
  "role": "assistant",
  "model": "gpt-5",
  "content": [
    {
      "type": "text",
      "text": "hello"
    }
  ],
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 12,
    "output_tokens": 3
  }
}
~~~

转换规则：

- OpenAI content 转 text block。
- refusal 有文本时作为 text block 返回。
- 每个 function tool_call 转成 tool_use block。
- `tool_calls: null` 和 `function_call: null` 按未调用工具处理；非 null 的非法类型仍返回 api_error。
- tool call 名称通过 request-local `targetToSource` map 恢复为 Claude Code 原始工具名。
- tool call id 规范化为 Anthropic 接受的 `[A-Za-z0-9_-]+`；非法字符替换后附加摘要，避免不同原始 id 发生碰撞。
- arguments 必须在响应返回前解析成 JSON object。
- arguments 不是合法 JSON object 时返回 api_error，不伪造空 input。
- usage.prompt_tokens 映射 input_tokens。
- usage.completion_tokens 映射 output_tokens。
- 上游没有 usage 时使用 0，但记录不含敏感信息的 debug 原因。

停止原因：

| OpenAI | Anthropic |
|---|---|
| stop | end_turn |
| tool_calls | tool_use |
| length | max_tokens |
| content_filter | end_turn，并返回可用 refusal/content |
| function_call | tool_use，兼容旧上游 |
| null 或未知 | api_error |

choices 缺失、choices 为空或 choice 0 缺少 message 时返回 api_error。

## 16. SSE 流式转换

### 16.1 Anthropic 事件序列

正常文本或工具响应：

~~~text
message_start
content_block_start
content_block_delta
content_block_stop
message_delta
message_stop
~~~

可以发送 ping，但第一期不依赖 ping 保证正确性。

### 16.2 StreamState

~~~ts
export interface StreamState {
  messageId: string;
  model: string;
  messageStarted: boolean;
  nextBlockIndex: number;
  textBlock?: {
    index: number;
    started: boolean;
    stopped: boolean;
  };
  toolBlocks: Map<number, {
    index: number;
    id?: string;
    anthropicId?: string;
    name?: string;
    arguments: string;
    started: boolean;
    stopped: boolean;
    pendingDeltas: string[];
    sourceName?: string;
  }>;
  finishReason?: string;
  inputTokens: number;
  outputTokens: number;
  terminal: boolean;
}
~~~

toolBlocks 的 key 是 OpenAI tool_calls[].index，不是 Anthropic block index。

StreamState 是 canonical stream converter 的内部状态。Anthropic emitter 只消费 CanonicalStreamEvent，不直接读取 OpenAI chunk；这样非流式和流式共享 finish reason、usage、工具名恢复和错误规范。

### 16.3 SSE 解析要求

- 不能假设一个网络 chunk 等于一个 SSE event。
- 支持 CRLF 和 LF。
- 支持同一 event 的多行 data。
- 忽略注释行。
- 正确处理 data: [DONE]。
- JSON chunk 无效时发送 Anthropic error event 并结束连接。
- 客户端断开时 abort 上游，不发送正常 message_stop。
- 上游提前断开且未完成时发送 error event。
- 一个 OpenAI chunk 同时包含 delta 和 finish_reason 时，必须先处理 delta，再处理 finish。
- choices 为空但包含 usage 的最终 chunk 是合法 chunk，不能当成无效响应。
- 同一个 chunk 中多个不同 tool index 必须分别处理，不能只读取 tool_calls[0]。
- `delta.tool_calls: null` 按无工具增量处理；已开始的工具调用在后续 chunk 中返回 `id/name/arguments: null` 时按该字段未更新处理。

### 16.4 文本 block

收到第一个有效 OpenAI chunk 后先发送 message_start：

~~~json
{
  "type": "message_start",
  "message": {
    "id": "msg_chatcmpl_123",
    "type": "message",
    "role": "assistant",
    "model": "gpt-5",
    "content": [],
    "stop_reason": null,
    "stop_sequence": null,
    "usage": {
      "input_tokens": 0,
      "output_tokens": 0
    }
  }
}
~~~

OpenAI Chat Completions 的完整 usage 通常直到流末尾才到达，因此 message_start 使用 0。不得为了等待 usage 而缓存整个响应。

第一次收到非空 content delta 时：

1. 分配 Anthropic block index。
2. 发送 content_block_start，type=text。
3. 发送 text_delta。

后续 content 发送相同 index 的 text_delta。

结束时只对已启动且未停止的 block 发送一次 content_block_stop。

### 16.5 Tool block

OpenAI 会把 tool call 的 id、name 和 arguments 分散在多个 chunk 中。

处理规则：

1. 按 OpenAI tool index 建立状态。
2. id 和 name 尚未到齐时缓存 arguments delta；name 分片需要追加，不能只保留第一个片段。
3. id 和 name 到齐后分配 Anthropic block index。
4. 发送 content_block_start：

~~~json
{
  "type": "tool_use",
  "id": "call_123",
  "name": "Bash",
  "input": {}
}
~~~

5. 使用 input_json_delta.partial_json 发送已缓存和后续 arguments 片段。
6. 上游结束时拼接完整 arguments 并验证它是 JSON object。
7. 验证失败时发送 error event，不再发送正常 message_delta 和 message_stop。
8. name 通过 request-local tool name map 恢复后再写入 content_block_start。
9. id 在 content_block_start 前只规范化一次并保存为 anthropicId，后续 delta 不得改变它。

多个 tool call 必须拥有独立状态和独立 Anthropic block index。

### 16.6 Usage 与终止

`compatibility.streamUsage=include` 时，上游请求设置 `stream_options.include_usage=true`；否则省略该字段。

最终 usage chunk：

~~~text
prompt_tokens     -> input_tokens
completion_tokens -> output_tokens
~~~

最终 message_delta.usage 同时携带已知的 input_tokens 和 output_tokens，从而修正 message_start 中的初始 0。

如果兼容上游不返回最终 usage，则保留 0，不阻塞正常结束。

收到有效 finish_reason 后记录终止原因；`[DONE]` 或上游正常 EOF 用于确认流结束，不能要求两个信号一定同时存在。流结束时：

1. 停止所有已启动 block。
2. 发送 message_delta，其中包含 stop_reason 和最终 output_tokens。
3. 发送 message_stop。
4. 设置 terminal=true。

任何路径最多发送一个 terminal sequence。

若收到 `[DONE]` 或 EOF 时既没有 finish_reason，也没有上游 error event，则视为 incomplete stream：发送一个 Anthropic `error` event 并关闭，不能伪造 `end_turn`。LiteLLM 的回归测试专门覆盖了“payload 文本中出现 message_stop 但没有真正终止事件”的情况，本方案也必须按 SSE event 边界判断，不能做 substring 搜索。

响应写入必须尊重 backpressure。客户端连接关闭后，依次取消 upstream fetch、销毁 parser / transform / response streams，并在内部记录 499；不得把 499 作为 HTTP 响应写给已经断开的客户端。

## 17. 可选 Token Counting

Claude Code 官方把 token counting 定义为可选能力。端点不存在时，Claude Code 会在本地估算 context usage，因此第一期选择：

~~~text
POST /p/:profile/v1/messages/count_tokens -> 404
~~~

不采用字符数、UTF-8 字节数或“已知 tokenizer + 人工 message overhead”对外伪装精确计数，原因是：

- Anthropic Messages 的 system、tools、tool_result 和 schema 计数不等于把转换后的 OpenAI JSON 丢进 tokenizer。
- OpenAI-compatible 供应商可能对同名模型使用不同 tokenizer 或模板。
- 偏低估算会让 Claude Code 过晚压缩上下文；偏高估算也可能造成过早压缩。
- 官方已经提供端点缺失时的本地 fallback，网关没有必要返回可信度更低的数字。

后续只有满足以下条件才启用该路由：

1. profile 明确声明 exact counter capability。
2. counter 覆盖 messages、system、tools 和全部已支持 content blocks。
3. 返回值经过与真实供应商 count endpoint 或官方 tokenizer 的一致性测试。
4. 不支持的模型返回 404，而不是退回粗略估算。

`count_tokens` 不参与正式推理路由，也不能触发上游 completion 请求。

## 18. 错误转换

网关自身生成的非流式错误使用 Anthropic envelope：

~~~json
{
  "type": "error",
  "error": {
    "type": "api_error",
    "message": "Upstream connection timed out."
  }
}
~~~

HTTP 映射：

| 场景 | HTTP | Anthropic error type |
|---|---:|---|
| 请求 JSON 或内容不支持 | 400 | invalid_request_error |
| 本地 token 错误 | 401 | authentication_error |
| profile 不存在 | 401 或 404，对未鉴权请求统一为 401 | authentication_error 或 not_found_error |
| 上游 400 | 400 | invalid_request_error |
| 上游 401/403 | 502 | api_error，并使用脱敏消息说明上游鉴权失败 |
| 上游 404 | 502 | not_found_error |
| 上游 429 | 429 | rate_limit_error |
| 上游 5xx | 502 | api_error |
| 上游连接失败 | 502 | api_error |
| 上游超时 | 504 | api_error |

上游鉴权失败使用 502，是因为 Claude Code 提供的本地 token 可能完全正确，失败的是网关到上游的配置。

### 18.1 上游 400 与 Claude Code 自动恢复

Claude Code 会根据部分上游 400 的错误文字自动禁用 thinking、无效 thinking signature 或 mid-conversation system 等能力，然后重试当前会话。错误转换必须遵守：

1. 如果上游已经返回 Anthropic error envelope，状态码和 body 原样返回。
2. 如果上游返回 OpenAI-compatible error envelope，只转换外层格式，内部 `error.message` 原文保留。
3. 不给 message 添加 `Upstream request failed:`、供应商名或 gateway 前缀。
4. 如果 message 不是字符串，才使用受控 fallback。
5. 只在 message 中精确替换已知 localToken / apiKey；不能为了脱敏把整个 message 改成泛化文本。

示例：

~~~jsonc
// upstream
{
  "error": {
    "message": "thinking.type: Extra inputs are not permitted",
    "type": "invalid_request_error"
  }
}

// gateway -> Claude Code
{
  "type": "error",
  "error": {
    "type": "invalid_request_error",
    "message": "thinking.type: Extra inputs are not permitted"
  }
}
~~~

这不是普通错误文案，而是客户端能力协商的一部分。context management 和 beta tool schema 的部分拒绝不会自动重试，因此 `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` 仍然必要。

### 18.2 流式错误

流式响应已经发送 200 后发生错误时，发送 Anthropic error SSE event 并关闭连接。

- 上游 SSE 中显式 error event：转换为 Anthropic error event，保留 message。
- JSON/SSE 解析错误：发送 gateway 生成的 api_error。
- HTTP 状态无法在流开始后修改，但内部请求日志必须把这类流式失败记录为 502，不能记录为成功 200。
- 客户端断连：取消上游并内部记 499，不再写 error event。
- incomplete stream：发送一次 api_error，不发送 message_stop。

### 18.3 脱敏

脱敏要求：

- 不输出 Authorization。
- 不输出 x-api-key。
- 不输出 localToken。
- 不输出上游 API key。
- 日志中的 URL 移除 query 和 userinfo。
- 日志中的错误 body 经过结构化脱敏和长度限制。
- 客户端响应不回传未知上游字段、headers 或完整 raw body，但应保留经过 secret 精确替换后的错误 message。
- 日志脱敏与客户端错误转换是两个独立步骤，不能复用一个“全部改成 ***”的函数。

## 19. 生命周期

### 19.1 启动

ccp gateway start：

1. 读取全局 config.json。
2. 尝试获取 startup.lock。
3. 获取锁后重新检查 /health。
4. 如果已存在身份匹配的网关，直接成功。
5. 如果 runtime.json 指向仍存活但 endpoint 不同的自有网关，拒绝启动并提示 restart。
6. 如果端口被其他服务占用，明确报错并显示端口。
7. 使用 process.execPath 启动 gateway entry，确保兼容当前 nvm Node。
8. 使用 detached、windowsHide 和独立日志文件句柄。
9. 子进程启动后 unref。
10. 轮询 /health，校验 service、protocolVersion 和 instanceId。
11. 成功后释放 startup.lock。

多个 ccp start 同时执行时，startup.lock 保证只启动一个网关进程。等待者获取锁后必须重新检查 health，不能直接再次 spawn。

startup.lock 应记录创建 PID 和时间。只有锁所属进程已不存在或锁超过明确的启动超时，才允许清理 stale lock。

### 19.2 Status

不能只测试 TCP 端口。

状态检查：

1. 请求 /health。
2. 校验 service=multi-ccp-gateway。
3. 校验 protocolVersion。
4. 读取 runtime.json。
5. 校验 endpoint instanceId 与 runtime.json 一致。
6. 校验 PID 存活。
7. 在 Windows 上同时校验进程创建时间，防止 PID 重用。

### 19.3 Stop

ccp gateway stop 只终止确认属于当前网关的进程：

- runtime.json 身份匹配。
- PID 存活。
- 进程创建时间匹配。
- /health instanceId 匹配。

任一身份检查失败时，不得根据端口或 PID 猜测并终止进程。

Windows 下优先正常终止；仅在超时且所有权仍然匹配时使用强制终止。

### 19.4 Restart

restart 是显式管理命令。

ccp start <gateway-profile> 不调用 restart，因为其他 Claude Code 可能正在通过同一网关执行请求。

### 19.5 网关退出

- gateway 不跟随任一 Claude Code 子进程退出。
- 第一期不实现守护进程自动拉起。
- 网关异常退出后，当前请求失败。
- 下一次 ccp start 或 ccp gateway start 负责重新启动。

## 20. ccp start 集成

~~~text
resolve profile
  -> read meta
  -> type=gateway
  -> validate gateway config and secret
  -> derive global gateway endpoint
  -> repair settings.json from source-of-truth files
  -> ensure gateway instance is running
  -> verify health identity
  -> launch Claude Code
~~~

重要语义：

- prepareClaudeLaunch 根据 profile type 分派到 ensureCcrProfileGateway 或 ensureBuiltinGatewayProfile。
- ensureBuiltinGatewayProfile 只校验和修复当前 profile，不修改其他 profile。
- 网关已运行时不得重启。
- profile 无需预注册到进程；首次请求由 registry.resolve 自动加载。
- 两个 ccp start 并发执行时只能产生一个共享网关进程。

## 21. CLI 与预设

### 21.1 Gateway 管理

~~~text
ccp gateway status
ccp gateway start
ccp gateway stop
ccp gateway restart
~~~

status 输出：

~~~ts
export interface GatewayStatus {
  installed: true;
  endpoint: string;
  running: boolean;
  owned: boolean;
  profileCount: number;
  pid?: number;
  instanceId?: string;
  statusText:
    | "Offline"
    | "Running"
    | "Port In Use"
    | "Stale Runtime";
}
~~~

### 21.2 OpenAI GPT

输入：

1. profile 名。
2. OpenAI API key。
3. model。

固定配置：

~~~text
Provider: OpenAI
Chat Completions URL: https://api.openai.com/v1/chat/completions
Compatibility: OpenAI conservative defaults
~~~

### 21.3 Custom OpenAI-Compatible

输入：

1. profile 名。
2. API Base URL 或完整 Chat Completions URL。
3. API key。
4. model。
5. 选择现代 OpenAI Chat Completions、传统 OpenAI-compatible 或高级自定义映射。

高级设置：

- instructionRole。
- maxTokensField。
- supportsStop。
- supportsSampling。
- parallelToolCalls。
- streamUsage。
- reasoningEffort。
- structuredOutput。

完成后：

~~~text
ccp start <profile>
~~~

创建 profile 不要求网关已运行。

## 22. Web UI

第一期 Web UI 仅做只读展示：

- profile type=gateway。
- 绑定模型。
- 上游 hostname，不显示完整 query。
- gateway online/offline。
- secret configured/missing。

不在 Web UI 返回或显示：

- localToken。
- 上游 API key。
- .ccp-gateway.json 内容。

创建和编辑 gateway profile 先由 CLI 完成。

## 23. 与现有 CCR 和参考网关的关系

### 23.1 multi-ccp profile 兼容关系

| Profile 类型 | 处理方式 |
|---|---|
| api | 直接连接 Anthropic-compatible endpoint |
| login | Claude 官方登录隔离 |
| ccr | 继续使用 CCR 2.0.0 |
| gateway | 使用 multi-ccp 内置共享网关 |

暂不自动迁移 CCR profile。

后续迁移命令：

~~~text
ccp migrate-ccr <profile>
~~~

迁移要求用户重新提供 API key，不从 CCR 配置静默复制敏感信息。

### 23.2 LiteLLM

核对版本：

~~~text
BerriAI/litellm
commit bf02a4a47f08ad8007a24c8da2ffa8de1a1d36a2
2026-07-10
~~~

与本方案直接相关的实现：

- `litellm/llms/anthropic/experimental_pass_through/messages/handler.py`
- `litellm/llms/anthropic/experimental_pass_through/adapters/transformation.py`
- `litellm/llms/anthropic/experimental_pass_through/adapters/streaming_iterator.py`
- `tests/test_litellm/llms/anthropic/experimental_pass_through/messages/test_parallel_tool_calls.py`
- `tests/test_litellm/llms/anthropic/experimental_pass_through/messages/test_streaming_iterator.py`

这些文件体现的行为包括：

- `anthropic_messages_handler` 根据目标 provider 选择 native pass-through、OpenAI Responses 或 completion adapter。
- `LiteLLMMessagesToCompletionTransformationHandler` 把 Anthropic 请求转换为内部 completion 请求，再统一调用 provider 层。
- `AnthropicAdapter` / `LiteLLMAnthropicMessagesAdapter` 集中处理 messages、tools、tool_choice、thinking、usage 和响应转换。
- `AnthropicStreamWrapper` 用显式状态维护 message_start、content blocks、message_delta 和 message_stop。
- 对超过 OpenAI 64 字符限制的工具名做摘要截断，并保存反向映射。
- 对 combined content + finish_reason、连续多个 tool call、tool/text 交错、usage 后到和 incomplete stream 都有回归测试。

采用：

- source / canonical / target 分层思想。
- 工具名确定性映射和反向恢复。
- 流式状态机及终止序列回归测试。
- 对 provider-specific 能力使用显式配置，不在协议核心中散落判断。

不照搬：

- 100+ provider registry、动态 router、fallback、预算、计费、guardrail 和多凭据调度。
- Python 运行时和 LiteLLM 全局依赖。
- 对第一期未支持字段做复杂 polyfill。

当前参考版本的 Anthropic -> completion adapter 会转换 tool_choice 的 `type`，但该路径没有把 `disable_parallel_tool_use` 明确映射成 `parallel_tool_calls`。本方案必须按 Claude API 官方字段补齐，不能把参考实现当前行为当成完整规范。

### 23.3 claude-code-router 3.x

核对版本：

~~~text
musistudio/claude-code-router 3.0.10
commit 3c27b7f9122eae906aaeceaeb05e401b3cb246a5
@the-next-ai/ai-gateway 1.0.6
~~~

CCR 3.x 当前不是一个单文件 transformer，而是两层结构：

~~~text
CCR wrapper service
  -> Claude Code 路由、配置生成、运行时管理、观测
  -> 独立 core gateway 子进程
  -> @the-next-ai/ai-gateway 协议转换核心
~~~

wrapper 层值得采用的实现经验：

关键文件：

- `packages/core/src/gateway/service.ts`
- `packages/core/src/gateway/claude-code-router-plugin.ts`
- `packages/core/src/gateway/runtime-change.ts`
- `tests/main/gateway-client-disconnect.test.mjs`
- `tests/main/router-builtins.test.mjs`

- runtime marker 保存 runtimeId，health 必须校验实例身份。
- 私有目录 / 文件使用 0700 / 0600；Windows 保持用户 ACL。
- 每请求创建独立 AbortController，客户端断开立即取消对应上游并内部记录 499。
- 流式 response pipe 期间同时采样、检测 SSE error，并统一销毁关联 streams。
- 使用 `x-claude-code-session-id` 做会话归属，不把 session ID 当鉴权。
- OpenAI stream 在兼容配置允许时补 `stream_options.include_usage=true`。
- Claude Code 路由插件与协议转换核心分离，model/header/body rewrite 不侵入通用转换状态机。

`@the-next-ai/ai-gateway` 的核心结构为：

~~~text
source adapter
  -> StandardRequest / StandardResponse
  -> target adapter
  -> centralized streaming conversion
  -> upstream client
~~~

其 source map 中可确认：

关键源码路径：

- `src/types.ts`
- `src/adapters/builtins/source/parsers.ts`
- `src/adapters/builtins/target/openai-responses.ts`
- `src/adapters/builtins/target/shared.ts`
- `src/gateway/streaming-conversion.ts`
- `src/upstream/client.ts`

- Anthropic parser 把 text、tool_use、tool_result 和 thinking 解析成 StandardRequest content。
- OpenAI target serializer 再生成 Chat Completions messages、tools 和 tool_choice。
- provider-specific OpenAI-compatible rewrite 与通用 serializer 分离。
- upstream client 集中处理 timeout、AbortSignal、response body cancel、URL/header/body 日志脱敏。
- streaming conversion 集中处理不同目标协议的事件序列。

本方案采用该分层，但缩小 IR 和模块数量。第一期不引入它的插件系统、provider fallback、credential scheduler、熔断、计费、MCP gateway、agent runtime 或通用模型注册中心。

同样需要注意：`@the-next-ai/ai-gateway@1.0.6` 的 StandardRequest 当前没有独立保存 `disable_parallel_tool_use`，OpenAI Chat target 也没有输出 `parallel_tool_calls`。本方案以 Claude 官方 API 契约为准，补上该字段。

### 23.4 最终采用边界

| 能力 | LiteLLM | CCR / ai-gateway | multi-ccp 第一期 |
|---|---|---|---|
| 规范化中间模型 | 大型统一模型 | StandardRequest / StandardResponse | 精简 Canonical IR |
| 多 provider | 100+ | 多协议、多 provider | OpenAI Chat + 显式兼容配置 |
| 多凭据调度 | 支持 | 支持 | 不做，每 profile 一个 key |
| fallback | 支持 | 支持 | 不做 |
| 插件 | 多 hook | gateway plugins | 不做 |
| 请求隔离 | router/request context | AbortSignal + request context | profile snapshot + request context |
| 流式转换 | AnthropicStreamWrapper | centralized conversion | canonical stream state machine |
| Claude Code headers | proxy 入口处理 | session 路由与观测 | 只做归属和诊断 |
| count_tokens | 多实现 / fallback | 自有估算 | 默认 404，使用 Claude Code fallback |

参考项目用于验证工程模式和边界条件，不能代替 Claude Code Gateway Protocol、Anthropic Messages API 和 OpenAI Chat Completions API 本身。

### 23.5 直接依赖评估

第一期不直接把参考项目作为 runtime dependency：

- LiteLLM 需要 Python，并引入远超当前范围的 router、provider registry、计费和管理能力。
- claude-code-router 3.x 的 core gateway 是完整应用进程，不是只提供 Anthropic -> OpenAI 转换的稳定小型库。
- `@the-next-ai/ai-gateway` 包含 Fastify server、插件、fallback、credential scheduler、billing、MCP 和 agent runtime；直接嵌入会扩大配置面、依赖面和安全审计范围。
- 参考项目升级可能改变内部 adapter API；multi-ccp 不应把 profile 真相来源和生命周期绑定到其内部实现。

采用方式是：

1. 按 LiteLLM / ai-gateway 的 source -> standard -> target 模式实现精简 TypeScript 版本。
2. 把成熟项目覆盖的工具调用、stream 终止、usage、取消和错误案例整理为本项目 fixture。
3. 对参考实现未覆盖或处理不完整的官方字段单独补 fixture，例如 `disable_parallel_tool_use`。
4. 记录参考 commit 和 package version，使未来行为变化可追溯。

这样既利用成熟方案的工程经验，也不依赖外部网关是否可部署、是否在线或是否继续维护。

## 24. 测试计划

### 24.1 配置与存储

- 创建 gateway profile。
- .ccp.json 不包含 API key 和 localToken。
- .ccp-gateway.json 包含完整 secret。
- localToken 至少 32 字节随机源。
- settings.json 从 secret 正确派生。
- settings.json 固定派生 attribution、experimental beta、adaptive thinking 和 tool search 兼容变量。
- ccp start 修复被手工修改的 endpoint 和 localToken。
- 原子写入失败不破坏旧文件。
- 删除 profile 同时删除 secret。
- Windows 路径和文件占用错误处理。

### 24.2 Registry

- 首次请求加载 profile。
- fingerprint 未变化时命中缓存。
- profile 更新后新请求获取新快照。
- 进行中的请求保留旧快照。
- profile 删除后新请求失败。
- 同一 profile 并发 cache miss 只读取一次。
- 无效 JSON、缺失 secret 和错误 type fail closed。

### 24.3 Claude Code Gateway Protocol

- `POST /v1/messages?beta=true` 按 pathname 正确命中。
- `HEAD /` 和 `HEAD /p/:profile/` 返回 204，且不加载 profile secret。
- `count_tokens` 和 `/v1/models` 第一期返回 404。
- Authorization 和 x-api-key 两种本地 token 形式。
- header 名大小写不敏感。
- session / agent / parent-agent header 正确进入 request context。
- agent ID 不参与鉴权，A profile 的 agent ID 不能访问 B profile。
- anthropic-beta 只记录存在性 / 哈希，不硬编码 allowlist。
- request model 保存为 clientModel，但上游使用 profile model。
- thinking / context_management 返回包含精确字段名的 400；output_config effort 与 format 按 target compatibility 转换。
- upstream 400 转换 envelope 后 message 原文不变。

### 24.4 请求转换

- Anthropic source parser -> CanonicalRequest。
- CanonicalRequest -> OpenAI target request。
- system string 和 text block 数组。
- developer/system role 配置。
- user text。
- assistant text。
- 单个和多个 tool_use。
- 单个和多个 tool_result。
- tool_result 后跟 user text。
- text 位于 tool_result 前时拒绝。
- tool_use 后再次出现 text 时拒绝。
- tool_choice 全部映射。
- `disable_parallel_tool_use` 映射到 `parallel_tool_calls`。
- 上游不支持 parallel_tool_calls 且请求要求禁用并行时明确拒绝。
- 超长 / 非法工具名的确定性规范化、碰撞处理和反向恢复。
- max_tokens 字段策略。
- stop 和 sampling 过滤。
- 不支持的 content block 明确报错。

### 24.5 非流式响应

- 文本响应。
- 单个和多个 tool call。
- 规范化后的 tool name 恢复为 Claude Code 原始名称。
- 包含点号、冒号、空格和冲突值的 tool call id 规范化。
- refusal。
- usage 映射。
- stop reason 映射。
- 无 choices。
- 非法 tool arguments。

### 24.6 SSE

- SSE event 被拆成多个网络 chunk。
- 一个网络 chunk 包含多个 SSE event。
- CRLF 和 LF。
- 文本 delta。
- 多个 tool call 的 arguments delta。
- 同一 chunk 内多个 tool index。
- id/name 延迟到达。
- delta 与 finish_reason 同 chunk，delta 不丢失。
- 最终 usage chunk。
- choices 为空的 usage-only chunk。
- 不返回 usage 的兼容上游。
- [DONE]。
- 无 [DONE] 但有 finish_reason 并正常 EOF。
- 上游提前断开。
- payload 文本包含 message_stop 但没有真实终止 event。
- JSON chunk 无效。
- tool arguments 最终无效。
- 客户端主动断开。
- backpressure 和关联 streams 销毁。
- 断连内部记录 499，但不向已关闭连接写响应。
- terminal sequence 只发送一次。

### 24.7 并发与隔离

必须覆盖以下核心场景：

1. Claude Code A 使用 OpenAI profile 持续 SSE。
2. 同时 Claude Code B 使用 custom profile 持续 SSE。
3. 两个请求分别到达正确 mock upstream。
4. A 的 API key、model 和 tool state 不出现在 B 请求中。
5. A 的 localToken 访问 B 路径返回 401。
6. A 客户端断连只取消 A 上游请求。
7. B 上游返回 429 不影响 A。
8. A 流式期间更新 B 配置，A 不受影响。
9. A 流式期间删除 B，A 不受影响。
10. 同时执行两个 ccp start 只启动一个 gateway。
11. 第二个 ccp start 不重启正在服务 A 的 gateway。
12. 同一 profile 下主 agent 与多个 subagent 并发时，共享 profile snapshot 但拥有独立 abort / stream / requestId。
13. 不同 session/agent header 不改变 provider、API key 或 model 选择。

### 24.8 生命周期

- 正常 start/status/stop/restart。
- 已运行时 start 幂等。
- startup.lock 并发竞争。
- stale lock 恢复。
- stale runtime.json。
- 端口被其他 HTTP 服务占用。
- /health service 不匹配。
- instanceId 不匹配。
- PID 重用保护。
- Windows process.execPath 和 windowsHide。

### 24.9 可选端点

- `count_tokens` 返回 404 后正式推理仍可继续。
- `/v1/models` 返回 404 后 ccp start 不失败。
- 后续 exact counter 未声明 capability 时不能注册路由。
- 模型发现后续启用时只暴露以 claude 或 anthropic 开头的 ID，并接受仅 x-api-key 的发现请求。

自动测试不调用真实 OpenAI API。

## 25. 实现顺序

### 阶段 1：配置真相来源与 Registry

- 扩展 ProfileType 和 ProfileMeta。
- 增加 GatewayProfileConfig、GatewayCompatibility 和 secret 类型。
- 实现原子 JSON 写入。
- 实现 createGatewayProfile。
- 实现 settings 派生和修复。
- 实现按请求 registry.resolve。
- 完成配置与 registry 单测。

阶段 1 必须先确定并发和快照语义，不能先写一个依赖全局 provider 的 HTTP server。

### 阶段 2：协议转换

- 先建立 LiteLLM / ai-gateway / 官方协议三方行为对照表和 reference fixtures。
- CanonicalRequest、CanonicalResponse 和 CanonicalStreamEvent。
- Anthropic source parser。
- OpenAI Chat target serializer / parser。
- tool 消息展开。
- tool_choice、parallel_tool_calls 和工具名映射。
- 非流式 response 转换。
- SSE parser 和状态机。
- 完成纯转换单测。

### 阶段 3：Provider 与 HTTP Server

- OpenAI-compatible provider。
- timeout、abort 和 redirect。
- 本地鉴权。
- /health。
- HEAD profile probe。
- /v1/messages。
- count_tokens 和 /v1/models 明确 404。
- mock upstream 集成测试。

### 阶段 4：生命周期与 multi-ccp 集成

- 全局 runtime paths。
- startup.lock。
- start/stop/restart/status。
- Windows 实例所有权检查。
- prepareClaudeLaunch 支持 gateway。
- ccp add 新预设。
- 并发 ccp start 测试。

### 阶段 5：并发验收与文档

- 双 profile 并发集成测试。
- 故障隔离测试。
- Web UI 只读展示。
- README 中英文说明。
- CHANGELOG。

## 26. 验收标准

1. 能创建 OpenAI 和自定义 OpenAI-compatible gateway profile。
2. ccp gateway start 后 /health 返回可验证的网关身份。
3. ccp start <gateway-profile> 自动修复派生 settings 并确保网关运行。
4. 同时启动多个 gateway profile 时只存在一个共享网关进程。
5. 多个 Claude Code 能并发使用不同供应商和不同模型。
6. 请求、API key、model、abort 和 stream state 按 profile 与请求隔离。
7. 第二个 ccp start 不会重启正在处理请求的网关。
8. profile 更新不打断已经开始的其他请求。
9. 非流式文本和工具调用能够往返转换。
10. SSE 文本和多个工具调用不会挂起。
11. 客户端断连只取消对应上游请求。
12. 上游错误以 Anthropic 格式返回且不泄露凭据，400 message 保留 Claude Code 自动恢复所需语义。
13. `?beta=true`、HEAD probe 和 `x-claude-code-*` headers 符合 Claude Code Gateway Protocol。
14. `count_tokens` 缺失时不返回伪精确数字，Claude Code 使用本地 fallback。
15. API、login 和 CCR profile 行为不回归。
16. 用户不需要安装 Python 或额外全局网关依赖。
17. Windows 11 与 nvm Node 环境下可正确启动和停止自有网关进程。

## 27. 主要风险

### 27.1 OpenAI-compatible 差异

不同供应商对 developer role、max_completion_tokens、tool_choice、parallel_tool_calls、stream_options 和 usage chunk 的支持不同。

应对：

- profile 中保存显式 compatibility。
- 不在运行时静默猜测并改变配置。
- custom profile 默认使用保守兼容设置。
- 上游不支持的能力通过 profile 配置关闭。
- provider-specific rewrite 只发生在 target 层，不污染 canonical source parser。

### 27.2 流式协议

SSE 分帧、tool call index、arguments 碎片、usage 和 terminal event 处理错误会导致 Claude Code 等待不结束。

应对：

- 独立 SSE parser。
- 显式状态机。
- 每请求独立状态。
- 终止路径测试。

### 27.3 多 Claude Code 并发

全局活动 provider、共享可变 headers 或重启网关都会造成跨 profile 污染和请求中断。

应对：

- 共享进程但不共享请求状态。
- request-local immutable snapshot。
- 按请求 registry.resolve。
- ccp start 不重启。
- 双供应商并发集成测试。

### 27.4 生命周期与端口所有权

仅检测端口或仅依赖 PID 文件可能误判其他进程，Windows 还存在 PID 重用。

应对：

- health identity。
- instanceId。
- process start time。
- startup.lock。
- stop 前多重所有权验证。

### 27.5 Secret

secret 文件、派生 settings、错误体和日志都有泄露风险。

应对：

- 上游 key 不进入 settings。
- 原子 secret 文件。
- 最小文件权限。
- 固定脱敏入口。
- 不跟随上游重定向。

### 27.6 Claude Code 协议演进

Claude Code 会新增 beta header、request field、tool schema 字段和模型能力。把当前观察到的字段列表写死为永久协议会在后续版本突然失败。

应对：

- 以官方 Gateway Protocol 为入口基线。
- 每次 Claude Code 升级都运行 contract fixture。
- Anthropic-format pass-through 将 headers / fields 视为开放集合；OpenAI target 则明确转换或拒绝。
- experimental beta 默认在 Claude Code 启动环境中关闭。
- 未知字段错误必须包含字段路径，便于定位而不是静默丢弃。

### 27.7 错误恢复语义

统一包裹上游 400、修改 message 或把所有错误变成 502，会破坏 Claude Code 的自动 capability downgrade。

应对：

- status、error type 和 message 分层映射。
- 上游 400 message 保留原文。
- 本地 unsupported error 使用稳定字段名和可识别错误语义。
- 测试 thinking rejection 后的错误 body，而不只断言 HTTP status。

## 28. 后续演进

第一期稳定后再考虑：

- OpenAI Responses API。
- 精确模型 capability catalog。
- 系统凭据存储或 Windows Credential Manager。
- 多 API key。
- fallback model。
- profile 编辑 Web UI。
- 请求诊断日志与可选脱敏追踪。
- CCR profile 迁移工具。
- 图片和文档转换。
- exact count_tokens capability 与供应商原生 token count endpoint。
- 默认关闭的 `/v1/models` 发现能力。

这些能力不应提前破坏第一期的核心边界：单实例、多 profile、按请求隔离。

## 29. 协议与成熟实现参考

以下官方链接是 wire protocol 依据，不代表本方案依赖或部署任何官方网关产品。

Claude Code：

- LLM Gateway Protocol：
  https://code.claude.com/docs/en/llm-gateway-protocol
- Environment Variables：
  https://code.claude.com/docs/en/env-vars
- Model Configuration：
  https://code.claude.com/docs/en/model-config

OpenAI：

- Chat Completions Create API：
  https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
- Function Calling：
  https://developers.openai.com/api/docs/guides/function-calling

Anthropic：

- Messages API：
  https://platform.claude.com/docs/en/api/messages/create
- Streaming Messages：
  https://platform.claude.com/docs/en/build-with-claude/streaming
- Count Message Tokens：
  https://platform.claude.com/docs/en/api/messages/count_tokens

参考实现：

- LiteLLM：
  https://github.com/BerriAI/litellm/tree/bf02a4a47f08ad8007a24c8da2ffa8de1a1d36a2
- claude-code-router 3.0.10：
  https://github.com/musistudio/claude-code-router/tree/3c27b7f9122eae906aaeceaeb05e401b3cb246a5
- `@the-next-ai/ai-gateway@1.0.6`：由 claude-code-router 3.0.10 的 package dependency 与发布包 source map 核对。

本文最后一次按 Claude Code、Anthropic、OpenAI 官方文档及上述参考实现核对日期：2026-07-10。
