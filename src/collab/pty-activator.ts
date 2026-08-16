import type { CollabHub } from "./hub.js";
import type { CollabMessage } from "./types.js";
import { injectActiveConsoleInput } from "../platform/console-injector.js";

export interface CollabTerminalSessionOptions {
  profile: string;
  peerId?: string;
  projectKey: string;
  projectDir?: string;
  /** PID of the owning ccp process (shares console with child claude process) */
  ownerPid?: number;
  childStdin?: { write: (chunk: string) => boolean };
  hub?: CollabHub;
  gatewayEndpoint?: string;
  onMessageReceived?: (msg: CollabMessage) => void;
}

export interface CollabTerminalSession {
  close(): void;
  injectPrompt(message: CollabMessage): boolean;
  reportActivity(kind: CollabActivityKind): void;
}

export type CollabActivityKind = "input" | "output" | "tool";

const ACTIVITY_REPORT_INTERVAL_MS = 1_000;

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[90m";
const ANSI_BOLD = "\x1b[1m";
const ANSI_AGENT = "\x1b[1;36m";
const ANSI_ASK = "\x1b[1;33m";
const ANSI_TASK = "\x1b[1;35m";
const ANSI_EVENT = "\x1b[1;32m";
const ANSI_SUPERVISOR = "\x1b[1;34m";
const ANSI_CONTENT = "\x1b[37m";

function cleanTerminalText(value: string, maxLength = 240): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f\u001b]/g, " ")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function notificationLabel(msg: CollabMessage): { label: string; color: string } {
  if (msg.origin === "supervisor") return { label: "监管指令 / WEB UI", color: ANSI_SUPERVISOR };
  if (msg.type === "ask") return { label: "协作提问 / ASK", color: ANSI_ASK };
  if (msg.type === "task") return { label: "协作任务 / TASK", color: ANSI_TASK };
  return { label: "协作结果 / 完成通知", color: ANSI_EVENT };
}

export function formatCollabBanner(msg: CollabMessage, reply?: string): string {
  const timeStr = new Date(msg.createdAt).toLocaleTimeString();
  const agent = cleanTerminalText(msg.origin === "supervisor" ? "Web UI 监管台" : `@${msg.from}`, 80);
  const content = cleanTerminalText(msg.content);
  const notification = notificationLabel(msg);
  const title = `${notification.color}${ANSI_BOLD}[${notification.label}]${ANSI_RESET}`;
  const senderColor = msg.origin === "supervisor" ? ANSI_SUPERVISOR : ANSI_AGENT;
  const sender = `${senderColor}${ANSI_BOLD}${agent}${ANSI_RESET}`;
  const suffix = `${ANSI_DIM} · ${timeStr}${ANSI_RESET}`;

  if (msg.type === "event") {
    return `\n${ANSI_DIM}╭─${ANSI_RESET} ${title} ${ANSI_DIM}来自${ANSI_RESET} ${sender}${suffix}\n` +
      `${ANSI_DIM}╰─${ANSI_RESET} ${ANSI_CONTENT}${content}${ANSI_RESET}\n`;
  }

  return `\n${ANSI_DIM}╭─${ANSI_RESET} ${title} ${ANSI_DIM}来自${ANSI_RESET} ${sender}${suffix}: ${ANSI_CONTENT}${content}${ANSI_RESET}\n` +
    (reply
      ? `${ANSI_DIM}╰─${ANSI_RESET} ${ANSI_EVENT}${ANSI_BOLD}✔ 自动回复${ANSI_RESET}: ${ANSI_CONTENT}${cleanTerminalText(reply, 320)}${ANSI_RESET}\n`
      : `${ANSI_DIM}╰─${ANSI_RESET} ${ANSI_ASK}⏳ 正在自主协同处理中...${ANSI_RESET}\n`);
}

export function printCollabBanner(msg: CollabMessage, reply?: string): void {
  // 1. Dynamic Terminal Tab Title update (Zero-disruption to console text buffer)
  try {
    const from = cleanTerminalText(`@${msg.from}`, 60);
    const to = cleanTerminalText(`@${msg.to}`, 60);
    const titleAction = msg.type === "event" ? `${from} 结果` : `${from} ➔ ${to}`;
    const preview = cleanTerminalText(msg.content, 30);
    process.stdout.write(`\x1b]0;⚡ [Collab ${titleAction}] ${preview} | multi-ccp\x07`);
  } catch {
    // Ignore title update failures
  }

  // 2. Ultra-compact, non-intrusive Starship/Gh style 2-line badge
  try {
    process.stdout.write(formatCollabBanner(msg, reply));
  } catch {
    // Ignore stdout write errors
  }
}

export function formatCollabPrompt(msg: CollabMessage): string {
  const from = cleanTerminalText(msg.from, 80);
  const cleanContent = cleanTerminalText(msg.content, 8_000);
  const cleanContext = cleanTerminalText(msg.context ?? "", 8_000);
  const cleanFormat = cleanTerminalText(msg.expectedFormat ?? "", 2_000);

  if (msg.origin === "supervisor") {
    let prompt = `[来自 Web UI 监管台的指令]: ${cleanContent}`;
    if (cleanContext) prompt += `\n【监管背景】: ${cleanContext}`;
    if (msg.relayTo) {
      const relayTarget = cleanTerminalText(msg.relayTo, 80);
      prompt += `\n【协作路由】: 请由你作为实际发送方，使用 ccp-collab 的 ask_peer 或 send_task 联系 @${relayTarget}。目标 Agent 收到的发送者必须是你，而不是 Web UI。`;
      prompt += `\n【对接边界】: @${relayTarget} 完成后只需回复你；不要要求它向 Web UI 回报，除非本指令明确要求。`;
    }
    if (msg.responsePolicy === "supervisor") {
      prompt += `\n【回报要求】: 完成后调用 notify_supervisor，将结果发送到 Web UI 监管收件箱，并传入 related_message_id: "${msg.id}"。不要对 Web UI 使用 ask_peer 或 reply_peer。`;
    } else {
      prompt += `\n【回报要求】: 本指令不要求回复 Web UI。请继续在相关 Agent 之间完成协作闭环。`;
    }
    return prompt;
  }

  if (msg.type === "ask" || msg.type === "task") {
    let prompt = `[来自 @${from} 的跨 Agent 协作消息 (${msg.type.toUpperCase()})]: ${cleanContent}`;
    if (cleanContext) prompt += `\n【背景】: ${cleanContext}`;
    if (cleanFormat) prompt += `\n【期望格式】: ${cleanFormat}`;
    prompt += `\n【回复要求】: 完成后调用 reply_peer 工具向 @${from} 回传，reply_to_id: "${msg.id}"`;
    return prompt;
  }
  return `[协作结果 / 完成通知] 来自 Agent @${from}: ${cleanContent}`;
}

export function createCollabTerminalSession(options: CollabTerminalSessionOptions): CollabTerminalSession {
  let isClosed = false;
  let unsubscribe: (() => void) | undefined;
  let abortController: AbortController | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let activityTimer: NodeJS.Timeout | undefined;
  let lastActivityReportAt: number | undefined;
  let pendingActivityKind: CollabActivityKind | undefined;

  const activityPriority: Record<CollabActivityKind, number> = {
    input: 1,
    tool: 2,
    output: 3
  };

  const sendActivity = (kind: CollabActivityKind): void => {
    if (isClosed || !options.peerId) return;
    lastActivityReportAt = Date.now();
    if (options.hub) {
      options.hub.recordPeerActivity(options.peerId, kind);
      return;
    }
    if (!options.gatewayEndpoint) return;
    const endpoint = options.gatewayEndpoint.replace(/\/+$/, "");
    const activityUrl = `${endpoint}/mcp/collab/activity?peerId=${encodeURIComponent(options.peerId)}&kind=${encodeURIComponent(kind)}`;
    void fetch(activityUrl, { method: "POST" }).catch(() => {
      // Activity is advisory; a temporary Gateway failure must not affect the CLI.
    });
  };

  const flushPendingActivity = (): void => {
    activityTimer = undefined;
    const kind = pendingActivityKind;
    pendingActivityKind = undefined;
    if (kind) sendActivity(kind);
  };

  const reportActivity = (kind: CollabActivityKind): void => {
    if (isClosed || !options.peerId) return;
    const now = Date.now();
    if (lastActivityReportAt === undefined || now - lastActivityReportAt >= ACTIVITY_REPORT_INTERVAL_MS) {
      if (activityTimer) clearTimeout(activityTimer);
      activityTimer = undefined;
      pendingActivityKind = undefined;
      sendActivity(kind);
      return;
    }

    if (!pendingActivityKind || activityPriority[kind] > activityPriority[pendingActivityKind]) {
      pendingActivityKind = kind;
    }
    if (!activityTimer) {
      activityTimer = setTimeout(
        flushPendingActivity,
        Math.max(1, ACTIVITY_REPORT_INTERVAL_MS - (now - lastActivityReportAt))
      );
      activityTimer.unref?.();
    }
  };

  const handleMessage = (msg: CollabMessage): boolean => {
    if (isClosed) return false;
    printCollabBanner(msg);
    options.onMessageReceived?.(msg);
    // Receiving and injecting a collaboration prompt is meaningful terminal activity,
    // even when the model takes a long time before producing visible output.
    reportActivity("input");

    const promptText = formatCollabPrompt(msg);

    // Method 1: Direct stdin pipe (if available)
    if (options.childStdin && typeof options.childStdin.write === "function") {
      options.childStdin.write(promptText + "\r");
      // Claude Code treats a prompt and Enter arriving in the same PTY write as
      // a paste operation. A separate Enter commits the pasted prompt.
      setTimeout(() => {
        if (!isClosed) options.childStdin?.write("\r");
      }, 100);
      return true;
    }

    // Method 2: Console input injection via Win32 API
    // The ownerPid is the ccp process that shares a console with the child claude process.
    // By injecting keystrokes into the ccp process's console input buffer,
    // the child claude process (which inherits the same console) will read them.
    if (options.ownerPid && process.platform === "win32") {
      void injectActiveConsoleInput(options.ownerPid, promptText).catch(() => {
        // Injection failed silently — user will still see the banner
      });
      return true;
    }

    return true;
  };

  if (options.hub) {
    unsubscribe = options.hub.subscribe(options.profile, options.projectKey, (msg) => {
      handleMessage(msg);
    }, options.peerId);
  } else if (options.gatewayEndpoint) {
    const endpoint = options.gatewayEndpoint.replace(/\/+$/, "");
    const projectDirParam = options.projectDir ? `&projectDir=${encodeURIComponent(options.projectDir)}` : "";
    const peerIdParam = options.peerId ? `&peerId=${encodeURIComponent(options.peerId)}` : "";
    const pid = options.ownerPid ?? process.pid;
    const sseUrl = `${endpoint}/mcp/collab/sse?role=terminal&profile=${encodeURIComponent(options.profile)}&project=${encodeURIComponent(options.projectKey)}&pid=${pid}${peerIdParam}${projectDirParam}`;

    const connect = async (): Promise<void> => {
      abortController = new AbortController();
      try {
        const res = await fetch(sseUrl, { signal: abortController.signal });
        if (!res.ok || !res.body) throw new Error(`Collaboration SSE returned ${res.status}.`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!isClosed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const block of lines) {
            const match = block.match(/^event: message\ndata: (.+)$/m);
            if (match) {
              try {
                const msg = JSON.parse(match[1]) as CollabMessage;
                handleMessage(msg);
              } catch {
                // ignore malformed events
              }
            }
          }
        }
      } catch {
        // Reconnect below unless the session is closing.
      } finally {
        if (!isClosed) reconnectTimer = setTimeout(() => void connect(), 3000);
      }
    };

    void connect();
  }

  return {
    close() {
      isClosed = true;
      unsubscribe?.();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (activityTimer) clearTimeout(activityTimer);
      pendingActivityKind = undefined;
      abortController?.abort();
    },
    injectPrompt(msg: CollabMessage) {
      return handleMessage(msg);
    },
    reportActivity(kind: CollabActivityKind) {
      reportActivity(kind);
    }
  };
}
