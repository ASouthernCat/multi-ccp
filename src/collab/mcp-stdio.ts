import readline from "node:readline";
import { CollabHub } from "./hub.js";
import { handleMcpRpcRequest, type JsonRpcRequest } from "./mcp-protocol.js";

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:3921";

export async function runMcpStdioServer(options: {
  profile: string;
  peerId?: string;
  projectKey?: string;
  projectDir?: string;
  hub?: CollabHub;
  gatewayEndpoint?: string;
}): Promise<void> {
  const projectKey = options.projectKey || process.cwd();
  const peerId = options.peerId || process.env.CCP_PEER_ID;
  const gatewayUrl = (options.gatewayEndpoint || process.env.CCP_GATEWAY_URL || DEFAULT_GATEWAY_URL).replace(/\/+$/, "");

  // If a local hub was explicitly passed in (e.g. unit tests), use in-process hub
  if (options.hub) {
    const hub = options.hub;
    const session = {
      profile: options.profile,
      peerId,
      projectKey,
      projectDir: options.projectDir ?? process.cwd()
    };

    hub.registerPeer({
      peerId,
      profile: session.profile,
      projectKey: session.projectKey,
      projectDir: session.projectDir,
      pid: process.pid,
      status: "idle"
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const request = JSON.parse(trimmed) as JsonRpcRequest;
        const response = await handleMcpRpcRequest(hub, session, request);
        if (response) {
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      } catch (error) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error", data: error instanceof Error ? error.message : String(error) }
        })}\n`);
      }
    });

    rl.on("close", () => {
      hub.unregisterPeer(session.profile, session.peerId);
    });
    return;
  }

  // Gateway-connected mode (central Hub for all profiles). The MCP process is
  // a control channel; only the launcher PTY consumes live collaboration SSE.
  const localFallbackHub = new CollabHub();
  const session = {
    profile: options.profile,
    peerId,
    projectKey,
    projectDir: options.projectDir ?? process.cwd()
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  rl.on("line", async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    try {
      const request = JSON.parse(trimmed) as JsonRpcRequest;

      // Forward to Gateway
      try {
        const peerIdParam = peerId ? `&peerId=${encodeURIComponent(peerId)}` : "";
        const messageUrl = `${gatewayUrl}/mcp/collab/message?profile=${encodeURIComponent(options.profile)}&project=${encodeURIComponent(projectKey)}${peerIdParam}`;
        const res = await fetch(messageUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(request)
        });

        if (res.ok) {
          if (request.id !== undefined) {
            const responseJson = await res.json();
            process.stdout.write(`${JSON.stringify(responseJson)}\n`);
          }
          return;
        }
      } catch {
        // Fallback to local Hub if Gateway is unreachable
      }

      const response = await handleMcpRpcRequest(localFallbackHub, session, request);
      if (response) {
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } catch (error) {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error", data: error instanceof Error ? error.message : String(error) }
      })}\n`);
    }
  });

}
