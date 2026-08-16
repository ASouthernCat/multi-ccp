import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createGatewayServer, type GatewayServerHandle } from "../../src/gateway/server.js";

describe("Gateway Collab Endpoints", () => {
  let handle: GatewayServerHandle;
  let endpoint: string;

  beforeEach(async () => {
    handle = createGatewayServer({
      registry: {
        resolve: async () => { throw new Error("not needed"); },
        countProfiles: async () => 0
      }
    });
    const listening = await handle.listen({ host: "127.0.0.1", port: 0 });
    endpoint = listening.endpoint;
  });

  afterEach(async () => {
    await handle.close();
  });

  it("handles MCP JSON-RPC message endpoint via POST", async () => {
    const rpcRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list"
    };

    const res = await fetch(`${endpoint}/mcp/collab/message?profile=dev&project=test-proj`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rpcRequest)
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result.tools.length).toBeGreaterThanOrEqual(7);
  });

  it("rejects Web UI supervisor identities on Agent MCP endpoints", async () => {
    const res = await fetch(`${endpoint}/mcp/collab/message?profile=web-ui&project=test-proj`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.message).toContain("cannot call Agent MCP tools");
  });

  it("queries active peers via /api/collab/peers", async () => {
    handle.collabHub.registerPeer({
      profile: "agent-1",
      projectKey: "proj-abc",
      status: "idle",
      currentFocus: "Writing tests"
    });

    const res = await fetch(`${endpoint}/api/collab/peers?project=proj-abc`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.peers).toHaveLength(1);
    expect(json.peers[0].profile).toBe("agent-1");
    expect(json.peers[0].currentFocus).toBe("Writing tests");
  });

  it("deduplicates stale project registrations from the same terminal process", async () => {
    handle.collabHub.registerPeer({ profile: "agent-1", projectKey: "stale-project", pid: 9001 });
    handle.collabHub.registerPeer({ profile: "agent-1", projectKey: "current-project", pid: 9001 });
    handle.collabHub.registerPeer({ profile: "agent-2", projectKey: "current-project", pid: 9002 });
    handle.collabHub.registerPeer({ profile: "agent-3", projectKey: "current-project", pid: 9003 });

    const res = await fetch(`${endpoint}/api/collab/peers?all=true`);
    const json = (await res.json()) as any;
    expect(json.peers).toHaveLength(3);
    expect(json.peers).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: "agent-1", pid: 9001 }),
      expect.objectContaining({ profile: "agent-2", pid: 9002 }),
      expect.objectContaining({ profile: "agent-3", pid: 9003 })
    ]));
    expect(json.peers.every((peer: any) => !("projectKey" in peer) && !("projectDir" in peer))).toBe(true);
  });

  it("queries the global blackboard regardless of project metadata", async () => {
    handle.collabHub.setBlackboard({ key: "schema", value: "User { id, email }", author: "architect", projectKey: "proj-abc" });

    const res = await fetch(`${endpoint}/api/collab/blackboard?project=another-project`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.blackboard).toHaveLength(1);
    expect(json.blackboard[0].key).toBe("schema");
    expect(json.blackboard[0].value).toBe("User { id, email }");
  });

  it("writes Web UI entries to the Agent CLI shared blackboard", async () => {
    const writeRes = await fetch(`${endpoint}/api/collab/blackboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "release-plan",
        value: "Ship after the focused regression suite passes."
      })
    });

    expect(writeRes.status).toBe(201);
    const written = (await writeRes.json()) as any;
    expect(written).toMatchObject({
      ok: true,
      entry: {
        key: "release-plan",
        value: "Ship after the focused regression suite passes.",
        author: "web-ui"
      }
    });

    const readRes = await fetch(`${endpoint}/api/collab/blackboard`);
    const read = (await readRes.json()) as any;
    expect(read.blackboard).toMatchObject([
      { key: "release-plan", author: "web-ui" }
    ]);
  });

  it("validates Web UI blackboard writes", async () => {
    const res = await fetch(`${endpoint}/api/collab/blackboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "missing-value" })
    });

    expect(res.status).toBe(400);
    const json = (await res.json()) as any;
    expect(json.error.message).toContain("value");
    expect(handle.collabHub.listBlackboard()).toHaveLength(0);
  });

  it("injects peer-to-peer relay instructions into the source agent only", async () => {
    const sourceMessages: any[] = [];
    const targetMessages: any[] = [];
    handle.collabHub.registerPeer({ profile: "agent-a", projectKey: "proj-abc", status: "idle" });
    handle.collabHub.registerPeer({ profile: "agent-b", projectKey: "proj-abc", status: "idle" });
    handle.collabHub.subscribe("agent-a", "proj-abc", (message) => sourceMessages.push(message));
    handle.collabHub.subscribe("agent-b", "proj-abc", (message) => targetMessages.push(message));

    const res = await fetch(`${endpoint}/api/collab/supervisor/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode: "relay",
        to: "agent-a",
        relayTo: "agent-b",
        message: "Review auth.ts"
      })
    });

    expect(res.status).toBe(200);
    expect(sourceMessages).toHaveLength(1);
    expect(sourceMessages[0]).toMatchObject({
      from: "web-ui",
      to: "agent-a",
      origin: "supervisor",
      responsePolicy: "none",
      relayTo: "agent-b"
    });
    expect(targetMessages).toHaveLength(0);

    await handle.collabHub.sendMessage({
      from: "agent-a",
      to: "agent-b",
      projectKey: "proj-abc",
      type: "task",
      content: "Review auth.ts"
    });
    expect(targetMessages).toHaveLength(1);
    expect(targetMessages[0].from).toBe("agent-a");
  });

  it("dispatches to the requested CLI instance when profile names overlap", async () => {
    const firstInstanceMessages: any[] = [];
    const secondInstanceMessages: any[] = [];
    handle.collabHub.registerPeer({ peerId: "worker:9101", profile: "worker", projectKey: "proj-one", status: "idle" });
    handle.collabHub.registerPeer({ peerId: "worker:9102", profile: "worker", projectKey: "proj-two", status: "idle" });
    handle.collabHub.subscribe("worker", "proj-one", (message) => firstInstanceMessages.push(message), "worker:9101");
    handle.collabHub.subscribe("worker", "proj-two", (message) => secondInstanceMessages.push(message), "worker:9102");

    const res = await fetch(`${endpoint}/api/collab/supervisor/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "worker",
        peerId: "worker:9102",
        message: "Run the project-two verification suite."
      })
    });

    expect(res.status).toBe(200);
    const dispatched = (await res.json()) as any;
    expect(dispatched).toMatchObject({
      ok: true,
      peerId: "worker:9102",
      status: "delivered",
      responseStatus: "waiting"
    });
    expect(dispatched).not.toHaveProperty("projectKey");
    expect(firstInstanceMessages).toHaveLength(0);
    expect(secondInstanceMessages).toMatchObject([
      { to: "worker", toPeerId: "worker:9102", projectKey: "proj-two", content: "Run the project-two verification suite." }
    ]);
  });

  it("rejects ambiguous profile-only supervisor dispatches", async () => {
    const firstInstanceMessages: any[] = [];
    const secondInstanceMessages: any[] = [];
    handle.collabHub.registerPeer({ peerId: "worker:9201", profile: "worker", projectKey: "proj-one", status: "idle" });
    handle.collabHub.registerPeer({ peerId: "worker:9202", profile: "worker", projectKey: "proj-two", status: "idle" });
    handle.collabHub.subscribe("worker", "proj-one", (message) => firstInstanceMessages.push(message), "worker:9201");
    handle.collabHub.subscribe("worker", "proj-two", (message) => secondInstanceMessages.push(message), "worker:9202");

    const res = await fetch(`${endpoint}/api/collab/supervisor/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: "worker", message: "Run verification." })
    });

    expect(res.status).toBe(409);
    const json = (await res.json()) as any;
    expect(json.error.message).toContain("Specify 'peerId'");
    expect(firstInstanceMessages).toHaveLength(0);
    expect(secondInstanceMessages).toHaveLength(0);
  });

  it("does not use project metadata as a routing boundary", async () => {
    const messages: any[] = [];
    handle.collabHub.registerPeer({ peerId: "worker:9301", profile: "worker", projectKey: "proj-one", status: "idle" });
    handle.collabHub.subscribe("worker", "proj-one", (message) => messages.push(message), "worker:9301");

    const res = await fetch(`${endpoint}/api/collab/supervisor/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "worker",
        project: "proj-two",
        peerId: "worker:9301",
        message: "Route to the selected CLI instance."
      })
    });

    expect(res.status).toBe(200);
    expect(messages).toMatchObject([{ toPeerId: "worker:9301", content: "Route to the selected CLI instance." }]);
  });

  it("keeps active supervisor work alive without exposing a compatibility timeout", async () => {
    handle.collabHub.registerPeer({ peerId: "worker:9401", profile: "worker", projectKey: "proj-timeout", status: "idle" });
    handle.collabHub.subscribe("worker", "proj-timeout", () => undefined, "worker:9401");

    const dispatchRes = await fetch(`${endpoint}/api/collab/supervisor/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: "worker",
        peerId: "worker:9401",
        message: "Continue processing",
        timeoutSeconds: 0.02
      })
    });
    const dispatched = (await dispatchRes.json()) as any;
    expect(dispatched).toMatchObject({ responseStatus: "waiting" });
    expect(dispatched).not.toHaveProperty("timeoutSeconds");
    expect(dispatched).not.toHaveProperty("deadlineAt");
    expect(dispatched).not.toHaveProperty("projectKey");

    await new Promise((resolve) => setTimeout(resolve, 40));
    const activityRes = await fetch(`${endpoint}/mcp/collab/activity?peerId=worker%3A9401&kind=output`, { method: "POST" });
    expect(activityRes.status).toBe(204);

    const lifecycleRes = await fetch(`${endpoint}/api/collab/dispatches`);
    const lifecycle = (await lifecycleRes.json()) as any;
    expect(lifecycle.dispatches).toMatchObject([
      {
        id: dispatched.messageId,
        status: "processing",
        deliveryStatus: "delivered",
        targetOnline: true
      }
    ]);
    expect(lifecycle.summary).toMatchObject({ timeout: 0, processing: 1, pending: 0 });
    expect(lifecycle.dispatches[0]).not.toHaveProperty("projectKey");

    const messagesRes = await fetch(`${endpoint}/api/collab/supervisor/messages`);
    const messages = (await messagesRes.json()) as any;
    expect(messages.messages).toHaveLength(0);
  });

  it("exposes agent updates through the supervisor message API", async () => {
    handle.collabHub.notifySupervisor({
      from: "agent-a",
      projectKey: "proj-abc",
      kind: "result",
      title: "Review complete",
      message: "No blocking issues"
    });

    const res = await fetch(`${endpoint}/api/collab/supervisor/messages?project=proj-abc`);
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json.unread).toBe(1);
    expect(json.messages).toMatchObject([
      { from: "agent-a", kind: "result", title: "Review complete" }
    ]);
  });
});
