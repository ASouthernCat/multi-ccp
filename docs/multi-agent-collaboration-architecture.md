# multi-ccp 多 CLI 实时通讯与智能体协作架构设计 (Agent Mesh Architecture)

## 1. 概述与背景

`multi-ccp` 支持通过独立的 Profile 配置目录运行多个 Claude Code 实例，并通过 `sync-session`（`src/core/sessions.ts`）实现会话日志的事后离线同步。0.4.0 进一步让每个独立 CLI 窗口接入同一个本地协作 Hub，形成面向 Agent CLI 实例的实时通信网络。

为了支持**多终端 CLI 实例在会话运行过程中的实时交互、相互通信与协同编码**，本方案设计了基于 **「MCP 通信总线 + Skills 行为规约 + 本地守护中枢 + PTY 终端唤醒」** 的多智能体动态对等网络架构（Agent Mesh）。

```mermaid
flowchart TD
    subgraph HubLayer ["multi-ccp 守护调度中枢 (依托 127.0.0.1:3921)"]
        Router["消息路由与队列 Message Router"]
        Registry["在线 Peer 注册表与动态名片 Registry"]
        Blackboard["共享工作黑板 Shared Blackboard"]
        Breaker["调用链深度与防死锁熔断器 Deadlock Breaker"]
    end

    subgraph PeerA ["CLI 终端 A (Profile: gpt-5.6)"]
        ClaudeA["Claude Code 实例"]
        MCPA["MCP Client"]
        SkillA["Skill 协作 SOP 规约"]
        ClaudeA <--> MCPA
        ClaudeA -.-> SkillA
        MCPA <-->|HTTP/SSE 长连接| Router
    end

    subgraph PeerB ["CLI 终端 B (Profile: ds-coder)"]
        ClaudeB["Claude Code 实例"]
        MCPB["MCP Client"]
        PTYB["PTY 终端唤醒包装器"]
        ClaudeB <--> MCPB
        MCPB <-->|HTTP/SSE 长连接| Router
        Router -.->|空闲唤醒注入| PTYB
        PTYB -->|stdin: 协作消息| ClaudeB
    end

    subgraph WebDashboard ["ccp ui 可视化监控看板"]
        WebUI["实时协作拓扑 & 消息流看板"]
        WebUI <--> Router
    end

    style HubLayer fill:none,stroke:#666,stroke-width:1px,stroke-dasharray: 4 4
    style PeerA fill:none,stroke:#666,stroke-width:1px
    style PeerB fill:none,stroke:#666,stroke-width:1px
    style WebDashboard fill:none,stroke:#666,stroke-width:1px
```

---

## 2. 核心架构设计理念

### 2.1 动态对等网络 (Dynamic Peer-to-Peer Mesh)，无固定静态角色
* **拒绝固定角色固化**：Profile（如 `work`、`ds-coder`、`gpt-5.6`）仅代表模型配置、API 路由与运行环境，每个 CLI 实例都是 100% 全功能的通用 Coding Agent。
* **实例级身份**：每次打开的独立 CLI 窗口都注册为一个 Peer。默认 `peerId` 为 `<profile>:<pid>`；Profile 名称不是实例身份，也不是协作路由作用域。
* **会话级任务驱动**：每次打开终端开启的都是全新的动态任务会话。Agent 当前的“职责”由用户的即时 Prompt 和上下文动态决定，而非静态配置文件硬编码。
* **动态自声明名片 (Live Context & Focus)**：CLI 在会话推进中自动向调度中枢更新自身的工作焦点（如“正在分析 `auth.ts`”），供其他 Peer 动态感知。

### 2.2 双轨结合：MCP (底层通道) + Skills (思维规约)

| 层次 | 负责模块 | 核心职责 | 为何这样分工 |
| :--- | :--- | :--- | :--- |
| **底层通道 (Action)** | **MCP Server** | 提供强类型工具调用（`ask_peer`, `send_task` 等） | 避免 Bash 权限确认弹窗打断，JSON Schema 强校验，并将前台等待窗口与后台 dispatch 解耦。 |
| **思维规约 (Thought)** | **Skills (SKILL.md)** | 提供协作 SOP、提问规范、防冲突意识 | 约束 LLM 避免无效闲聊，强制三段式结构化提问，指导何时主动协作与降级。 |

---

## 3. 实例作用域与会话生命周期

### 3.1 网络作用域 (Scope)
1. **Gateway 运行时作用域**：所有连接到同一个本地协作 Hub 的 Agent CLI 实例都在同一张 Mesh 中，无论它们由哪个 Profile 启动、位于哪个目录或是否使用相同的 Profile。
2. **实例寻址**：当一个 Profile 只有一个在线实例时可以使用 Profile 名称；存在多个实例时必须使用 `list_peers` 返回的精确 `peerId`，避免把消息发给错误的窗口。
3. **项目字段的边界**：`projectKey` 和 `projectDir` 只用于当前 CLI 的本地会话诊断、文件焦点和上下文交接，不参与协作路由、在线列表过滤或黑板隔离。项目目录不是 Agent Mesh 的作用域。
4. **全局共享黑板**：`share_data` / `get_shared_data` 访问的是 Hub 内唯一的一份运行时键值空间，所有 Agent CLI 可见；Gateway / Hub 重启后黑板内容清空。

### 3.2 会话生命周期 (Session Lifecycle)
* **注册与保活**：CLI 启动协作 SSE 后注册 Peer，持续发送心跳和输入、输出、工具调用活动；连接关闭或心跳长期缺失时标记为 `disconnected`。
* **融入当前活跃会话**：跨 CLI 消息通过 PTY / 控制台注入到目标 CLI 的当前会话，并在终端显示协作提示。
* **活动驱动状态**：收到输入后进入 `waiting` / `processing`，模型持续有活动时保持 `processing`；只有达到无活动阈值才显示 `stalled`，不会因固定思考时长直接结束任务。
* **前台窗口与后台任务分离**：`ask_peer` 的 `wait_window_seconds` 只控制调用方前台等待。窗口结束可以返回 `deferred`，后台 dispatch 继续接受迟到回复。
* **故障接管**：目标 CLI 确认退出、崩溃、卡死或无法回复时，使用 `read_peer_context` 获取有边界且脱敏的交接上下文，再重新检查当前文件状态。

---

## 4. MCP 工具集规范设计 (Tool Schema)

工具集遵循极简、正交设计，提供 5 类核心协作能力；`check_inbox`、`reply_peer`、`update_focus` 与 `notify_supervisor` 用于补全收件、回复、状态和监管更新生命周期：

```mermaid
flowchart LR
    T1["1. list_peers<br/>查询在线同伴与即时焦点"]
    T2["2. ask_peer / reply_peer<br/>同步问答与关联回复"]
    T3["3. send_task / check_inbox<br/>异步派发与离线收件"]
    T4["4. share_data / get_shared_data<br/>共享黑板 KV 读写"]
    T5["5. read_peer_context<br/>读取中断会话并接管工作"]
```

### 4.1 `list_peers`（查看在线伙伴）
```json
{
  "name": "list_peers",
  "description": "列出当前在线的 CLI 同伴、所用模型、当前工作焦点及最近修改的文件",
  "inputSchema": {
    "type": "object",
    "properties": {}
  }
}
```

### 4.2 `ask_peer`（同步阻塞问答）
```json
{
  "name": "ask_peer",
  "description": "向当前在线的 Agent CLI 实例提问。前台只等待一个窗口，后台 dispatch 不会因窗口结束而超时；离线、死机或额度耗尽时改用 read_peer_context",
  "inputSchema": {
    "type": "object",
    "properties": {
      "to": { "type": "string", "description": "目标 Profile 名称，如 'ds-coder'" },
      "peer_id": { "type": "string", "description": "list_peers 返回的精确 CLI 实例 ID；同一 Profile 有多个实例时必填" },
      "context": { "type": "string", "description": "简要背景说明" },
      "question": { "type": "string", "description": "具体诉求或问题" },
      "expected_format": { "type": "string", "description": "期望回复格式，如 'TypeScript Interface 声明'" },
      "timeout_seconds": { "type": "number", "default": 45, "description": "兼容旧字段，表示前台等待窗口，不是任务超时" },
      "wait_window_seconds": { "type": "number", "default": 45, "description": "前台保持等待的秒数；设置为 0 可立即返回并让后台 dispatch 继续" },
      "allow_offline_execution": { "type": "boolean", "default": false, "description": "显式允许无在线终端时启动后台 CLI；故障接管场景禁止启用" }
    },
    "required": ["to", "question"]
  }
}
```

### 4.3 `send_task`（异步非阻塞任务派发）
```json
{
  "name": "send_task",
  "description": "向指定的 CLI 同伴派发异步任务，立即返回 task_id，双方继续并行工作",
  "inputSchema": {
    "type": "object",
    "properties": {
      "to": { "type": "string", "description": "目标 Profile 名称" },
      "peer_id": { "type": "string", "description": "list_peers 返回的精确 CLI 实例 ID；同一 Profile 有多个实例时必填" },
      "task_title": { "type": "string", "description": "任务简述" },
      "task_detail": { "type": "string", "description": "详细要求与上下文" }
    },
    "required": ["to", "task_title", "task_detail"]
  }
}
```

### 4.4 `share_data` / `get_shared_data`（共享工作黑板）
```json
{
  "name": "share_data",
  "description": "在 Agent CLI 网络的全局运行时共享黑板中存储临时公共数据（接口契约、公共设计、测试结果等）",
  "inputSchema": {
    "type": "object",
    "properties": {
      "key": { "type": "string", "description": "键名，如 'api-v1-auth-spec'" },
      "value": { "type": "string", "description": "内容" }
    },
    "required": ["key", "value"]
  }
}
```

### 4.5 `read_peer_context`（读取中断会话上下文）
```json
{
  "name": "read_peer_context",
  "description": "当目标 CLI 死机、额度耗尽或无法回复时，读取其最近会话的有限交接上下文",
  "inputSchema": {
    "type": "object",
    "properties": {
      "to": { "type": "string", "description": "目标 Profile 名称；用于读取该 Agent CLI 的本地交接上下文" },
      "session_id": { "type": "string", "description": "可选会话 ID；默认读取目标 CLI 本地上下文关联的最近会话" },
      "max_messages": { "type": "number", "default": 12, "maximum": 40 },
      "max_chars": { "type": "number", "default": 12000, "maximum": 30000 },
      "include_tool_activity": { "type": "boolean", "default": true }
    },
    "required": ["to"]
  }
}
```

返回内容包含会话标题、最近请求与回答、有限工具活动、活跃文件候选和 Claude Code 的交接摘要。读取器不会返回 thinking / redacted-thinking，常见 Token、API Key 与 Authorization 内容会脱敏，超出限制的内容会明确标记为截断。调用方接管工作前仍须重新读取当前文件状态。

---

## 5. Skills 协作 SOP 规约设计 (`SKILL.md`)

注入到各 Profile 的规约文档，约束 Agent 的协同行为准则：

````markdown
# 跨 CLI 智能体协作 SOP 规约

当你所在的终端与其他 multi-ccp 终端实例协同工作时，请遵循以下规则：

## 1. 提问前自省
- 优先查阅本地文件与共享黑板 (`get_shared_data`)。
- 当确实需要向同伴求助或派发任务时，使用 `list_peers` 检查对方状态。

## 2. 结构化通信格式
发送消息时必须包含：
- **Context (背景)**：你正在做什么，为什么需要对方配合。
- **Task (诉求)**：明确、具体的行动请求。
- **Output Criteria (期望输出)**：期望的代码签名、日志格式或结论。
- 严禁发送“在吗？”等无上下文的寒暄。

## 3. 并行与阻塞模式选择
- **强依赖（卡点）**：目标有在线终端时，使用 `ask_peer`；`wait_window_seconds` 只控制前台等待，不能当作模型思考截止时间。
- **弱依赖（分工）**：目标可工作时，使用 `send_task` 派发子任务后立即继续手头工作。
- **活动判断**：根据 `list_peers` 的 `status`、`responseState`、`lastActivityAt`、`lastOutputAt` 和心跳判断是否仍在处理，不要仅根据等待秒数判定卡死。
- **故障接管（恢复）**：目标死机、退出、卡死、额度耗尽或无法回复时，直接使用 `read_peer_context`，禁止要求故障 Agent 自己总结。

## 4. 冲突防范与降级策略
- 如果发现对方正在编辑相同文件，请主动发消息协商，避免覆盖。
- 若 `ask_peer` 返回 `deferred`，先检查目标活动状态，后台任务仍可继续并接受迟到回复；只有确认 `disconnected` 或长期无活动的 `stalled` 才使用 `read_peer_context` 接管，不可无限期等待或反复询问。
````

---

## 6. 系统防死锁与容错保障机制

```mermaid
flowchart TD
    Start["发起跨 CLI 协作请求"] --> HopCheck{"调用链跳数 Hop Count > 3?"}
    HopCheck -- 是 --> Breaker["触发熔断拦截: 防止 A-B-A-B 循环死锁"]
    HopCheck -- 否 --> TargetCheck{"目标 CLI 是否在线?"}
    TargetCheck -- 断开 --> ErrOffline["标记 disconnected: 使用上下文接管"]
    TargetCheck -- 在线 --> StateCheck{"目标 CLI 当前状态"}
    StateCheck -- "Idle 空闲" --> PTYInject["PTY 立即注入唤醒并执行"]
    StateCheck -- "Busy 忙碌" --> Queue["消息放入 Pending 队列顺延"]
    StateCheck -- "等待回复" --> ActivityCheck{"仍有输入/输出/工具/心跳活动?"}
    ActivityCheck -- 是 --> Processing["保持 processing，允许长思考"]
    ActivityCheck -- 否且超过阈值 --> Stalled["标记 stalled，等待人工或上下文接管"]
    ActivityCheck -- 回复到达 --> Finish["正常返回 Tool Result（迟到回复也有效）"]
```

1. **调用链追踪与死锁熔断 (Trace Hop Breaker)**：
   - 每条消息附带 `trace_id` 与 `hop_count`。若发现循环调用链跳数 $> 3$，中枢自动拦截熔断。
2. **状态感知与排队机制**：
   - **目标 Idle**：PTY 自动注入 Prompt 敲回车唤醒。
   - **目标 Busy / Processing**：消息进入队列，保留活动驱动的 processing 状态；待当前轮次结束后作为下一轮 Prompt 顺延输入。
3. **等待窗口与故障判断**：
   - `ask_peer` 前台窗口结束只返回 `deferred`，不会关闭后台 dispatch。
   - `stalled` 表示持续无活动的疑似卡住状态；`disconnected` 由连接或心跳失效触发。二者都不等同于“模型思考超时”。

---

## 7. multi-ccp 代码库集成方案

```text
multi-ccp/
├── src/
│   ├── collab/                      # 协作核心子系统
│   │   ├── hub.ts                   # 消息路由总线、在线注册表、黑板存储
│   │   ├── mcp-protocol.ts          # MCP 工具定义与 JSON-RPC 请求处理
│   │   ├── mcp-stdio.ts             # Claude Code stdio MCP 控制通道
│   │   ├── peer-context.ts          # 中断会话上下文提取、截断与脱敏
│   │   ├── pty-activator.ts         # 跨平台 PTY 包装与空闲唤醒注入器
│   │   ├── cli-worker.ts            # 无在线终端时的后台 Agent CLI 执行器
│   │   ├── profile-collab.ts        # Profile MCP、权限与协作 skill 注入
│   │   └── types.ts                 # Peer、dispatch、黑板与监管消息类型
│   ├── platform/
│   │   └── console-injector.ts      # Windows 控制台输入注入
│   ├── gateway/
│   │   └── server.ts                # 现有多 Profile Gateway，挂载 /mcp/collab 路由
│   ├── core/
│   │   ├── launcher.ts              # 启动时注入 MCP 配置与协作 SOP
│   │   └── settings.ts              # Profile settings.json 协同字段扩展
│   └── web/
│       └── server.ts                # Web UI 增加「协同拓扑大盘」
```

---

## 8. 0.4.0 实施状态

* **基础通信层**：`hub.ts`、`mcp-protocol.ts` 和 Gateway 协作路由已支持按 `peerId` 精确寻址、全局共享黑板、收件箱、回复幂等和监管消息。
* **活动与容错层**：`pty-activator.ts`、Launcher 活动上报和 Hub 健康检查已支持 `pending`、`waiting`、`processing`、`stalled`、`disconnected`、`completed` 与 `error` 状态；前台等待窗口与后台 dispatch 分离。
* **终端接入层**：Profile 启动时自动注入 MCP server、权限和协作 skill；协作消息可通过 PTY / Windows 控制台输入注入到独立 CLI 窗口。
* **Web UI 监管层**：`ccp ui` 提供 Agent CLI Mesh 看板，展示实例 ID、PID、焦点、活动时间线、消息流、任务派发、全局黑板和监管收件箱，并支持人工派发与回复。
