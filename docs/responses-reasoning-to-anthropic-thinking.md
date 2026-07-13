# Responses Reasoning → Anthropic Thinking 映射设计（P1）

## 1. 文档状态

本文是 `0.3.0` 未包含的后续设计，定义 multi-ccp 内置网关在 **OpenAI Responses / xAI Responses** 上游协议下，将供应商 **reasoning** 输出映射为 Claude Code 可消费的 **Anthropic Messages thinking 内容块** 的开发契约。当前已发布/待发布的 Responses 支持会忽略 reasoning summary，不会映射为 Anthropic thinking。

本文是 [`openai-responses-gateway-design.md`](./openai-responses-gateway-design.md) 的后续增量，**不改变**已落地的：

- Anthropic Messages 客户端入口（`POST /p/<profile>/v1/messages`）
- 双上游协议分发（`openai_chat_completions` / `openai_responses`）
- `store: false`、凭据隔离、请求快照、断连取消
- P0 已落地的 `toolStrict` 默认 `non_strict` 与 SSE keepalive 容错

### 1.1 当前实现基线（写作时）

| 层 | 现状 |
|---|---|
| `anthropic-source.ts` | 请求含 `thinking` 顶层字段时 **直接 400**（`thinking is not supported by this gateway profile`） |
| `canonical.ts` | 无 thinking 内容类型；`CanonicalStreamEvent` 无 thinking 事件 |
| `openai-responses-target.ts` | 非流式 `output[]` 中 `type === "reasoning"` **丢弃** |
| `openai-responses-streaming.ts` | `response.reasoning_*` 与 reasoning item **忽略**（P0 后不 fail，但也不映射） |
| `AnthropicSseEmitter` | 只发 text / tool_use 相关 content block |
| Profile 环境 | 多个 gateway profile 默认 `CLAUDE_CODE_DISABLE_THINKING=1`、`MAX_THINKING_TOKENS=0` |

### 1.2 目标版本

该功能扩展 canonical IR、流式 emitter 与 Responses 解析路径，未随 `0.3.0` 发布；后续可作为 `0.3.x` 增量或 `0.4.0`（若引入配置字段变更）单独规划。

---

## 2. 问题陈述

### 2.1 用户可见现象

在 Grok-4.5 等 **有思维链 / reasoning summary** 的 Responses 模型上：

1. 上游 SSE 实际包含 `response.reasoning_summary_*` 与 `output_item type=reasoning`
2. 网关为容错忽略这些事件
3. Claude Code 终端只看到最终 `text`，**无法渲染 Chain of Thought**

### 2.2 实测上游形态（控制变量与抓包）

**xAI / suoxie Responses（grok-4.5）** 常见序列：

```text
response.created
response.in_progress
response.output_item.added          item.type = reasoning
response.reasoning_summary_part.added
response.reasoning_summary_text.delta   × N
response.reasoning_summary_text.done
response.reasoning_summary_part.done
response.output_item.done           item.type = reasoning
response.output_item.added          item.type = message
response.output_text.delta          × N
response.completed
```

**OpenAI / AICodeMirror 兼容路径** 可能仅有：

```text
response.output_item.added/done     item.type = reasoning
  （summary 为空，或仅有 encrypted_content）
response.output_item.added          item.type = message
...
```

### 2.3 官方协议要点（实现前必须遵守）

#### Anthropic Messages（客户端侧）

- Thinking 以 **content block** 出现：`type: "thinking"`，字段 `thinking`（文本）与可选 `signature`
- 流式：
  - `content_block_start` → `content_block: { type: "thinking", thinking: "", signature: "" }`
  - `content_block_delta` → `delta: { type: "thinking_delta", thinking: "..." }`
  - 可能随后 `delta: { type: "signature_delta", signature: "..." }`
  - `content_block_stop`
- Extended thinking + tool use：
  - 仅 `tool_choice: auto|none` 与 thinking 兼容
  - 多轮时需原样回传上一轮 assistant 的 thinking 块；篡改会 400
- 参考：[Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)

#### OpenAI Responses（上游侧）

- Reasoning 是 **独立 output item / 独立 SSE 事件族**，不得并入 `output_text`
- 常见事件：
  - `response.reasoning_summary_part.added|done`
  - `response.reasoning_summary_text.delta|done`（含 `summary_index`）
  - `response.reasoning_text.delta|done`（含 `content_index`，部分模型）
- 请求侧 `reasoning: { effort, summary? }`；summary 需 opt-in 才有可读摘要
- `store: false` 时若要跨轮保留 reasoning，需 `include: ["reasoning.encrypted_content"]` 并回传 encrypted item（**本 P1 默认不实现跨轮 encrypted 回传**）
- 参考：[Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)、[Reasoning](https://developers.openai.com/api/docs/guides/reasoning)

#### xAI Grok Responses

- OpenAI 兼容 `base_url` + Responses
- 文档确认流式：`response.reasoning_text.delta`、`response.reasoning_summary_text.delta`
- effort 映射：`reasoning.effort`（low/medium/high 等，模型相关）
- 参考：[xAI reasoning](https://docs.x.ai/docs/guides/reasoning)、[generate text](https://docs.x.ai/developers/model-capabilities/text/generate-text)

---

## 3. 目标与非目标

### 3.1 目标

1. 当上游 Responses 产生 **可读 reasoning summary / reasoning text** 时，Claude Code 能在同一轮流式响应中看到 **thinking 块**（若客户端未禁用 thinking UI）。
2. 非流式 JSON 响应中，assistant `content` 可包含 `thinking` 块（在 text / tool_use 之前，顺序与 Anthropic 惯例一致）。
3. 保持 canonical 层：Responses converter → `CanonicalStreamEvent` → `AnthropicSseEmitter`，禁止在 Responses 文件内直接拼 Anthropic SSE 字符串。
4. 无 reasoning 的上游路径行为不变（零回归）。
5. 可通过 compatibility / profile 开关关闭映射（默认策略见 §6）。
6. 日志只记录事件类型与开关状态，**不记录** thinking 正文、signature、encrypted_content。

### 3.2 非目标（本 P1）

- 不实现 Anthropic 原生 `thinking: { type: "enabled", budget_tokens }` 请求完整语义机（见 §6.2 的最小请求策略）。
- 不实现 `redacted_thinking` 往返。
- 不实现 `store: false` 下的 **encrypted reasoning 跨轮回传**（`include: ["reasoning.encrypted_content"]` + 历史 item 重放）。
- 不把 reasoning 写入 Chat Completions 路径（除非后续单独评估 `reasoning_content` 方言）。
- 不保证 Claude Code UI 在 `CLAUDE_CODE_DISABLE_THINKING=1` 时仍显示思维链。
- 不伪造 Anthropic `signature` 校验通过（见 §5.4）。
- 不透传供应商原始 encrypted blob 给 Claude Code（安全与体积）。

---

## 4. 总体架构

```text
Upstream Responses SSE / JSON
  -> OpenAIResponsesStreamConverter / parseOpenAIResponsesResponse
  -> Canonical thinking events / blocks
  -> AnthropicSseEmitter / canonicalResponseToAnthropic
  -> Claude Code (thinking content blocks)
```

### 4.1 文件边界

| 文件 | 变更 |
|---|---|
| `src/gateway/canonical.ts` | 扩展 response content + stream events |
| `src/gateway/openai-responses-streaming.ts` | 将 reasoning 事件转为 thinking stream events（不再一律 ignore） |
| `src/gateway/openai-responses-target.ts` | 非流式 reasoning item → thinking block |
| `src/gateway/streaming.ts` | `AnthropicSseEmitter` 支持 thinking start/delta/signature/stop |
| `src/gateway/utils.ts` | `canonicalResponseToAnthropic` 输出 thinking 块 |
| `src/gateway/anthropic-source.ts` | 最小请求策略：接受或降级 `thinking` 字段（§6.2） |
| `src/core/types.ts` + config / CLI / Web | 可选 `reasoningVisibility` compatibility 字段 |
| tests | protocol + streaming + server 契约 |

### 4.2 必须保留的不变量

1. `message_start` 恰好一次，且在任何 content block 之前。
2. 每个 blockKey 最多一次 start、一次 stop。
3. thinking 块与 text / tool_use 块可交错，但 **同一 reasoning item 的 summary 应聚合到同一 thinking blockKey**（除非多 summary_index 明确需要拆分，默认合并）。
4. terminal 后忽略后续事件。
5. 未知 **可执行** output item 仍 fail-closed；纯 reasoning 永不导致空成功。

---

## 5. Canonical IR 扩展

### 5.1 响应内容

```ts
export type CanonicalResponseContent =
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
```

顺序约定：

1. 所有 thinking 块（若有）
2. text 块
3. tool_use 块

（若上游交错产生 text 与后续 reasoning，流式按到达顺序发射；非流式解析时按 `output[]` 顺序，但可配置「thinking 提升到 content 前部」以贴合 Anthropic 常见形态，默认 **保持 output 顺序**。）

### 5.2 流式事件

```ts
export type CanonicalStreamEvent =
  | { type: "message_start"; id: string; model: string }
  | { type: "thinking_start"; blockKey: string }
  | { type: "thinking_delta"; blockKey: string; thinking: string }
  | { type: "thinking_signature"; blockKey: string; signature: string } // 可选
  | { type: "text_start"; blockKey: string }
  | { type: "text_delta"; blockKey: string; text: string }
  | { type: "tool_start"; blockKey: string; id: string; name: string }
  | { type: "tool_arguments_delta"; blockKey: string; partialJson: string }
  | { type: "block_stop"; blockKey: string }
  | { type: "usage"; usage: CanonicalUsage }
  | { type: "finish"; reason: CanonicalFinishReason }
  | { type: "error"; error: GatewayError };
```

### 5.3 Anthropic SSE 映射

| Canonical | Anthropic SSE |
|---|---|
| `thinking_start` | `content_block_start` + `content_block: { type: "thinking", thinking: "", signature: "" }` |
| `thinking_delta` | `content_block_delta` + `delta: { type: "thinking_delta", thinking }` |
| `thinking_signature` | `content_block_delta` + `delta: { type: "signature_delta", signature }` |
| `block_stop`（thinking） | `content_block_stop` |

非流式：

```json
{
  "type": "thinking",
  "thinking": "...",
  "signature": "..." // 可选，见 §5.4
}
```

### 5.4 Signature 策略（关键决策）

Anthropic 的 `signature` 用于 **多轮回传完整性校验**。上游 OpenAI/xAI 的 signature / encrypted_content **不是** Anthropic signature。

| 策略 | 行为 | 推荐 |
|---|---|---|
| A. 省略 signature | thinking 块仅有文本；多轮若客户端回传可能被 Anthropic 官方 API 拒绝，但 **本地网关** 可选择不校验 | **默认** |
| B. 透传上游 encrypted 为 signature | 语义错误，体积大，可能泄露供应商内部格式 | 禁止 |
| C. 网关自签 HMAC | 仅对本网关多轮校验有意义；Claude Code 未必回传 | 可选后续 |

**P1 默认采用 A**：输出无 signature 的 thinking 块。
若 Claude Code 在 tool loop 中回传 thinking 且网关再次收到，**请求解析侧**应：

- 接受 assistant 历史中的 `thinking` content block（今天可能被 strip/reject，需放宽）
- **不**要求 signature
- **不**把 thinking 文本转发为上游 reasoning item（无加密上下文时无法安全复原）；上游侧继续只靠 `instructions` + 消息历史文本

多轮 tool loop 的保真度限制必须在 README / 本设计中写明。

---

## 6. 配置与请求策略

### 6.1 Compatibility 字段

在 `GatewayResponsesCompatibility` 增加：

```ts
/**
 * How to surface upstream reasoning to the Anthropic client.
 * - omit: ignore readable reasoning (current P0 behavior for events; still don't fail)
 * - thinking: map summary/text to Anthropic thinking blocks
 */
reasoningVisibility: "omit" | "thinking";
```

默认建议：

| 模板 / provider | 默认 |
|---|---|
| OpenAI official Responses | `thinking`（若模型常返回 summary）或 `omit` 更保守 |
| xAI / 自定义代理 | **`thinking`**（Grok 用户痛点） |
| 旧 config 缺字段 | merge 为 **`omit`**（避免静默改变已有部署行为） |

> 推荐：**新模板默认 `thinking`，读取旧 config 缺省 `omit`**。实现时用 `mergeGatewayProtocolCompatibility` 明确 default，并在 changelog 写清。

### 6.2 客户端 `thinking` 请求字段

今日：顶层 `thinking` → 400。

P1 最小策略（二选一，实现时固定一种并测）：

**策略 S1（推荐，改动小）**

- 继续 **拒绝** Anthropic 原生 `thinking: { type, budget_tokens }` 完整控制面
- 仅根据 **upstream compatibility.reasoningVisibility** 与 **已有 `output_config.effort` → reasoning.effort** 决定是否映射
- 文档说明：网关 thinking 显示由 upstream 配置控制，不由 Anthropic thinking budget 控制

**策略 S2（更贴近 Claude Code）**

- 接受 `thinking: { type: "enabled" | "disabled" | "adaptive", ... }` 的子集
- `disabled` → 本请求强制 `reasoningVisibility=omit`
- `enabled/adaptive` → 允许映射；`budget_tokens` **不**转译为供应商字段（或仅 log）
- 与 `CLAUDE_CODE_DISABLE_THINKING` 的交互由客户端环境负责

**建议首版实现 S1**，避免半吊子 budget 语义。

### 6.3 请求侧已有 effort 映射

保持现有：

```text
CanonicalRequest.outputConfig.effort
  -> body.reasoning = { effort }
  （当 compatibility.reasoningEffort === "reasoning.effort"）
```

P1 可选增强（非必须）：

```text
reasoningVisibility === "thinking"
  -> body.reasoning.summary = "auto" | "detailed"   // 仅当供应商文档支持
```

注意：

- 部分模型 / 代理忽略 `summary`
- xAI 可能始终返回 detailed summary
- 不支持的字段不得导致请求失败：应用 capability 开关，默认 **不发送 summary**，仅映射「上游已经返回」的文本

### 6.4 Profile 环境变量

网关 **不自动修改** profile 的：

- `CLAUDE_CODE_DISABLE_THINKING`
- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING`
- `MAX_THINKING_TOKENS`

但文档与 UI 应提示：

> 若需在 Claude Code 中看到思维链，请关闭 profile 中的 thinking 禁用项，并确保 upstream `reasoningVisibility=thinking`。

可选后续：gateway profile 创建向导增加「启用思维链显示」一键模板。

---

## 7. 流式映射细则

### 7.1 事件处理表

| Upstream event | 行为 |
|---|---|
| `response.output_item.added` `type=reasoning` | 记录 item 状态；**不**立即 start thinking（等有文本） |
| `response.reasoning_summary_part.added` | 绑定 `item_id` + `summary_index`；可 start thinking block |
| `response.reasoning_summary_text.delta` | `thinking_delta`（合并到该 item 的 blockKey） |
| `response.reasoning_summary_text.done` | merge 全文一致性检查（同 text done）；不强制 stop |
| `response.reasoning_summary_part.done` | 可选 stop 该 part；默认保持 block 开直到 item done |
| `response.reasoning_text.delta/done` | 与 summary 相同处理通道，或优先 summary、其次 raw text（§7.2） |
| `response.output_item.done` `type=reasoning` | 若已 start 则 `block_stop`；若全程无文本则不产生 thinking 块 |
| 仅 encrypted、无文本 | 不产生 thinking 块；metadata 记 `reasoningEncryptedOnly` |

### 7.2 Summary vs raw reasoning text 优先级

```text
if summary deltas/text present:
  map summary only
else if reasoning_text deltas/text present:
  map reasoning_text
else:
  no thinking block
```

禁止把 encrypted_content 当文本解码。

### 7.3 blockKey 稳定规则

```text
blockKey = `reasoning:${itemId}`
         或 `reasoning:output:${outputIndex}`（无 id 时）
```

多个 `summary_index`：**默认合并到同一 blockKey**（单 thinking 块更符合 Claude Code 阅读体验）。
若未来需要分块，再引入 `reasoning:${itemId}:s${summaryIndex}`。

### 7.4 与 text / tool 交错

允许：

```text
thinking... -> text...
thinking... -> tool_use...
thinking... -> tool_use... -> text...   // 少见，按到达顺序
```

`finishSuccess` 时关闭所有未 stop 的 thinking/text/tool 块。

### 7.5 错误与不完整

- `response.incomplete` + 已有 thinking：正常关闭 thinking 块后按现有 incomplete 映射
- 流中途 error：不要求 thinking 完整
- thinking 中途上游只给 encrypted：不报错，无 thinking 输出

### 7.6 从 P0 ignore 列表移除的类型

当 `reasoningVisibility === "thinking"` 时，**不得**再把下列类型当作 ignorable no-op：

- `response.reasoning_summary_*`
- `response.reasoning_text_*`

`reasoningVisibility === "omit"` 时保持 P0 行为（ignore，不 fail）。

---

## 8. 非流式映射细则

遍历 `response.output[]`：

```text
for item in output:
  if item.type == "reasoning":
    text = join(item.summary[*].text) or join(item.content reasoning_text)
    if text non-empty:
      content.push({ type: "thinking", thinking: text })
    continue
  if item.type == "message": ... existing
  if item.type == "function_call": ... existing
```

`upstreamItemTypes` 仍记录 `reasoning`。

空 reasoning + 空 message + 无 tool → 仍按现有规则报「无可表示输出」。

---

## 9. Chat Completions 路径

本 P1 **不**映射 Chat 的 `delta.reasoning_content` / 供应商私有字段。

若后续需要：

- 单独设计 `openai-chat-streaming` reasoning 方言
- 不得与 Responses 事件模型混用同一 parser

---

## 10. 安全、隐私与日志

1. thinking 正文、signature、encrypted_content **禁止**写入 gateway.log。
2. 允许日志字段：
   - `reasoningVisibility`
   - `upstreamEventTypes`（已有）
   - `upstreamItemTypes`（已有）
   - `thinkingBlocks: number`（可选计数）
   - `reasoningEncryptedOnly: boolean`
3. 不因 thinking 增大而放宽 max body；thinking 只存在于上游→客户端方向。
4. 用户应知晓：思维链可能含敏感推理；显示即等于进入客户端 UI/会话存储。

---

## 11. 实施阶段

### Phase A：IR + Emitter（无上游行为变化）

1. 扩展 `CanonicalStreamEvent` / `CanonicalResponseContent`
2. `AnthropicSseEmitter` + `canonicalResponseToAnthropic` 支持 thinking
3. 单元测试：emitter 事件序、非流式 JSON 形状
4. 默认仍不从 Responses 产生 thinking（feature 未接线）

验收：旧测试全绿；新 emitter 单测绿。

### Phase B：Responses 流式映射

1. `OpenAIResponsesStreamConverter` 按 §7 实现
2. `reasoningVisibility` 接入 compatibility 默认/merge/校验
3. Fixture：xAI 风格 summary deltas；OpenAI 风格仅 item；encrypted-only；与 text/tool 交错；keepalive 并存
4. 真实 smoke：`xai` profile 长 reasoning 请求，确认 Claude SSE 含 `thinking_delta`

验收：`reasoningVisibility=thinking` 时 Grok 可见 thinking；`omit` 时与 P0 相同。

### Phase C：非流式 + 配置面

1. `parseOpenAIResponsesResponse` 映射 reasoning item
2. CLI / Web advanced：`reasoningVisibility` 选择
3. 模板默认值（§6.1）
4. 旧 config 缺省 `omit`

### Phase D：请求侧与文档（可选）

1. 策略 S1 或 S2
2. 放宽 assistant 历史中 thinking block 的解析（若 anthropic-source 当前丢弃）
3. README / 中文 README：如何开启思维链显示
4. Profile 向导提示关闭 `CLAUDE_CODE_DISABLE_THINKING`

---

## 12. 测试计划

### 12.1 单元

- Emitter：thinking start/delta/signature/stop 顺序；thinking 后 text；重复 blockKey 失败
- Converter：§7 全表；encrypted-only 无块；omit 模式忽略；thinking 模式不 ignore summary
- Non-stream：summary 数组拼接；空 reasoning 跳过
- Compatibility：缺省 merge、非法值拒绝

### 12.2 集成

- server 流式：mock 上游 SSE 含 reasoning_summary → 客户端收到 thinking_delta
- 与 P0 keepalive 同流不失败
- tool_use 前 thinking 不破坏 tool 参数 JSON 校验
- 并发 profile 隔离

### 12.3 真实供应商 smoke（脱敏）

| 上游 | 模型 | 期望 |
|---|---|---|
| xai / suoxie Responses | grok-4.5 | 有 thinking 文本 + 最终答案 |
| aicodemirror Responses | gpt-5.x | 有 reasoning item 时：有文本则 thinking，仅 encrypted 则无 |
| gpt-sx Responses | gpt-5.x | 同上 |

记录：`upstreamEventTypes`、是否 `thinkingBlocks>0`、客户端 env 是否禁用 thinking。

---

## 13. 完成标准

1. `reasoningVisibility=thinking` 时，xAI Grok Responses 流式响应在 Anthropic SSE 中出现至少一段 `thinking_delta`（上游提供 summary 的前提下）。
2. `reasoningVisibility=omit` 或旧配置缺省时，行为与 P0 一致（忽略、不 fail）。
3. 无 reasoning 的文本/工具路径回归全绿。
4. 日志无 thinking 正文 / encrypted 泄露。
5. Claude Code 在 **未禁用 thinking** 的 profile 下可渲染思维链；禁用 profile 下不崩溃。
6. 文档说明 signature 与跨轮限制、profile 环境变量要求。

---

## 14. 风险与开放问题

| # | 问题 | 建议默认 |
|---|---|---|
| 1 | 无 Anthropic 真 signature，tool loop 多轮是否被客户端挑剔 | 先做单轮显示；历史 thinking 透传但不校验 |
| 2 | 是否默认打开 `reasoning.summary` 请求字段 | **否**，只映射上游已返回内容 |
| 3 | 新模板默认 `thinking` 还是 `omit` | 新模板 `thinking`，旧配置 `omit` |
| 4 | raw `reasoning_text` 是否对用户显示（可能冗长/敏感） | summary 优先；无 summary 再显示 raw，可加 maxChars 截断（可选） |
| 5 | Chat Completions `reasoning_content` | 本 P1 不做 |
| 6 | `thinking` 请求字段策略 S1 vs S2 | **S1** |
| 7 | AICodeMirror 仅 encrypted reasoning 时用户期望 | 明确「无可显示摘要」；不伪造 |

---

## 15. 与 P0 的关系

P0 已完成：

- 工具 `toolStrict` 默认 non_strict（复杂 Claude 工具）
- SSE keepalive / 心跳容错

P1 **依赖** P0 的事件容错框架：在 `isIgnorableResponsesStreamEvent` 上改为 **按 visibility 分流**，而不是永久 ignore reasoning 族。

建议实现顺序：先 Phase A（IR/emitter）再 Phase B（converter），避免半开流状态。

---

## 16. 参考资料

- [OpenAI Streaming responses](https://developers.openai.com/api/docs/guides/streaming-responses)
- [OpenAI Reasoning](https://developers.openai.com/api/docs/guides/reasoning)
- [OpenAI Function calling](https://developers.openai.com/api/docs/guides/function-calling)
- [OpenAI Migrate to Responses](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [xAI Reasoning guide](https://docs.x.ai/docs/guides/reasoning)
- [xAI Generate text / store](https://docs.x.ai/developers/model-capabilities/text/generate-text)
- [xAI Function calling](https://docs.x.ai/developers/tools/function-calling)
- [Anthropic Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [Anthropic Tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)
- 既有设计：[openai-responses-gateway-design.md](./openai-responses-gateway-design.md)
- 既有总览：[builtin-openai-gateway-plan.md](./builtin-openai-gateway-plan.md)

---

## 17. 实现备忘（给后续开发者）

当前忽略 reasoning 的代码锚点（实现时搜索并改分流逻辑）：

- `src/gateway/openai-responses-streaming.ts` — `isIgnorableResponsesStreamEvent` 中 `response.reasoning_*`；`processOutputItem` 对 `type === "reasoning"` 的 early return
- `src/gateway/openai-responses-target.ts` — `if (type === "reasoning") return;`
- `src/gateway/anthropic-source.ts` — 顶层 `thinking` 拒绝
- `src/gateway/streaming.ts` — `AnthropicSseEmitter.emit`
- `src/gateway/canonical.ts` — IR 类型
- `src/gateway/utils.ts` — `canonicalResponseToAnthropic`

本地对照 profile：`xai`（Responses + grok-4.5）、`gpt-sx`、`aicodemirror-responses-test`。

测试时注意 profile `settings.json` 中 thinking 相关 env，避免「网关已映射但 UI 关闭」的假阴性。
