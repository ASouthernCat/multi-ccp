import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSettings, writeSettings } from "../core/settings.js";
import type { ClaudeSettings } from "../core/types.js";

export const COLLAB_APPROVED_TOOLS = [
  "mcp__ccp-collab__list_peers",
  "mcp__ccp-collab__check_inbox",
  "mcp__ccp-collab__ask_peer",
  "mcp__ccp-collab__send_task",
  "mcp__ccp-collab__reply_peer",
  "mcp__ccp-collab__update_focus",
  "mcp__ccp-collab__share_data",
  "mcp__ccp-collab__get_shared_data",
  "mcp__ccp-collab__read_peer_context",
  "mcp__ccp-collab__notify_supervisor"
];

const COLLAB_SKILL_MD = `---
name: multi-agent-collab
description: Guide and SOP for collaborating with other multi-ccp CLI agents, including sending messages, delegating tasks, checking status or inbox, reporting results or blockers to the Web UI supervisor, and taking over unfinished work by reading another agent's session context when it has crashed, exited, exhausted its quota, become stuck, or cannot reply (e.g. '给 ds 发送消息', '让 backend 处理', '查看在线 agent', '回报 web ui', '通知监管台', '读取 grok 上下文', 'grok 死机了', '额度用完了', '接着另一个 agent 的工作', 'ask peer', 'notify supervisor', 'read peer context').
---

# Multi-Agent Collaboration SOP (跨 CLI 智能体协作规约)

When collaborating with other Claude Code CLI instances via \`multi-ccp\`, use the \`ccp-collab\` MCP tools:

## 0. 故障恢复路由（最高优先级）

- 用户明确说明目标 Agent 已死机、崩溃、退出、卡死、额度耗尽或无法回复时，**直接调用 \`mcp__ccp-collab__read_peer_context\`**。禁止调用 \`ask_peer\` 或 \`send_task\` 要求故障 Agent 自己总结。
- 目标状态未知时，先调用 \`mcp__ccp-collab__list_peers\`。只有确认目标有在线终端时，才使用 \`ask_peer\` 或 \`send_task\`。
- \`ask_peer\` 返回 \`offline\`、\`deferred\` 或 \`error\` 时，先查看 \`list_peers\` 的状态；只有确认目标已断开、疑似卡住或额度耗尽时，才改用 \`read_peer_context\` 接管，不要仅因前台等待窗口结束就判定失败。
- 读取上下文后，重新检查工作区中的当前文件、Git diff 和测试状态，再继续未完成工作；历史会话不能替代当前文件状态。

## 1. 核心工具集与适用场景

1. **查看在线同伴 (\`mcp__ccp-collab__list_peers\`)**
   - 寻找目标 Agent（如 \`ds\`、\`gpt-5.6\`、\`backend\`）及其当前工作状态、焦点和正在编辑的文件。
   - 示例：在发消息前或不确定同伴名字时调用。

2. **检查收件箱 (\`mcp__ccp-collab__check_inbox\`)**
   - 查看其他 CLI Agent 给自己发送的未读任务、问题或回复。
   - 示例：当需要检查是否有新指派的协作任务时调用。

3. **同步问答 (\`mcp__ccp-collab__ask_peer\`)**
   - **适用场景**：目标 Agent 有在线终端，且你当前的任务强依赖对方的回答（如需要对方提供数据结构定义、API 契约或函数签名）。
   - **禁止场景**：目标 Agent 已死机、退出、卡死、额度耗尽或无法回复。此时必须使用 \`read_peer_context\`。
   - **特性**：当前会话只在前台等待窗口内挂起（默认 45 秒，可用 \`wait_window_seconds\` 调整）；窗口结束返回 \`deferred\`，后台任务继续运行，迟到回复仍有效。真正的生命周期由 Agent CLI 的连接、输入、输出和工具活动决定。
   - **格式要求**：三段式提问（包含 \`context\` 背景、\`question\` 具体问题、\`expected_format\` 期望返回格式）。

4. **异步任务派发 (\`mcp__ccp-collab__send_task\`)**
   - **适用场景**：目标 Agent 可工作，你希望分工给对方一个任务（如“编写测试用例”、“打个招呼”、“处理某个子模块”），且你不需要阻塞等待。
   - **禁止场景**：不要用它要求已故障或额度耗尽的 Agent 总结上下文。
   - **特性**：发送后立即返回 \`task_id\`，双方并行工作。

5. **回复请求 (\`mcp__ccp-collab__reply_peer\`)**
   - **适用场景**：当你收到来自其他 Agent 的问答请求时，用此工具回传结果。
   - **幂等要求**：同一个 \`reply_to_id\` 只能调用一次；工具返回 \`delivered\` 或 \`duplicate_ignored\` 后必须停止，禁止重试或再次发送相同回复。

6. **更新自身焦点 (\`mcp__ccp-collab__update_focus\`)**
   - 在开始处理关键文件或任务时更新，让其他 Agent 感知。

7. **共享工作黑板 (\`mcp__ccp-collab__share_data\` / \`mcp__ccp-collab__get_shared_data\`)**
   - 存取公共数据或接口规范。

8. **接管中断会话 (\`mcp__ccp-collab__read_peer_context\`)**
   - 当同伴 CLI 死机、崩溃、退出、卡死、额度耗尽或无法回复时，这是优先于 \`ask_peer\` / \`send_task\` 的恢复工具，用于读取其 Agent CLI 本地会话的有限上下文并接管未完成工作。
   - 先核对返回的最后请求、工具活动和文件状态，再继续未完成工作；不要把上下文当作当前文件状态的替代品。

9. **回报 Web UI 监管台 (\`mcp__ccp-collab__notify_supervisor\`)**
   - Web UI 是用户操作的上层监管界面，不是另一个 Agent CLI。向监管台发送状态、结果或阻塞信息时只能使用此工具；禁止对 Web UI 调用 \`ask_peer\`、\`send_task\` 或 \`reply_peer\`。
   - Agent 之间的任务结果仍用 \`reply_peer\` 回给原始发送方。只有用户、Web UI 监管指令明确要求回报，或出现需要人工关注的关键阻塞时，才调用 \`notify_supervisor\`。
   - Web UI 要求你联系另一个 Agent 时，你是实际发送方。请自行调用 \`ask_peer\` / \`send_task\` 联系目标；目标只需与你对接，不需要知道 Web UI 的存在。

## 2. 行为准则与避坑提示
- **重要**：当用户指示“给 xx agent 发送消息 / 打个招呼 / 派发任务”时，目标是另一个独立的 CLI 终端，请直接使用 \`send_task\` 或 \`ask_peer\` 工具。**严禁**使用内置的内部子代理工具（\`SendMessage\`），因为该内置工具仅用于同进程内的子 Agent。
- 提问时简明扼要，说明背景和期望格式。
`;

async function ensureClaudeJsonMcp(profileDir: string, profileName: string): Promise<void> {
  const claudeJsonPath = path.join(profileDir, ".claude.json");
  let data: Record<string, unknown> = {};
  try {
    const raw = await readFile(claudeJsonPath, "utf8");
    data = JSON.parse(raw);
  } catch {
    // File doesn't exist or is invalid JSON
  }

  const mcpServers = (data.mcpServers && typeof data.mcpServers === "object"
    ? { ...(data.mcpServers as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  mcpServers["ccp-collab"] = {
    type: "stdio",
    command: "ccp",
    args: ["mcp", "--profile", profileName],
    env: {}
  };

  data.mcpServers = mcpServers;
  await writeFile(claudeJsonPath, JSON.stringify(data, null, 2), "utf8");
}

export async function ensureProfileCollabConfig(profileDir: string, profileName: string): Promise<ClaudeSettings> {
  const current = (await readSettings(profileDir)) ?? {};
  let modified = false;

  // 1. Ensure mcpServers configuration in settings.json
  const mcpServers = (current.mcpServers && typeof current.mcpServers === "object"
    ? { ...current.mcpServers }
    : {}) as Record<string, unknown>;

  const expectedMcpConfig = {
    command: "ccp",
    args: ["mcp", "--profile", profileName]
  };

  const existingMcp = mcpServers["ccp-collab"] as Record<string, unknown> | undefined;
  const existingArgs = Array.isArray(existingMcp?.args) ? existingMcp.args : [];
  if (!existingMcp || existingMcp.command !== "ccp" || JSON.stringify(existingArgs) !== JSON.stringify(expectedMcpConfig.args)) {
    mcpServers["ccp-collab"] = expectedMcpConfig;
    current.mcpServers = mcpServers;
    modified = true;
  }

  // 2. Ensure approvedTools list contains all collaboration tools
  const approved = Array.isArray(current.approvedTools)
    ? [...current.approvedTools]
    : [];

  let approvedChanged = false;
  for (const tool of COLLAB_APPROVED_TOOLS) {
    if (!approved.includes(tool)) {
      approved.push(tool);
      approvedChanged = true;
    }
  }

  if (approvedChanged) {
    current.approvedTools = approved;
    modified = true;
  }

  // Claude Code 2.x uses permissions.allow for non-interactive approval.
  // Keep approvedTools above for compatibility with older releases.
  const permissions = current.permissions && typeof current.permissions === "object"
    ? { ...(current.permissions as Record<string, unknown>) }
    : {};
  const allowed = Array.isArray(permissions.allow) ? [...permissions.allow] : [];
  let permissionsChanged = false;
  for (const tool of COLLAB_APPROVED_TOOLS) {
    if (!allowed.includes(tool)) {
      allowed.push(tool);
      permissionsChanged = true;
    }
  }
  if (permissionsChanged) {
    permissions.allow = allowed;
    current.permissions = permissions;
    modified = true;
  }

  if (modified) {
    await writeSettings(profileDir, current);
  }

  // 3. Ensure mcpServers configuration in .claude.json (where Claude Code reads MCP servers)
  try {
    await ensureClaudeJsonMcp(profileDir, profileName);
  } catch {
    // Ignore .claude.json write failures if any
  }

  // 4. Ensure multi-agent-collab skill exists in profileDir/skills/multi-agent-collab/SKILL.md
  try {
    const skillDir = path.join(profileDir, "skills", "multi-agent-collab");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), COLLAB_SKILL_MD, "utf8");
  } catch {
    // Ignore skill write failures if any
  }

  return current;
}
