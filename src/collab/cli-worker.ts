import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getProfilesRoot, type PathContext } from "../core/paths.js";
import type { CollabMessage } from "./types.js";

const activeCollabSessions = new Map<string, string>();

export async function executePeerClaudeTask(
  msg: CollabMessage,
  context: PathContext = {},
  targetProjectDir?: string
): Promise<string> {
  const profileDir = path.join(getProfilesRoot(context), msg.to);

  let cwd = targetProjectDir;
  if (!cwd && msg.projectKey && path.isAbsolute(msg.projectKey)) {
    cwd = msg.projectKey;
  }
  if (!cwd) {
    const absPathMatch = `${msg.content} ${msg.context ?? ""}`.match(/([A-Za-z]:\\[^"'\n\r<>]+)/);
    if (absPathMatch) {
      const candidate = absPathMatch[1].trim();
      cwd = path.extname(candidate) ? path.dirname(candidate) : candidate;
    }
  }
  if (!cwd) {
    cwd = process.cwd();
  }

  const sessionKey = `${msg.to}::${cwd.toLowerCase()}`;

  const existingSessionId = activeCollabSessions.get(sessionKey);
  const sessionId = existingSessionId ?? randomUUID();

  const formattedPrompt = [
    `[来自 @${msg.from} 的跨 Agent 协作请求 (${msg.type.toUpperCase()})]:`,
    msg.content,
    ...(msg.context ? [`\n【背景说明】:\n${msg.context}`] : []),
    ...(msg.expectedFormat ? [`\n【期望输出格式】:\n${msg.expectedFormat}`] : []),
    `\n【重要要求】: 请直接调用本地工具（如 Write、Edit、Read、Bash 等）真正完成上述操作并返回明确的结果。`
  ].join("\n");

  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_CONFIG_DIR: profileDir,
      CCP_PROFILE: msg.to,
      CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1"
    };

    const args: string[] = [];
    if (existingSessionId) {
      args.push("--resume", existingSessionId);
    } else {
      args.push("--session-id", sessionId);
    }
    args.push("-p", JSON.stringify(formattedPrompt), "--dangerously-skip-permissions");

    const child = spawn(
      "claude",
      args,
      {
        cwd,
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // ignore kill error
      }
      reject(new Error(`Claude Code CLI execution timed out after ${msg.timeoutSeconds ?? 60}s.`));
    }, (msg.timeoutSeconds ?? 60) * 1000);

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);

      const cleanOut = stdout.replace(/\(node:\d+\) \[DEP0190\].*?\n/g, "").trim();
      const cleanErr = stderr.trim();
      if ((code ?? 0) !== 0) {
        reject(new Error(cleanErr || cleanOut || `Claude Code CLI exited with status ${code}.`));
        return;
      }
      if (/not logged in|please run \/login|unauthorized|authentication failed/i.test(`${cleanOut}\n${cleanErr}`)) {
        reject(new Error(cleanOut || cleanErr));
        return;
      }

      activeCollabSessions.set(sessionKey, sessionId);
      if (cleanOut) {
        resolve(cleanOut);
      } else if (cleanErr) {
        reject(new Error(cleanErr));
      } else {
        resolve(`Task completed with status code ${code ?? 0}.`);
      }
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Failed to invoke Claude Code CLI for @${msg.to}: ${error.message}`));
    });
  });
}
