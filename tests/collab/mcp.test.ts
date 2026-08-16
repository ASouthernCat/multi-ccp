import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollabHub } from "../../src/collab/hub.js";
import { COLLAB_MCP_TOOLS, handleMcpRpcRequest } from "../../src/collab/mcp-protocol.js";

describe("collaboration MCP protocol", () => {
  let hub: CollabHub;
  const session = {
    profile: "tester",
    peerId: "tester:101",
    projectKey: "local-session-project"
  };

  beforeEach(() => {
    hub = new CollabHub();
    hub.registerPeer({
      profile: session.profile,
      peerId: session.peerId,
      projectKey: session.projectKey,
      pid: 101
    });
  });

  afterEach(() => {
    hub.clear();
    vi.useRealTimers();
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await handleMcpRpcRequest(hub, session, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args }
    });
    return JSON.parse((response?.result as any).content[0].text);
  };

  it("advertises peer_id routing and a global blackboard", () => {
    const ask = COLLAB_MCP_TOOLS.find((tool) => tool.name === "ask_peer");
    const task = COLLAB_MCP_TOOLS.find((tool) => tool.name === "send_task");
    const blackboard = COLLAB_MCP_TOOLS.find((tool) => tool.name === "share_data");

    expect(ask?.inputSchema.properties).toHaveProperty("peer_id");
    expect(task?.inputSchema.properties).toHaveProperty("peer_id");
    expect(ask?.inputSchema.properties).not.toHaveProperty("all_projects");
    expect(blackboard?.description).toContain("Agent CLI network");
  });

  it("lists every CLI instance with its exact peer id", async () => {
    hub.registerPeer({ profile: "worker", peerId: "worker:1", projectKey: "one", pid: 1 });
    hub.registerPeer({ profile: "worker", peerId: "worker:2", projectKey: "two", pid: 2 });

    const result = await call("list_peers");

    expect(result.total_peers).toBe(3);
    expect(result.peers).toEqual(expect.arrayContaining([
      expect.objectContaining({ profile: "worker", peer_id: "worker:1", pid: 1 }),
      expect.objectContaining({ profile: "worker", peer_id: "worker:2", pid: 2 })
    ]));
    expect(result.peers[0]).not.toHaveProperty("project_key");
    expect(result.peers[0]).not.toHaveProperty("is_current_project");
  });

  it("checks the inbox for the current CLI instance", async () => {
    await hub.sendMessage({
      from: "boss",
      fromPeerId: "boss:9",
      to: session.profile,
      toPeerId: session.peerId,
      projectKey: "another-project",
      type: "task",
      content: "review this"
    });

    const result = await call("check_inbox", { clear: true });

    expect(result.count).toBe(1);
    expect(result.messages[0]).toMatchObject({
      from: "boss",
      from_peer_id: "boss:9",
      to_peer_id: session.peerId,
      content: "review this"
    });
  });

  it("requires peer_id when a profile has multiple CLI instances", async () => {
    hub.registerPeer({ profile: "worker", peerId: "worker:1", projectKey: "one" });
    hub.registerPeer({ profile: "worker", peerId: "worker:2", projectKey: "two" });
    hub.subscribe("worker", "one", () => undefined, "worker:1");
    hub.subscribe("worker", "two", () => undefined, "worker:2");

    const ask = await call("ask_peer", { to: "worker", question: "which instance?" });
    const task = await call("send_task", {
      to: "worker",
      task_title: "ambiguous",
      task_detail: "must select an instance"
    });

    expect(ask).toMatchObject({ status: "ambiguous_target", peer_ids: ["worker:1", "worker:2"] });
    expect(task.status).toBe("error");
    expect(task.message).toContain("peerId");
  });

  it("routes send_task to the selected CLI instance", async () => {
    const first: string[] = [];
    const second: string[] = [];
    hub.registerPeer({ profile: "worker", peerId: "worker:1", projectKey: "one" });
    hub.registerPeer({ profile: "worker", peerId: "worker:2", projectKey: "two" });
    hub.subscribe("worker", "one", (message) => first.push(message.content), "worker:1");
    hub.subscribe("worker", "two", (message) => second.push(message.content), "worker:2");

    const result = await call("send_task", {
      to: "worker",
      peer_id: "worker:2",
      task_title: "build",
      task_detail: "run the build"
    });

    expect(result).toMatchObject({ status: "delivered", response_status: "waiting", peer_id: "worker:2" });
    expect(first).toEqual([]);
    expect(second).toEqual(["build"]);
  });

  it("reports offline targets without confusing them with long-running online work", async () => {
    const result = await call("ask_peer", { to: "offline", question: "status?" });

    expect(result).toMatchObject({
      status: "offline",
      target_peer: "offline",
      recommended_tool: "read_peer_context"
    });
  });

  it("returns deferred when the synchronous wait window ends", async () => {
    vi.useFakeTimers();
    hub.registerPeer({ profile: "worker", peerId: "worker:3", projectKey: "other" });
    hub.subscribe("worker", "other", () => undefined, "worker:3");

    const pending = call("ask_peer", {
      to: "worker",
      peer_id: "worker:3",
      question: "take your time",
      timeout_seconds: 0.05
    });
    await vi.advanceTimersByTimeAsync(50);
    const result = await pending;

    expect(result).toMatchObject({
      status: "deferred",
      response_status: "waiting",
      peer_id: "worker:3"
    });
    expect(result.suggestion).toContain("still active in the background");
    expect(hub.getDispatch(result.message_id)?.status).toBe("waiting");
  });

  it("returns replies received inside the synchronous wait window", async () => {
    hub.registerPeer({ profile: "worker", peerId: "worker:4", projectKey: "other" });
    hub.subscribe("worker", "other", (message) => {
      hub.replyMessage({
        from: "worker",
        fromPeerId: "worker:4",
        to: session.profile,
        toPeerId: session.peerId,
        replyToId: message.id,
        projectKey: "other",
        result: "done"
      });
    }, "worker:4");

    const result = await call("ask_peer", {
      to: "worker",
      peer_id: "worker:4",
      question: "ready?"
    });

    expect(result).toMatchObject({ status: "replied", reply: "done", peer_id: "worker:4" });
  });

  it("updates only the current CLI instance focus", async () => {
    hub.registerPeer({ profile: session.profile, peerId: "tester:202", projectKey: "other", pid: 202 });

    await call("update_focus", { focus: "checking routes", active_files: ["src/collab/hub.ts"] });

    expect(hub.findPeer(session.profile, session.peerId)).toMatchObject({
      currentFocus: "checking routes",
      activeFiles: ["src/collab/hub.ts"]
    });
    expect(hub.findPeer(session.profile, "tester:202")?.currentFocus).toBeUndefined();
  });

  it("shares blackboard values globally across CLI sessions", async () => {
    await call("share_data", { key: "api-contract", value: "GET /v1/health" });

    const otherSession = { profile: "other", peerId: "other:2", projectKey: "different-project" };
    const response = await handleMcpRpcRequest(hub, otherSession, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_shared_data", arguments: { key: "api-contract" } }
    });
    const result = JSON.parse((response?.result as any).content[0].text);

    expect(result).toMatchObject({ found: true, value: "GET /v1/health", author: session.profile });
  });

  it("records the notifying CLI instance in the supervisor inbox", async () => {
    const result = await call("notify_supervisor", { kind: "status", message: "still processing" });

    expect(result.status).toBe("delivered");
    expect(hub.listSupervisorMessages()).toMatchObject([
      { from: session.profile, fromPeerId: session.peerId, message: "still processing" }
    ]);
  });

  it("distinguishes an execution error from a deferred wait", async () => {
    hub.setAutoResponder(async () => ({ error: "Not logged in" }));

    const result = await call("ask_peer", {
      to: "offline",
      question: "run task",
      timeout_seconds: 1,
      allow_offline_execution: true
    });

    expect(result).toMatchObject({ status: "error", error: "Not logged in" });
    expect(result.suggestion).toContain("execution failed");
  });
});
