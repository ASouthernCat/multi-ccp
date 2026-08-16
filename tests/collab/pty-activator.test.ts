import { afterEach, describe, it, expect, vi } from "vitest";
import { CollabHub } from "../../src/collab/hub.js";
import {
  createCollabTerminalSession,
  formatCollabPrompt,
  formatCollabBanner
} from "../../src/collab/pty-activator.js";
import type { CollabMessage } from "../../src/collab/types.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("PTY Activator and Prompt Injector", () => {
  it("highlights the collaboration type and sending agent in terminal banners", () => {
    const banner = formatCollabBanner({
      id: "event-1",
      from: "grok",
      to: "ds",
      projectKey: "proj-1",
      type: "event",
      content: "ASYNC-RESULT",
      traceId: "trace-1",
      hopCount: 1,
      createdAt: Date.now()
    });

    expect(banner).toContain("[协作结果 / 完成通知]");
    expect(banner).toContain("@grok");
    expect(banner).toContain("\x1b[1;32m");
    expect(banner).toContain("\x1b[1;36m");
  });

  it("formats collaboration prompts accurately", () => {
    const askMsg: CollabMessage = {
      id: "msg-123",
      from: "architect",
      to: "backend",
      projectKey: "proj-1",
      type: "ask",
      content: "Please provide user login schema",
      context: "Frontend login form development",
      expectedFormat: "TypeScript interface",
      traceId: "t-1",
      hopCount: 1,
      createdAt: Date.now()
    };

    const prompt = formatCollabPrompt(askMsg);
    expect(prompt).toContain("[来自 @architect 的跨 Agent 协作消息 (ASK)]");
    expect(prompt).toContain("Please provide user login schema");
    expect(prompt).toContain("Frontend login form development");
    expect(prompt).toContain("TypeScript interface");
    expect(prompt).toContain('reply_to_id: "msg-123"');
  });

  it("formats supervisor relay instructions without treating Web UI as a peer", () => {
    const prompt = formatCollabPrompt({
      id: "supervisor-1",
      from: "web-ui",
      to: "agent-a",
      projectKey: "proj-1",
      type: "task",
      content: "Ask agent-b to review auth.ts",
      origin: "supervisor",
      responsePolicy: "none",
      relayTo: "agent-b",
      traceId: "trace-1",
      hopCount: 1,
      createdAt: Date.now()
    });

    expect(prompt).toContain("来自 Web UI 监管台的指令");
    expect(prompt).toContain("你作为实际发送方");
    expect(prompt).toContain("@agent-b 完成后只需回复你");
    expect(prompt).not.toContain("reply_peer");
  });

  it("correlates supervisor result reports with the dispatched message", () => {
    const prompt = formatCollabPrompt({
      id: "supervisor-correlated",
      from: "web-ui",
      to: "agent-a",
      projectKey: "proj-1",
      type: "task",
      content: "Run verification",
      origin: "supervisor",
      responsePolicy: "supervisor",
      traceId: "trace-1",
      hopCount: 1,
      createdAt: Date.now()
    });

    expect(prompt).toContain('related_message_id: "supervisor-correlated"');
  });

  it("removes terminal control sequences from injected collaboration prompts", () => {
    const prompt = formatCollabPrompt({
      id: "msg-control",
      from: "grok\x1b[31m",
      to: "ds",
      projectKey: "proj-1",
      type: "event",
      content: "done\x1b]0;spoofed\x07",
      traceId: "trace-control",
      hopCount: 1,
      createdAt: Date.now()
    });

    expect(prompt).not.toContain("\x1b");
    expect(prompt).not.toContain("\x07");
    expect(prompt).not.toContain("spoofed");
    expect(prompt).toContain("@grok");
  });

  it("injects prompts and a separate submit key when messages arrive from hub", async () => {
    const hub = new CollabHub();
    const writtenChunks: string[] = [];
    const childStdin = {
      write: vi.fn((chunk: string) => {
        writtenChunks.push(chunk);
        return true;
      })
    };

    const session = createCollabTerminalSession({
      profile: "target-agent",
      projectKey: "proj-1",
      childStdin,
      hub
    });

    void hub.sendMessage({
      from: "sender-agent",
      to: "target-agent",
      projectKey: "proj-1",
      type: "task",
      content: "Run test coverage check",
      waitForReply: false
    });

    expect(childStdin.write).toHaveBeenCalled();
    expect(writtenChunks[0]).toContain("[来自 @sender-agent 的跨 Agent 协作消息 (TASK)]");
    expect(writtenChunks[0]).toContain("Run test coverage check");
    expect(writtenChunks[0].endsWith("\r")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(writtenChunks[1]).toBe("\r");

    session.close();
  });

  it("throttles activity reports and preserves higher-value PTY output activity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const session = createCollabTerminalSession({
      profile: "target-agent",
      peerId: "target-agent:4321",
      projectKey: "proj-1",
      gatewayEndpoint: "http://127.0.0.1:3921"
    });

    session.reportActivity("input");
    session.reportActivity("tool");
    session.reportActivity("output");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/mcp/collab/sse?");
    expect(fetchMock.mock.calls[0]?.[0]).toContain("peerId=target-agent%3A4321");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("peerId=target-agent%3A4321");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("kind=input");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toContain("kind=output");

    session.close();
  });
});
