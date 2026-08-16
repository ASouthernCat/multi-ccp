import { readFile } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

let source = "";
let serverSource = "";

beforeAll(async () => {
  source = await readFile(path.resolve("src/web/assets/app.js"), "utf8");
  serverSource = await readFile(path.resolve("src/web/server.ts"), "utf8");
  source = source.replace(/\r\n/g, "\n");
  serverSource = serverSource.replace(/\r\n/g, "\n");
});

function sliceFunction(startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("Collab Mesh UI contract", () => {
  it("loads the global CLI mesh and dispatch lifecycle data", () => {
    expect(serverSource).toContain("/api/collab/dispatches?limit=100");
    expect(serverSource).not.toContain("uiProjectKey: getProjectKey(process.cwd())");
    expect(source).toContain("reconcileCollabDispatches(collabMeshState.dispatches)");
    expect(source).not.toContain('id="collabProjectScopeSelect"');
    expect(source).toContain("Agent CLI 共享黑板");
  });

  it("does not filter live CLI instances by project metadata", () => {
    expect(source).not.toContain("applyCollabProjectScope");
    expect(source).not.toContain("collabProjectMatches");
    expect(source).toContain("collabMeshState.peers = peers");
    expect(source).toContain("${collabMeshState.peers.length} 个 Agent CLI");
  });

  it("maps backend dispatch states to stable visual states", () => {
    const helperSource = sliceFunction("function normalizeCollabIdentity", "async function openCollabMesh");
    const factory = new Function(
      "collabMeshState",
      "COLLAB_DEMO_PEERS",
      "escapeHtml",
      `${helperSource}; return collabDispatchVisualState;`
    ) as (...args: unknown[]) => (dispatch: Record<string, unknown>) => string;
    const visualState = factory({ peers: [], blackboard: [], dispatches: [] }, [], (value: unknown) => String(value));

    expect(visualState({ status: "pending" })).toBe("pending");
    expect(visualState({ status: "waiting" })).toBe("waiting");
    expect(visualState({ status: "processing" })).toBe("processing");
    expect(visualState({ status: "stalled" })).toBe("stalled");
    expect(visualState({ status: "disconnected" })).toBe("disconnected");
    expect(visualState({ status: "completed" })).toBe("completed");
    expect(visualState({ status: "timeout" })).toBe("error");
    expect(visualState({ status: "error" })).toBe("error");
  });

  it("uses peerId-aware keys for CLI instances with the same profile", () => {
    const helperSource = sliceFunction("function normalizeCollabIdentity", "async function openCollabMesh");
    const peers = [
      { profile: "worker", peerId: "worker:4101" },
      { profile: "worker", peerId: "worker:4102" }
    ];
    const factory = new Function(
      "collabMeshState",
      "COLLAB_DEMO_PEERS",
      `${helperSource}; return { collabPeerKey, collabPeerByKey };`
    ) as (state: Record<string, unknown>, demoPeers: unknown[]) => {
      collabPeerKey: (peer: unknown) => string;
      collabPeerByKey: (key: string) => { peerId: string } | null;
    };
    const helpers = factory({ peers, blackboard: [], simulationMode: false }, []);
    const firstKey = helpers.collabPeerKey(peers[0]);
    const secondKey = helpers.collabPeerKey(peers[1]);

    expect(firstKey).not.toBe(secondKey);
    expect(helpers.collabPeerByKey(firstKey)?.peerId).toBe("worker:4101");
    expect(helpers.collabPeerByKey(secondKey)?.peerId).toBe("worker:4102");
  });

  it("dispatches to the exact target CLI instance", async () => {
    const functionSource = sliceFunction("async function executeSendCollabTask", "function openNodeFlyout");
    const target = { profile: "worker", peerId: "worker:4102", status: "idle" };
    const calls: Array<{ path: string; payload: Record<string, unknown> }> = [];
    const transmission = vi.fn();
    const state = {
      sending: false,
      simulationMode: false,
      tentativeLink: null,
      activeP2pLinks: [],
      activityLogs: [],
      peers: [target],
      messageInput: ""
    };
    const factory = new Function(
      "$",
      "collabMeshState",
      "collabPeerByKey",
      "toast",
      "triggerTransmissionAnimation",
      "api",
      "simulateAgentExecution",
      "closeNodeFlyout",
      "closeBroadcastDispatchModal",
      "syncCollabNodesDom",
      "updateCollabWires",
      `${functionSource}; return executeSendCollabTask;`
    ) as (...args: unknown[]) => (targets: string[], message: string) => Promise<void>;
    const send = factory(
      () => null,
      state,
      (key: string) => key === "target-key" ? target : null,
      vi.fn(),
      transmission,
      async (requestPath: string, options: { body: string }) => {
        calls.push({ path: requestPath, payload: JSON.parse(options.body) as Record<string, unknown> });
      },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn()
    );

    await send(["target-key"], "Run verification");

    expect(calls).toEqual([{
      path: "/api/collab/send",
      payload: {
        from: "web-ui",
        to: "worker",
        peerId: "worker:4102",
        message: "Run verification",
        isAsk: false,
        reportBack: true
      }
    }]);
    expect(transmission).toHaveBeenCalledWith("__hub__", "target-key", "Run verification", "sending");
  });

  it("shows supervisor-to-agent first for delegated peer collaboration", async () => {
    const functionSource = sliceFunction("async function executeSendCollabTask", "function openNodeFlyout");
    const sender = { profile: "architect", peerId: "architect:5101", status: "idle" };
    const target = { profile: "reviewer", peerId: "reviewer:5102", status: "idle" };
    const peersByKey: Record<string, typeof sender> = { "sender-key": sender, "target-key": target };
    const transmission = vi.fn();
    const calls: Array<Record<string, unknown>> = [];
    const state = {
      sending: false,
      simulationMode: false,
      tentativeLink: null,
      activeP2pLinks: [],
      activityLogs: [],
      peers: [sender, target],
      messageInput: ""
    };
    const factory = new Function(
      "$",
      "collabMeshState",
      "collabPeerByKey",
      "toast",
      "triggerTransmissionAnimation",
      "api",
      "simulateAgentExecution",
      "closeNodeFlyout",
      "closeBroadcastDispatchModal",
      "syncCollabNodesDom",
      "updateCollabWires",
      `${functionSource}; return executeSendCollabTask;`
    ) as (...args: unknown[]) => (targets: string[], message: string, from: string) => Promise<void>;
    const send = factory(
      () => null,
      state,
      (key: string) => peersByKey[key] || null,
      vi.fn(),
      transmission,
      async (_path: string, options: { body: string }) => {
        calls.push(JSON.parse(options.body) as Record<string, unknown>);
      },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn()
    );

    await send(["target-key"], "Review the patch", "sender-key");

    expect(transmission).toHaveBeenCalledWith("__hub__", "sender-key", "Review the patch", "sending");
    expect(transmission).not.toHaveBeenCalledWith("sender-key", "target-key", expect.anything(), expect.anything());
    expect(calls[0]).toMatchObject({
      from: "architect",
      sourcePeerId: "architect:5101",
      to: "reviewer",
      peerId: "reviewer:5102"
    });
  });

  it("writes blackboard values through the dedicated endpoint", async () => {
    expect(source).toContain('id="collabCanvasWriteBbBtn"');
    expect(source).toContain("openNodeFlyout('__blackboard__', '', false, '__hub__')");
    const functionSource = sliceFunction("function bindFlyoutEvents", "function resolveTaskPreset");
    const elements: Record<string, any> = {
      collabBlackboardKeyInput: { value: "release-plan", oninput: null },
      collabBlackboardValueInput: { value: "Ship after the regression suite.", oninput: null },
      collabSubmitBlackboardBtn: { disabled: false, onclick: null }
    };
    const calls: Array<{ path: string; payload: Record<string, unknown> }> = [];
    const state = {
      nodeFlyout: { targetProfile: "__blackboard__", sourceProfile: "__hub__", message: "", blackboardKey: "" },
      simulationMode: false,
      blackboard: [],
      activityLogs: []
    };
    const factory = new Function(
      "$",
      "collabMeshState",
      "closeNodeFlyout",
      "triggerTransmissionAnimation",
      "api",
      "loadCollabMeshData",
      "syncCollabNodesDom",
      "updateCollabWires",
      "syncSupervisorPanelDom",
      "toast",
      "executeSendCollabTask",
      "document",
      `${functionSource}; return bindFlyoutEvents;`
    ) as (...args: unknown[]) => () => void;
    const bindFlyout = factory(
      (id: string) => elements[id] || null,
      state,
      vi.fn(),
      vi.fn(),
      async (requestPath: string, options: { body: string }) => {
        calls.push({ path: requestPath, payload: JSON.parse(options.body) as Record<string, unknown> });
      },
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      { querySelectorAll: () => [] }
    );

    bindFlyout();
    await elements.collabSubmitBlackboardBtn.onclick();

    expect(calls).toEqual([{
      path: "/api/collab/blackboard",
      payload: {
        key: "release-plan",
        value: "Ship after the regression suite.",
        author: "web-ui"
      }
    }]);
  });

  it("surfaces an initial dashboard load failure", () => {
    expect(source).toMatch(/bind\(\);\s*load\(\)\.catch\(err => toast\('加载失败: ' \+ err\.message\)\);\s*$/);
  });
});
