import type { CollabHub } from "./hub.js";
import { readPeerContext } from "./peer-context.js";
import type { PathContext } from "../core/paths.js";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const COLLAB_MCP_TOOLS: McpToolDefinition[] = [
  {
    name: "list_peers",
    description: "List all online Agent CLI instances, their stable peer ids, active models, working focus, and recent files.",
    inputSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "check_inbox",
    description: "Check for incoming messages, questions, or delegated tasks sent to you by other CLI peers.",
    inputSchema: {
      type: "object",
      properties: {
        clear: {
          type: "boolean",
          description: "If true, clears the messages from inbox after reading. Default: true."
        }
      }
    }
  },
  {
    name: "ask_peer",
    description: "Ask a currently online CLI peer a question. The call waits only for a foreground response window; it never marks the collaboration task timed out. The background dispatch remains active for late replies. The Web UI supervisor is not a peer; use notify_supervisor for it. Never use this to recover work from an offline, crashed, stuck, or quota-exhausted peer; use read_peer_context instead.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target profile name (e.g. 'ds-coder', 'gpt-5.6')."
        },
        peer_id: {
          type: "string",
          description: "Exact CLI instance id from list_peers. Required when the profile has multiple running instances."
        },
        question: {
          type: "string",
          description: "Specific question or request."
        },
        context: {
          type: "string",
          description: "Brief background on what you are doing and why you need this info."
        },
        expected_format: {
          type: "string",
          description: "Expected format of the answer (e.g. 'TypeScript Interface', 'JSON spec')."
        },
        timeout_seconds: {
          type: "number",
          description: "Legacy alias for the foreground wait window. It is not a task timeout; the dispatch continues after the window ends (default: 45)."
        },
        wait_window_seconds: {
          type: "number",
          description: "Seconds to keep this tool call in the foreground. Set 0 to return immediately while the state-driven background dispatch continues."
        },
        allow_offline_execution: {
          type: "boolean",
          description: "Explicitly allow starting a background CLI when no live terminal is connected. Default false. Do not enable for crashed, stuck, or quota-exhausted peers; use read_peer_context instead."
        }
      },
      required: ["to", "question"]
    }
  },
  {
    name: "send_task",
    description: "Delegate an asynchronous task to an available CLI peer. Returns immediately with task_id so you can continue your own work. Use notify_supervisor, not send_task, for Web UI updates. Do not use this to recover a crashed, stuck, or quota-exhausted peer; use read_peer_context instead.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target profile name to receive the task."
        },
        peer_id: {
          type: "string",
          description: "Exact CLI instance id from list_peers. Required when the profile has multiple running instances."
        },
        task_title: {
          type: "string",
          description: "Short summary title of the task."
        },
        task_detail: {
          type: "string",
          description: "Detailed requirements, context, and acceptance criteria."
        }
      },
      required: ["to", "task_title", "task_detail"]
    }
  },
  {
    name: "reply_peer",
    description: "Reply to the CLI peer that sent an incoming question or task. Use notify_supervisor when a Web UI supervisor instruction asks for a status or result update.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target profile name who asked you."
        },
        peer_id: {
          type: "string",
          description: "Exact sender CLI instance id from the incoming message's from_peer_id field."
        },
        reply_to_id: {
          type: "string",
          description: "The messageId of the incoming request."
        },
        result: {
          type: "string",
          description: "Your answer, findings, or completed result."
        }
      },
      required: ["to", "reply_to_id", "result"]
    }
  },
  {
    name: "update_focus",
    description: "Update your current working focus and active files so other peers know what you are currently working on.",
    inputSchema: {
      type: "object",
      properties: {
        focus: {
          type: "string",
          description: "Summary of what you are currently doing (e.g. 'Refactoring auth.ts OAuth logic')."
        },
        active_files: {
          type: "array",
          items: { type: "string" },
          description: "List of files you are currently modifying or analyzing."
        }
      },
      required: ["focus"]
    }
  },
  {
    name: "share_data",
    description: "Save a key-value entry (like API spec, design notes, test results) to the Agent CLI network shared blackboard.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Unique key identifier (e.g. 'auth-api-spec', 'db-schema-draft')."
        },
        value: {
          type: "string",
          description: "Content or structured data to share."
        }
      },
      required: ["key", "value"]
    }
  },
  {
    name: "get_shared_data",
    description: "Read a key-value entry from the Agent CLI network shared blackboard.",
    inputSchema: {
      type: "object",
      properties: {
        key: {
          type: "string",
          description: "Key identifier on the blackboard."
        }
      },
      required: ["key"]
    }
  },
  {
    name: "read_peer_context",
    description: "Preferred recovery tool for taking over unfinished work from an offline, crashed, exited, stuck, quota-exhausted, or otherwise unresponsive CLI peer. Reads a bounded, redacted handoff context from its latest session without asking that peer to respond.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Target profile name whose session context should be read."
        },
        session_id: {
          type: "string",
          description: "Optional Claude session id. Defaults to the latest session attached to the target CLI's local working context."
        },
        max_messages: {
          type: "number",
          description: "Maximum recent transcript entries to return. Default 12, maximum 40."
        },
        max_chars: {
          type: "number",
          description: "Maximum total transcript characters to return. Default 12000, maximum 30000."
        },
        include_tool_activity: {
          type: "boolean",
          description: "Include bounded tool calls and results. Thinking blocks are never returned. Default true."
        }
      },
      required: ["to"]
    }
  },
  {
    name: "notify_supervisor",
    description: "Send a status update, result, blocker, or message to the Web UI supervisor inbox through the built-in Gateway. This does not contact another CLI agent. Use it only when the user or a supervisor instruction asks for a Web UI update, or when a critical blocker needs attention.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short title shown in the supervisor inbox."
        },
        message: {
          type: "string",
          description: "Status, result, blocker, or message for the human supervisor."
        },
        kind: {
          type: "string",
          enum: ["message", "status", "result", "blocked", "error"],
          description: "Message category. Default: message."
        },
        related_message_id: {
          type: "string",
          description: "Optional collaboration message id related to this update."
        }
      },
      required: ["message"]
    }
  }
];

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface McpSession {
  profile: string;
  peerId?: string;
  projectKey: string;
  projectDir?: string;
  context?: PathContext;
}

export async function handleMcpRpcRequest(
  hub: CollabHub,
  session: McpSession,
  request: JsonRpcRequest
): Promise<JsonRpcResponse | undefined> {
  const id = request.id ?? null;

  switch (request.method) {
    case "initialize": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "ccp-collab",
            version: "0.3.6"
          }
        }
      };
    }

    case "notifications/initialized": {
      return undefined;
    }

    case "ping": {
      return {
        jsonrpc: "2.0",
        id,
        result: {}
      };
    }

    case "tools/list": {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          tools: COLLAB_MCP_TOOLS
        }
      };
    }

    case "tools/call": {
      const params = request.params ?? {};
      const toolName = String(params.name ?? "");
      const args = (params.arguments && typeof params.arguments === "object"
        ? params.arguments
        : {}) as Record<string, unknown>;

      try {
        const result = await executeMcpTool(hub, session, toolName, args);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: typeof result === "string" ? result : JSON.stringify(result, null, 2)
              }
            ]
          }
        };
      } catch (error) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: `Error executing tool '${toolName}': ${error instanceof Error ? error.message : String(error)}`
              }
            ]
          }
        };
      }
    }

    default: {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32601,
          message: `Method '${request.method}' not found.`
        }
      };
    }
  }
}

async function executeMcpTool(
  hub: CollabHub,
  session: McpSession,
  toolName: string,
  args: Record<string, unknown>
): Promise<unknown> {
  switch (toolName) {
    case "list_peers": {
      const peers = hub.listPeers();

      return {
        total_peers: peers.length,
        peers: peers.map((p) => ({
          peer_id: p.peerId,
          profile: p.profile,
          pid: p.pid,
          status: p.status,
          model: p.model,
          current_focus: p.currentFocus || "Idle / Waiting for tasks",
          active_files: p.activeFiles || [],
          response_state: p.responseState,
          active_message_id: p.activeMessageId,
          response_deadline_at: p.responseDeadlineAt ? new Date(p.responseDeadlineAt).toISOString() : undefined,
          last_response_at: p.lastResponseAt ? new Date(p.lastResponseAt).toISOString() : undefined,
          last_activity_at: new Date(p.lastActivityAt).toISOString(),
          last_output_at: p.lastOutputAt ? new Date(p.lastOutputAt).toISOString() : undefined
        }))
      };
    }

    case "check_inbox": {
      const clear = args.clear !== false;
      const messages = hub.getInbox(session.profile, session.peerId, clear);
      return {
        count: messages.length,
        messages: messages.map((m) => ({
          id: m.id,
          from: m.from,
          from_peer_id: m.fromPeerId,
          to_peer_id: m.toPeerId,
          type: m.type,
          content: m.content,
          context: m.context,
          expected_format: m.expectedFormat,
          created_at: new Date(m.createdAt).toLocaleTimeString()
        }))
      };
    }

    case "ask_peer": {
      const to = String(args.to ?? "").trim();
      const peerId = args.peer_id ? String(args.peer_id).trim() : undefined;
      const question = String(args.question ?? "").trim();
      const context = args.context ? String(args.context).trim() : undefined;
      const expectedFormat = args.expected_format ? String(args.expected_format).trim() : undefined;
      const timeoutSeconds = typeof args.wait_window_seconds === "number"
        ? args.wait_window_seconds
        : typeof args.timeout_seconds === "number" ? args.timeout_seconds : 45;
      const allowOfflineExecution = args.allow_offline_execution === true;

      if (!to) throw new Error("Missing 'to' parameter (target profile name).");
      if (!question) throw new Error("Missing 'question' parameter.");

      if (hub.isSupervisorTarget(to)) {
        return {
          status: "unsupported_target",
          target: "supervisor",
          recommended_tool: "notify_supervisor",
          message: "The Web UI is a human supervisor surface, not a synchronous CLI peer. Send it an update with notify_supervisor."
        };
      }

      const candidates = hub.listPeers().filter((peer) => peer.profile.trim().toLowerCase() === to.toLowerCase());
      if (!peerId && candidates.length > 1) {
        return {
          status: "ambiguous_target",
          target_peer: to,
          peer_ids: candidates.map((peer) => peer.peerId),
          message: `Profile @${to} has multiple running CLI instances. Retry with peer_id.`
        };
      }

      if (!allowOfflineExecution && !hub.hasActiveSubscriber(to, peerId)) {
        return {
          status: "offline",
          target_peer: to,
          peer_id: peerId,
          recommended_tool: "read_peer_context",
          message: `Target @${to} has no active terminal. Read its session context instead of asking it to summarize.`
        };
      }

      const res = await hub.sendMessage({
        from: session.profile,
        to,
        fromPeerId: session.peerId,
        toPeerId: peerId,
        projectKey: session.projectKey,
        type: "ask",
        content: question,
        context,
        expectedFormat,
        waitForReply: true,
        timeoutSeconds
      });

      if (res.status === "deferred") {
        return {
          status: "deferred",
          message_id: res.messageId,
          response_status: res.responseStatus,
          target_peer: to,
          peer_id: peerId ?? candidates[0]?.peerId,
          message: res.error,
          suggestion: "The synchronous wait window ended, but the task is still active in the background. A late reply will still be delivered."
        };
      }
      if (res.status === "error") {
        return {
          status: "error",
          message_id: res.messageId,
          error: res.error,
          recommended_tool: "read_peer_context",
          suggestion: "Target peer execution failed. Read its session context and take over the unfinished work."
        };
      }

      return {
        status: "replied",
        message_id: res.messageId,
        from_peer: to,
        peer_id: peerId ?? candidates[0]?.peerId,
        reply: res.reply
      };
    }

    case "send_task": {
      const to = String(args.to ?? "").trim();
      const peerId = args.peer_id ? String(args.peer_id).trim() : undefined;
      const taskTitle = String(args.task_title ?? "").trim();
      const taskDetail = String(args.task_detail ?? "").trim();

      if (!to) throw new Error("Missing 'to' parameter (target profile name).");
      if (!taskTitle) throw new Error("Missing 'task_title'.");
      if (!taskDetail) throw new Error("Missing 'task_detail'.");

      if (hub.isSupervisorTarget(to)) {
        return {
          status: "unsupported_target",
          target: "supervisor",
          recommended_tool: "notify_supervisor",
          message: "The Web UI supervisor cannot receive Agent tasks. Send an update with notify_supervisor."
        };
      }

      const res = await hub.sendMessage({
        from: session.profile,
        to,
        fromPeerId: session.peerId,
        toPeerId: peerId,
        projectKey: session.projectKey,
        type: "task",
        content: taskTitle,
        context: taskDetail,
        waitForReply: false
      });

      return {
        status: res.status,
        response_status: res.responseStatus,
        task_id: res.messageId,
        target_peer: to,
        peer_id: peerId,
        deadline_at: res.deadlineAt ? new Date(res.deadlineAt).toISOString() : undefined,
        message: res.status === "error"
          ? res.error
          : res.status === "delivered"
          ? `Task successfully delivered to @${to}. You can now proceed with your own tasks.`
          : `Task queued for @${to}; it will be delivered when the peer connects.`
      };
    }

    case "reply_peer": {
      const to = String(args.to ?? "").trim();
      const peerId = args.peer_id ? String(args.peer_id).trim() : undefined;
      const replyToId = String(args.reply_to_id ?? "").trim();
      const result = String(args.result ?? "");

      if (!to) throw new Error("Missing 'to' parameter.");
      if (!replyToId) throw new Error("Missing 'reply_to_id'.");

      if (hub.isSupervisorTarget(to)) {
        return {
          status: "unsupported_target",
          target: "supervisor",
          recommended_tool: "notify_supervisor",
          message: "The Web UI supervisor is not the sender of a peer request. Send an update with notify_supervisor."
        };
      }

      const status = hub.replyMessage({
        from: session.profile,
        to,
        fromPeerId: session.peerId,
        toPeerId: peerId,
        replyToId,
        result,
        projectKey: session.projectKey
      });

      return {
        status,
        message: status === "delivered"
          ? `Reply returned to @${to}.`
          : status === "duplicate_ignored"
            ? "This request was already answered. The duplicate reply was ignored."
            : "The original request is unknown or has expired."
      };
    }

    case "update_focus": {
      const focus = String(args.focus ?? "");
      const activeFiles = Array.isArray(args.active_files) ? args.active_files.map(String) : [];

      hub.updatePeerFocus({
        profile: session.profile,
        projectKey: session.projectKey,
        peerId: session.peerId,
        currentFocus: focus,
        activeFiles,
        status: "busy"
      });

      return {
        status: "updated",
        focus,
        active_files: activeFiles
      };
    }

    case "share_data": {
      const key = String(args.key ?? "").trim();
      const value = String(args.value ?? "");

      if (!key) throw new Error("Missing 'key'.");

      const entry = hub.setBlackboard({
        key,
        value,
        author: session.profile
      });
      return {
        status: "saved",
        key: entry.key,
        updated_at: new Date(entry.updatedAt).toISOString()
      };
    }

    case "get_shared_data": {
      const key = String(args.key ?? "").trim();
      if (!key) throw new Error("Missing 'key'.");

      const entry = hub.getBlackboard(key);
      if (!entry) {
        return {
          found: false,
          key,
          message: `No data found on blackboard for key '${key}'.`
        };
      }

      return {
        found: true,
        key: entry.key,
        value: entry.value,
        author: entry.author,
        updated_at: new Date(entry.updatedAt).toISOString()
      };
    }

    case "read_peer_context": {
      const to = String(args.to ?? "").trim();
      if (!to) throw new Error("Missing 'to' parameter (target profile name).");
      const sessionId = args.session_id ? String(args.session_id).trim() : undefined;
      const maxMessages = typeof args.max_messages === "number" ? args.max_messages : undefined;
      const maxChars = typeof args.max_chars === "number" ? args.max_chars : undefined;
      return readPeerContext({
        profile: to,
        projectKey: session.projectKey,
        ...(sessionId ? { sessionId } : {}),
        ...(maxMessages !== undefined ? { maxMessages } : {}),
        ...(maxChars !== undefined ? { maxChars } : {}),
        includeToolActivity: args.include_tool_activity !== false,
        context: session.context
      });
    }

    case "notify_supervisor": {
      const message = String(args.message ?? "").trim();
      if (!message) throw new Error("Missing 'message' parameter.");
      const rawKind = String(args.kind ?? "message");
      const kind = ["message", "status", "result", "blocked", "error"].includes(rawKind)
        ? rawKind as "message" | "status" | "result" | "blocked" | "error"
        : "message";
      const entry = hub.notifySupervisor({
        projectKey: session.projectKey,
        from: session.profile,
        fromPeerId: session.peerId,
        kind,
        title: args.title ? String(args.title) : undefined,
        message,
        relatedMessageId: args.related_message_id ? String(args.related_message_id) : undefined
      });
      return {
        status: "delivered",
        supervisor_message_id: entry.id,
        message: "Update recorded in the Web UI supervisor inbox."
      };
    }

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}
