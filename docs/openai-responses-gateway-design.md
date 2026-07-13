# multi-ccp 内置网关 OpenAI Responses 上游协议设计

## 1. 文档状态

本文记录 multi-ccp `0.3.0` 已实现的内置网关第二阶段设计：在保留 OpenAI Chat Completions 兼容路径的同时，新增 OpenAI Responses 上游协议，并让 OpenAI official、xAI 与 AICodeMirror 内置 Upstream 模板默认使用 Responses。

本文是 [`builtin-openai-gateway-plan.md`](./builtin-openai-gateway-plan.md) 的增量设计，不改变该文档已经落地的共享进程、Profile Binding、请求快照、凭据隔离、热加载、客户端断连取消和 Anthropic Messages 入口等基本架构；原文档的 Chat-only 范围说明以本文为准。

### 1.1 已确认事实

1. Claude Code 仍通过 Anthropic Messages API 调用本地网关：`POST /p/<profile>/v1/messages`。
2. 本阶段只改变网关访问上游供应商时的 wire protocol；网关不对客户端暴露 OpenAI `/v1/responses`。
3. 当前实现同时支持 `openai_chat_completions` 与 `openai_responses`，并通过 Upstream 的 `protocol` 字段进行运行时分发。
4. OpenAI official、xAI 与 AICodeMirror 新建内置 Upstream 时默认使用 Responses；供应商实际兼容范围仍由所选模型和 endpoint 决定。
5. 已存在的 Upstream 不静默迁移，仍按其已保存的 Chat Completions 配置运行。

### 1.2 目标版本

该功能改变持久化配置、运行时分发和协议转换，按 `0.3.0` 功能发布，而不是 patch 版本。

## 2. 目标与非目标

### 2.1 目标

- 支持以下两种上游协议并存：
  - `openai_chat_completions`
  - `openai_responses`
- OpenAI official、xAI、AICodeMirror 新建模板默认使用 Responses。
- Custom Upstream 可选择 Responses 或 Chat Completions。
- 支持 Responses 的非流式文本、流式文本、自定义函数工具调用、并行函数调用、usage、structured output、reasoning effort、错误与取消。
- 复用现有 `CanonicalRequest`、`CanonicalResponse`、`CanonicalStreamEvent` 和 `AnthropicSseEmitter`。
- 保持请求级 Profile、模型、API key、工具名映射、AbortController、日志和流状态隔离。
- 读取旧的 Upstream v1 配置时保持原有行为。

### 2.2 第一阶段非目标

- 不让本地网关对外提供 OpenAI `/v1/responses`。
- 不代理 `GET/DELETE /v1/responses/{id}`。
- 不使用 `previous_response_id`，不在网关保存供应商 response ID。
- 不透传 OpenAI/xAI 的服务端工具，例如 `web_search`、`x_search`、file search、computer use。
- 不映射 citations、annotations、音频、图片生成、文件等 Claude Code 当前无法直接消费的 output item。
- 不自动探测供应商是否支持 Responses。
- 不自动把用户已有 Chat Upstream 改为 Responses。
- 不把 Responses 和 Chat 的兼容字段混成一套不断增长的布尔开关。
- 不将 Responses reasoning / summary 映射为 Anthropic thinking 块（见后续 P1 设计：[`responses-reasoning-to-anthropic-thinking.md`](./responses-reasoning-to-anthropic-thinking.md)）。

## 3. 总体架构

```text
Claude Code
  -> Anthropic Messages request
  -> anthropic-source.ts
  -> CanonicalRequest
  -> protocol dispatch
       -> openai-chat-target.ts
       -> openai-responses-target.ts
  -> upstream provider
  -> protocol-specific response / SSE parser
  -> CanonicalResponse / CanonicalStreamEvent
  -> Anthropic JSON / AnthropicSseEmitter
  -> Claude Code
```

必须保留 canonical 层。禁止在 `server.ts` 内直接拼装 Responses JSON，也禁止在 Responses converter 内直接输出 Anthropic SSE 字符串。

### 3.1 文件边界

建议逐步形成以下结构：

```text
src/gateway/
  anthropic-source.ts
  canonical.ts
  openai-chat-target.ts       # 由现有 openai-target.ts 重命名或保留兼容导出
  openai-responses-target.ts  # 新增：request / non-stream response
  streaming.ts                # 通用 SseParser + AnthropicSseEmitter
  openai-chat-streaming.ts    # 可选：迁移现有 Chat converter
  openai-responses-streaming.ts
  server.ts                   # 只做协议分发、I/O、取消、日志
```

第一批实现可以暂不重命名 `openai-target.ts`，避免一次提交混入无行为重构；但新增代码必须放在独立的 `openai-responses-target.ts` 中。

## 4. 持久化配置模型

### 4.1 协议判别类型

```ts
export type GatewayUpstreamProtocol =
  | "openai_chat_completions"
  | "openai_responses";
```

建议把新配置写为 v2，并使用统一字段 `endpointUrl`：

```ts
export interface GatewayUpstreamConfigV2 {
  version: 2;
  id: string;
  provider: GatewayProvider;
  protocol: GatewayUpstreamProtocol;
  endpointUrl: string;
  models: string[];
  compatibility: GatewayProtocolCompatibility;
}
```

`endpointUrl` 表示完整 POST endpoint，不表示 base URL。这样运行时无需猜测路径，UI 也能清楚展示实际请求目标。

### 4.2 兼容配置必须按协议判别

当前 `GatewayCompatibility` 主要描述 Chat 方言。建议拆分：

```ts
export type GatewayProtocolCompatibility =
  | {
      protocol: "openai_chat_completions";
      instructionRole: "system" | "developer";
      maxTokensField: "max_tokens" | "max_completion_tokens";
      supportsStop: boolean;
      supportsSampling: boolean;
      parallelToolCalls: "supported" | "unsupported";
      streamUsage: "include" | "omit";
      reasoningEffort: "reasoning_effort" | "output_config" | "omit";
      structuredOutput: "response_format" | "output_config" | "unsupported";
    }
  | {
      protocol: "openai_responses";
      instructions: "instructions" | "system_input";
      maxOutputTokens: "max_output_tokens";
      supportsStop: false;
      supportsSampling: boolean;
      parallelToolCalls: "supported" | "unsupported";
      reasoningEffort: "reasoning.effort" | "omit";
      structuredOutput: "text.format" | "unsupported";
      store: false;
    };
```

具体供应商若存在 Responses 方言差异，应只添加经过官方文档或契约测试证明的字段，不能复用 Chat 字段名来表达不同语义。

### 4.3 v1 读取兼容

现有文件结构为：

```json
{
  "version": 1,
  "protocol": "openai_chat_completions",
  "chatCompletionsUrl": "https://example.com/v1/chat/completions"
}
```

读取策略：

1. `version: 1` 只允许 `openai_chat_completions`。
2. 在内存中规范化为 v2 shape：
   - `endpointUrl = chatCompletionsUrl`
   - Chat compatibility 原样校验。
3. 单纯读取不改写磁盘文件。
4. 用户编辑并保存旧 Upstream 时写为 v2。
5. 不依据 hostname 或 URL 自动把 v1 迁移为 Responses。
6. API key secret 文件仍为 v1；其结构没有变化，不需要升级。

Profile metadata 继续只保存：

```json
{
  "upstreamId": "openai",
  "model": "gpt-..."
}
```

因此 Profile 不需要迁移。`GatewayProfileConfig` 是运行时派生快照，应从 Upstream 的 protocol/endpoint 生成。

### 4.4 服务协议版本

`GATEWAY_PROTOCOL_VERSION` 表示本地进程健康协议。若旧 CLI 可能连接到不认识 Responses 配置的旧后台进程，应在发布时从 `1` 提升到 `2`，使生命周期检查重启不兼容的旧进程。

## 5. Endpoint 与内置模板

所有模板存储完整 endpoint：

| 模板 | protocol | endpointUrl |
|---|---|---|
| OpenAI official | `openai_responses` | `https://api.openai.com/v1/responses` |
| xAI Grok | `openai_responses` | `https://api.x.ai/v1/responses` |
| AICodeMirror | `openai_responses` | `https://api.aicodemirror.com/api/codex/backend-api/codex/v1/responses` |
| Custom Responses | `openai_responses` | 用户填写完整 `/responses` endpoint |
| Custom Chat Completions | `openai_chat_completions` | 用户填写完整 `/chat/completions` endpoint |

AICodeMirror 已确认 base URL 为：

```text
https://api.aicodemirror.com/api/codex/backend-api/codex/v1
```

因此 Responses endpoint 为：

```text
https://api.aicodemirror.com/api/codex/backend-api/codex/v1/responses
```

### 5.1 URL 校验

实现通用的 `normalizeGatewayEndpoint(protocol, provider, value)`：

- 只允许 `http:` / `https:`。
- 禁止 username/password。
- query 参数名含 `key|token|secret|authorization` 时拒绝。
- 清除 fragment。
- official OpenAI 固定为其官方 endpoint。
- Responses URL 必须以 `/responses` 结束。
- Chat URL 必须以 `/chat/completions` 结束。
- 对自定义 base URL 可以在 UI 中辅助补全，但核心 validator 不应把一个明确的错误协议路径悄悄改成另一协议；例如选择 Responses 却填写 `/chat/completions` 应直接报错。

## 6. Anthropic 到 Responses 请求映射

### 6.1 基础字段

```text
CanonicalRequest.clientModel       -> 不用于上游路由，仅日志记录
Profile binding model              -> model
CanonicalRequest.system            -> instructions（以 \n 连接）
CanonicalRequest.messages          -> input[]
CanonicalRequest.maxOutputTokens   -> max_output_tokens
CanonicalRequest.stream            -> stream
```

第一阶段所有请求显式发送：

```json
{
  "store": false
}
```

不得发送 `previous_response_id`。

### 6.2 输入 item

建议使用显式 typed input items，而不是只传字符串：

- user text：`message` item，`role: "user"`，内容为 `input_text`。
- assistant text：`message` item，`role: "assistant"`，内容按目标协议允许的文本 content 表达。
- assistant `tool_use`：`function_call` item。
- user `tool_result`：`function_call_output` item。

工具调用关联：

```text
Anthropic tool_use.id
  <-> Responses function_call.call_id
  <-> Anthropic tool_result.tool_use_id
```

必须使用请求局部映射，不能使用全局 Map。若供应商对 `call_id` 字符集有限制，复用 `normalizeToolCallId` 并保存双向映射；否则优先保留原 Anthropic ID，避免后续 tool result 无法关联。

`function_call_output.output` 使用字符串，保持当前 Chat 行为。当 Claude Code 返回多模态 tool result（例如 `Read` 图片文件得到 `image` content block）时，Responses 路径先降级为带媒体类型的文本占位，避免 OpenAI-compatible 上游拒绝 tool-output 内容数组。`is_error: true` 可继续编码为带明确前缀的文本；不得伪造供应商未定义的错误字段。

### 6.3 工具定义

Canonical tool 映射为 Responses function tool：

```json
{
  "type": "function",
  "name": "normalized_name",
  "description": "...",
  "parameters": {},
  "strict": true
}
```

工具名继续复用现有 request-local `ToolNameMapping`。JSON Schema strict 规范化逻辑应抽成共享 helper，避免 Chat 与 Responses 各自实现。

### 6.4 tool_choice 与并行工具

- `auto` -> `"auto"`
- `required` -> `"required"`
- `none` -> `"none"`
- 指定工具 -> `{ "type": "function", "name": "target_name" }`
- `disableParallelToolUse: true` -> `parallel_tool_calls: false`
- 供应商声明不支持并行工具且客户端要求禁用时，按现有策略做显式校验，不静默改变语义。

### 6.5 sampling、stop、reasoning、structured output

- `temperature` / `top_p` 只在模板 capability 允许时发送。
- Responses 第一阶段不发送 `stop`；若 CanonicalRequest 含 stop 且目标协议不支持，应省略并记录 upstream field mapping，或选择严格报错。实现前必须以 OpenAI/xAI/AICodeMirror 契约测试确定统一策略，推荐与现有 compatibility 行为一致。
- effort -> `reasoning: { effort }`；对供应商不支持的 effort 值必须有明确降级或错误规则。
- JSON Schema -> `text.format` 的 Responses 结构；strict schema 继续强制 object 的 `additionalProperties: false` 与完整 `required`。

## 7. Responses 非流式响应映射

解析器只接受成功的 Responses response object，并遍历 typed `output[]`，不依赖便利字段 `output_text`。

### 7.1 支持的 output item

- `message`
  - 遍历 content。
  - `output_text.text` -> canonical text。
  - `refusal.refusal` -> 第一阶段转换为文本内容，同时保留可观测日志；后续可扩展 canonical refusal 类型。
- `function_call`
  - `call_id` -> canonical `tool_use.id`。
  - `name` 经工具名反向映射。
  - `arguments` 必须是能解析为 JSON object 的字符串。

### 7.2 暂不支持的 output item

reasoning、web search、X search、file search、computer use、图片、音频等 item：

- 纯 metadata 且不影响最终回答时可忽略，但必须计入日志中的 `upstreamItemTypes`。
- 包含客户端必须执行的动作但无法映射时，返回 502 `upstream protocol error`。
- 禁止把未知 item 静默转成空成功响应。

### 7.3 finish reason

Responses 完成状态应映射为：

- 存在一个或多个 `function_call` -> `tool_use`
- `status: completed` 且无函数调用 -> `end_turn`
- incomplete details 表示 max output tokens -> `max_tokens`
- failed/cancelled/incomplete 的其他原因 -> 映射为明确 Gateway error，不伪装为正常结束。

### 7.4 usage

```text
usage.input_tokens  -> inputTokens
usage.output_tokens -> outputTokens
```

若字段缺失，按当前 canonical 默认值记 0；字段为负数、非整数或错误类型时应按协议错误处理还是容错，必须由契约测试固定。推荐对存在但非法的值报协议错误，对完全缺失的 usage 容错为 0。

## 8. Responses SSE 映射

复用 `SseParser` 和 `AnthropicSseEmitter`，新增 `OpenAIResponsesStreamConverter`。Converter 只输出 `CanonicalStreamEvent`。

至少处理：

| Responses event | Canonical event |
|---|---|
| `response.created` / `response.in_progress` | 首次获得 response ID 时 `message_start` |
| `response.output_item.added`（message） | 记录 item/index，不立即虚构文本 |
| `response.content_part.added`（output_text） | 准备 text block key |
| `response.output_text.delta` | `text_delta` |
| `response.output_text.done` / content part done | `block_stop`，只发送一次 |
| `response.output_item.added`（function_call） | `tool_start` |
| `response.function_call_arguments.delta` | `tool_arguments_delta` |
| `response.function_call_arguments.done` / item done | 校验完整 JSON，随后 `block_stop` |
| `response.completed` | usage + finish |
| `response.incomplete` | 按 incomplete reason 映射 max_tokens 或 error |
| `response.failed` / `response.error` | canonical error |

### 8.1 流状态约束

- 每个 output item 以 provider item ID 或 output index 构造稳定 `blockKey`。
- `message_start` 恰好一次。
- 每个 block 最多一次 start 和 stop。
- 支持文本与多个函数调用 item 交错。
- 每个函数调用独立累积 arguments；完成时必须解析为 JSON object。
- `response.completed` 到达前必须关闭所有已开始 block。
- terminal event 后忽略额外事件。
- EOF 前没有 terminal event 时返回可观察的上游协议错误。
- 客户端断连继续取消 reader 和 upstream fetch。

供应商可能省略某些中间事件或把完整函数参数放在单一事件中。OpenAI、xAI、AICodeMirror 必须分别使用录制 fixture 做契约测试；只允许经过测试的兼容分支。

## 9. 错误、日志与安全

### 9.1 HTTP 错误

现有以下能力继续复用：

- 上游状态码映射。
- 有界错误 body。
- API key、Authorization 和 URL credential 脱敏。
- redirect 禁止自动跟随。
- timeout 与客户端断连区分。

Responses error envelope 与 Chat 可能不同；错误提取器应支持 OpenAI 标准 `error` object，但不能把 response output item 当错误 envelope。

### 9.2 请求日志

日志新增或调整为：

```text
protocol
endpointHost（不记录 query）
upstreamFields
upstreamItemTypes
streamEventTypes（可做有界去重集合）
effortMapping
status / duration / usage
```

继续禁止记录 prompt、response content、function arguments、API key、Authorization header 和 local token。

### 9.3 存储和隐私

第一阶段强制 `store: false`。模板和 UI 要说明网关保持无状态，但供应商仍可能按自身条款保留请求；`store: false` 不能被描述为绝对零保留。

## 10. Runtime 分发

`server.ts` 应先创建协议适配器，再执行共享 I/O：

```ts
const adapter = createUpstreamAdapter(snapshot.config);
const converted = adapter.serialize(canonical);
const upstream = await fetchUpstream(snapshot.config.endpointUrl, converted.body, ...);

if (canonical.stream) {
  return pipeStreamingResponse(res, upstream, adapter.createStreamBridge(converted.context), ...);
}

const response = adapter.parseResponse(parsed, converted.context);
return canonicalResponseToAnthropic(response);
```

建议接口：

```ts
interface GatewayUpstreamAdapter<Context = unknown> {
  serialize(request: CanonicalRequest): {
    body: Record<string, unknown>;
    context: Context;
  };
  parseResponse(input: unknown, context: Context): CanonicalResponse;
  createStreamBridge(context: Context, model: string): CanonicalToAnthropicStreamBridge;
}
```

Adapter context 只保存 request-local 工具名和 call ID 映射，不捕获完整 request 或 secret，避免长生命周期对象意外持有敏感数据。

## 11. CLI、Web API 与 Web UI

### 11.1 CLI

`gateway add/edit` 增加 Protocol 选择：

```text
OpenAI Responses (recommended)
OpenAI Chat Completions (legacy compatibility)
```

随后显示协议对应的 endpoint label 和 placeholder。使用内置模板时 protocol/endpoint 自动填充，用户仍需确认模型与 API key。

### 11.2 Web API

创建和更新 payload 使用：

```json
{
  "protocol": "openai_responses",
  "endpointUrl": "https://api.example.com/v1/responses"
}
```

在一个兼容周期内可读取旧的 `chatCompletionsUrl` 请求字段，但只在 `protocol` 缺失或明确为 Chat 时接受；响应统一返回 `protocol` 和 `endpointUrl`。

### 11.3 Web UI

Upstream editor：

- Preset Template。
- Protocol。
- Endpoint URL（label 随 protocol 改变）。
- Models。
- API Key。
- Protocol-specific Compatibility。

列表增加协议 badge，避免用户只从 URL 猜测。

切换 protocol 时：

- 内置模板同步替换 endpoint 与 compatibility。
- Custom 不保留另一个协议的 endpoint，防止误提交。
- 编辑已有 Upstream 时必须明确提示协议改变会影响引用它的所有 Profile。
- 不自动修改模型列表；保存前执行协议 URL 校验。

## 12. 实施阶段

### Phase 1：配置与兼容读取

- 添加协议枚举和 v2 config。
- v1 -> 内存 v2 兼容读取。
- protocol-aware endpoint validator。
- 更新 Registry fingerprint 与派生 Profile config。
- 提升 `GATEWAY_PROTOCOL_VERSION`。
- 暂不在模板中启用 Responses。

验收：所有旧测试保持通过；旧 Upstream 文件无需改写即可运行 Chat。

### Phase 2：Responses 非流式

- 新增 request serializer。
- 新增 non-stream response parser。
- server adapter dispatch。
- OpenAI/xAI/AICodeMirror 非流式 fixture 测试。

验收：文本、工具调用、并行工具、usage、错误都能转换；Chat 路径无行为变化。

### Phase 3：Responses 流式

- 新增 Responses stream converter/bridge。
- 覆盖事件分片、工具参数碎片、多个 output item、EOF、failed/incomplete、断连。
- 使用三个供应商的真实录制 fixture（脱敏后提交）。

验收：Claude Code 中流式文本和工具调用可完成一整轮；中途错误不会产生伪成功日志。

### Phase 4：模板与管理界面

- OpenAI、xAI、AICodeMirror 模板默认改为 Responses。
- Custom 增加协议选择。
- CLI、Web API、Web UI 更新。
- 列表和详情显示 protocol。

验收：新建三个内置 Upstream 都使用正确 endpoint；旧 Upstream 保持 Chat。

### Phase 5：端到端与发布

- 三供应商 smoke test。
- 多 Profile 并发隔离。
- Upstream 热更新与协议切换。
- Windows/macOS/Linux 生命周期回归。
- 更新 README、中文 README、changelog 和原网关文档的范围说明。

## 13. 测试计划

### 13.1 单元测试

- `config`：两协议 endpoint 校验、固定 official endpoint、credential query 拒绝。
- `storage`：v1 读取、v2 写入、未知 protocol/version 拒绝、编辑升级。
- `responses protocol`：请求字段、历史消息、工具、tool choice、schema、effort。
- `responses parsing`：多 output item、refusal、tool arguments、usage、未知 item。
- `responses streaming`：所有支持事件、任意 chunk 边界、并行工具、terminal/error/EOF。

### 13.2 集成测试

- 每个 Profile 向自己的 protocol endpoint 和 API key 发请求。
- Chat 与 Responses Profile 并发运行，互不共享 adapter state。
- Upstream 从 Chat 切到 Responses 后只影响后续请求；在途请求继续使用旧 snapshot。
- Responses 请求显式 `store: false`。
- 客户端断连会 abort fetch 并取消 stream reader。
- 日志包含 protocol，不包含内容或 secret。

### 13.3 供应商契约 fixture

当前仓库测试覆盖 mocked Responses 请求分发、解析、流式转换、v1 配置兼容、runtime 迁移、重命名与多模态 tool result 降级；尚未提交公开、脱敏的供应商 live fixture。每个 Responses 模板后续至少保存以下脱敏 fixture：

- 非流式文本。
- 流式文本。
- 单工具调用。
- 并行工具调用。
- usage。
- 400/401/429/500 error。
- 流中失败或非正常 EOF（供应商能产生时）。

Fixture 必须记录抓取日期、模型、endpoint、是否 `store: false`，但不得包含真实 key、用户 prompt 或敏感工具参数。

## 14. 完成标准

`0.3.0` 已满足代码级 Responses 支持所需的双协议分发、v1/v2 配置兼容、请求/响应转换、流式转换、隔离、错误日志和文档更新要求。若要宣称某个外部供应商模板具备完整实测覆盖，还应满足以下 live smoke / fixture 条件：

1. Chat Completions 现有 107+ 回归测试保持通过。
2. v1 Upstream 无需手动迁移即可继续工作。
3. OpenAI、xAI、AICodeMirror Responses 的非流式文本、流式文本与至少一轮工具调用通过真实 smoke test。
4. Claude Code 能使用三个模板分别完成普通对话和工具调用。
5. 并发 Chat/Responses Profiles 不发生模型、凭据、call ID 或流状态串线。
6. 已有 Profile 引用 Upstream 时，协议切换后的失败信息可读且不会损坏 Profile binding。
7. 未知或不支持的 Responses output item 不会导致空成功响应。
8. 所有请求显式 `store: false`，且日志不泄露内容或凭据。
9. Web UI 和 CLI 明确展示协议及完整 endpoint。
10. README 明确说明“OpenAI-compatible”不等于自动支持 Responses；能力由所选 protocol 和供应商决定。

## 15. 开发前必须确认的问题

以下问题不阻塞本文主体架构，但在编码对应功能前必须形成明确决策并补测试：

1. AICodeMirror 对 Responses structured output、reasoning effort、sampling 和 SSE 工具参数事件的精确兼容范围。
2. xAI 流式 function call 是参数 delta 还是单个完整事件；实现应以当前官方文档与真实 fixture 为准。
3. OpenAI/xAI/AICodeMirror 在 `store: false` 下的实际响应字段差异。
4. stop sequence 在三个 Responses 实现中的支持策略。
5. refusal 是暂时降级为文本，还是扩展 canonical/Anthropic 映射。
6. protocol switch 是否需要二次确认以及是否阻止在该 Upstream 有活动请求时保存；推荐只影响后续 snapshot，不跟踪活动请求。

## 16. 参考资料

- [OpenAI Responses API reference](https://platform.openai.com/docs/api-reference/responses)
- [OpenAI：从 Chat Completions 迁移到 Responses](https://platform.openai.com/docs/guides/migrate-to-responses)
- [OpenAI Responses 流式指南](https://platform.openai.com/docs/guides/streaming-responses)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [xAI 文本生成与 Responses](https://docs.x.ai/developers/model-capabilities/text/generate-text)
- [xAI Function Calling](https://docs.x.ai/developers/tools/function-calling)
- [xAI Web Search Responses 示例](https://docs.x.ai/developers/tools/web-search)
- [xAI X Search Responses 示例](https://docs.x.ai/developers/tools/x-search)
- [现有内置网关设计](./builtin-openai-gateway-plan.md)

AICodeMirror 的支持能力与 endpoint 来自项目维护者确认；实现阶段应补充可公开访问的官方说明链接或以脱敏契约 fixture 固化实际行为。
