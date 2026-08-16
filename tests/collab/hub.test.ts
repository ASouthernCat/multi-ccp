import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollabHub } from "../../src/collab/hub.js";

describe("CollabHub", () => {
  let hub: CollabHub;

  beforeEach(() => {
    hub = new CollabHub();
  });

  afterEach(() => {
    hub.clear();
    vi.useRealTimers();
  });

  it("keeps every running CLI instance as an independent peer", () => {
    hub.registerPeer({ peerId: "worker:1001", profile: "worker", projectKey: "project-a", pid: 1001 });
    hub.registerPeer({ peerId: "worker:1002", profile: "worker", projectKey: "project-b", pid: 1002 });

    expect(hub.listPeers({ projectKey: "unrelated-project" })).toMatchObject([
      { peerId: "worker:1001", profile: "worker", pid: 1001 },
      { peerId: "worker:1002", profile: "worker", pid: 1002 }
    ]);
    expect(hub.findPeer("worker")).toBeUndefined();
    expect(hub.findPeer("worker", "worker:1002")?.projectKey).toBe("project-b");
  });

  it("routes to an exact peerId and ignores project metadata", async () => {
    const first: string[] = [];
    const second: string[] = [];
    hub.registerPeer({ peerId: "worker:1", profile: "worker", projectKey: "one" });
    hub.registerPeer({ peerId: "worker:2", profile: "worker", projectKey: "two" });
    hub.subscribe("worker", "one", (message) => first.push(message.content), "worker:1");
    hub.subscribe("worker", "two", (message) => second.push(message.content), "worker:2");

    const result = await hub.sendMessage({
      from: "sender",
      fromPeerId: "sender:9",
      to: "worker",
      toPeerId: "worker:2",
      projectKey: "completely-different-project",
      type: "task",
      content: "target the second CLI"
    });

    expect(result.status).toBe("delivered");
    expect(first).toEqual([]);
    expect(second).toEqual(["target the second CLI"]);
    expect(hub.getDispatch(result.messageId)).toMatchObject({
      fromPeerId: "sender:9",
      toPeerId: "worker:2",
      status: "waiting"
    });
  });

  it("rejects an ambiguous profile when peerId is omitted", async () => {
    hub.registerPeer({ peerId: "worker:1", profile: "worker", projectKey: "one" });
    hub.registerPeer({ peerId: "worker:2", profile: "worker", projectKey: "two" });
    hub.subscribe("worker", "one", () => undefined, "worker:1");
    hub.subscribe("worker", "two", () => undefined, "worker:2");

    const result = await hub.sendMessage({
      from: "sender",
      to: "worker",
      projectKey: "one",
      type: "task",
      content: "ambiguous"
    });

    expect(result).toMatchObject({ status: "error" });
    expect(result.error).toContain("multiple CLI instances");
    expect(result.error).toContain("peerId");
    expect(hub.listDispatches()).toHaveLength(0);
  });

  it("queues by profile while offline and binds the task when one CLI connects", async () => {
    const result = await hub.sendMessage({
      from: "sender",
      to: "worker",
      projectKey: "project-a",
      type: "task",
      content: "queued task"
    });
    expect(result).toMatchObject({ status: "queued", responseStatus: "pending" });

    const received: string[] = [];
    hub.registerPeer({ peerId: "worker:44", profile: "worker", projectKey: "project-b" });
    hub.subscribe("worker", "project-b", (message) => received.push(message.content), "worker:44");

    expect(received).toEqual(["queued task"]);
    expect(hub.getDispatch(result.messageId)).toMatchObject({
      toPeerId: "worker:44",
      deliveryStatus: "delivered",
      status: "waiting"
    });
  });

  it("uses terminal activity to keep a long-running task in processing", async () => {
    vi.useFakeTimers();
    hub.registerPeer({ peerId: "worker:7", profile: "worker", projectKey: "one" });
    hub.subscribe("worker", "one", () => undefined, "worker:7");
    const task = await hub.sendMessage({
      from: "sender",
      to: "worker",
      toPeerId: "worker:7",
      projectKey: "two",
      type: "task",
      content: "think carefully"
    });

    for (let minute = 0; minute < 8; minute += 1) {
      vi.advanceTimersByTime(60_000);
      hub.recordPeerActivity("worker:7", "output");
    }

    expect(hub.getDispatch(task.messageId)).toMatchObject({ status: "processing", targetOnline: true });
    expect(hub.findPeer("worker", "worker:7")?.responseState).toBe("processing");
  });

  it("marks an online but inactive CLI as stalled instead of timed out", async () => {
    vi.useFakeTimers();
    hub.registerPeer({ peerId: "worker:8", profile: "worker", projectKey: "one" });
    hub.subscribe("worker", "one", () => undefined, "worker:8");
    const task = await hub.sendMessage({
      from: "sender",
      to: "worker",
      toPeerId: "worker:8",
      projectKey: "one",
      type: "task",
      content: "wait"
    });

    vi.advanceTimersByTime(2 * 60 * 1000 + 1);
    hub.heartbeat("worker", "worker:8");
    hub.refreshDispatchHealth();

    expect(hub.getDispatch(task.messageId)?.status).toBe("stalled");
    expect(hub.findPeer("worker", "worker:8")?.responseState).toBe("stalled");
  });

  it("keeps a peer declared busy in processing during long model thinking", async () => {
    vi.useFakeTimers();
    hub.registerPeer({ peerId: "worker:81", profile: "worker", projectKey: "one", status: "idle" });
    hub.subscribe("worker", "one", () => undefined, "worker:81");
    const task = await hub.sendMessage({
      from: "sender",
      to: "worker",
      toPeerId: "worker:81",
      projectKey: "one",
      type: "task",
      content: "long reasoning"
    });

    hub.updatePeerFocus({ profile: "worker", peerId: "worker:81", projectKey: "one", status: "busy" });
    vi.advanceTimersByTime(8 * 60 * 1000);
    hub.heartbeat("worker", "worker:81");
    hub.refreshDispatchHealth();

    expect(hub.getDispatch(task.messageId)).toMatchObject({ status: "processing", targetOnline: true });
    expect(hub.findPeer("worker", "worker:81")?.responseState).toBe("processing");
  });

  it("marks an injected task disconnected when its exact CLI connection closes", async () => {
    hub.registerPeer({ peerId: "worker:9", profile: "worker", projectKey: "one" });
    const unsubscribe = hub.subscribe("worker", "one", () => undefined, "worker:9");
    const task = await hub.sendMessage({
      from: "sender",
      to: "worker",
      toPeerId: "worker:9",
      projectKey: "one",
      type: "task",
      content: "disconnect"
    });

    unsubscribe();
    expect(hub.getDispatch(task.messageId)).toMatchObject({ status: "disconnected", targetOnline: false });
  });

  it("treats ask timeoutSeconds as a wait window and accepts a late reply", async () => {
    vi.useFakeTimers();
    const replies: string[] = [];
    hub.registerPeer({ peerId: "asker:1", profile: "asker", projectKey: "one" });
    hub.registerPeer({ peerId: "answerer:2", profile: "answerer", projectKey: "two" });
    hub.subscribe("asker", "one", (message) => replies.push(message.content), "asker:1");
    hub.subscribe("answerer", "two", () => undefined, "answerer:2");

    const pending = hub.sendMessage({
      from: "asker",
      fromPeerId: "asker:1",
      to: "answerer",
      toPeerId: "answerer:2",
      projectKey: "one",
      type: "ask",
      content: "slow question",
      waitForReply: true,
      timeoutSeconds: 0.05
    });
    await vi.advanceTimersByTimeAsync(50);
    const deferred = await pending;

    expect(deferred).toMatchObject({ status: "deferred", responseStatus: "waiting" });
    expect(hub.getDispatch(deferred.messageId)?.status).toBe("waiting");

    expect(hub.replyMessage({
      from: "answerer",
      fromPeerId: "answerer:2",
      to: "asker",
      toPeerId: "asker:1",
      replyToId: deferred.messageId,
      projectKey: "another-project",
      result: "late but valid"
    })).toBe("delivered");
    await vi.runAllTimersAsync();

    expect(hub.getDispatch(deferred.messageId)?.status).toBe("completed");
    expect(replies).toEqual(["late but valid"]);
  });

  it("returns an immediate synchronous reply when it arrives inside the wait window", async () => {
    hub.registerPeer({ peerId: "answerer:3", profile: "answerer", projectKey: "two" });
    hub.subscribe("answerer", "two", (message) => {
      hub.replyMessage({
        from: "answerer",
        fromPeerId: "answerer:3",
        to: "asker",
        replyToId: message.id,
        projectKey: "two",
        result: "ready"
      });
    }, "answerer:3");

    const result = await hub.sendMessage({
      from: "asker",
      to: "answerer",
      toPeerId: "answerer:3",
      projectKey: "one",
      type: "ask",
      content: "status?",
      waitForReply: true,
      timeoutSeconds: 1
    });

    expect(result).toMatchObject({ status: "replied", reply: "ready", responseStatus: "completed" });
  });

  it("shares one blackboard across CLI project metadata", () => {
    hub.setBlackboard({ key: "api", value: "v1", author: "agent-a", projectKey: "one" });
    expect(hub.getBlackboard("api", "two")?.value).toBe("v1");

    hub.setBlackboard({ key: "api", value: "v2", author: "agent-b", projectKey: "two" });
    expect(hub.listBlackboard("one")).toMatchObject([{ key: "api", value: "v2", author: "agent-b" }]);
    expect(hub.listBlackboard("one")[0].projectKey).toBeUndefined();
  });

  it("lists supervisor messages globally regardless of project metadata", () => {
    hub.notifySupervisor({ from: "a", fromPeerId: "a:1", projectKey: "one", message: "first" });
    hub.notifySupervisor({ from: "b", fromPeerId: "b:2", projectKey: "two", message: "second" });

    expect(hub.listSupervisorMessages({ projectKey: "one" })).toHaveLength(2);
    expect(hub.listSupervisorMessages()[0]).toMatchObject({ from: "b", fromPeerId: "b:2" });
  });
});
