import { describe, expect, it, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readPeerContext } from "../../src/collab/peer-context.js";

describe("Peer session context reader", () => {
  const tempHomes: string[] = [];

  afterEach(async () => {
    await Promise.all(tempHomes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
  });

  it("reads the latest bounded transcript without exposing thinking blocks", async () => {
    const homeDir = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "ccp-peer-context-"));
    tempHomes.push(homeDir);
    const projectKey = "D--CodingDev-multi-ccp";
    const profileDir = path.join(homeDir, ".claude-profiles", "peer");
    const projectDir = path.join(profileDir, "projects", projectKey);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(profileDir, "settings.json"), "{}", "utf8");

    const sessionId = "11111111-1111-4111-8111-111111111111";
    const records = [
      { type: "ai-title", aiTitle: "Finish gateway handoff" },
      { type: "user", timestamp: "2026-08-15T12:00:00Z", message: { role: "user", content: "Continue the gateway handoff." } },
      { type: "assistant", message: { role: "assistant", content: [
        { type: "thinking", thinking: "private chain of thought must not be returned" },
        { type: "text", text: "I am checking the handoff state." },
        { type: "tool_use", name: "Read", input: { file_path: "src/collab/hub.ts", api_key: "secret-value" } }
      ] } },
      { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "Authorization: Bearer secret-token\nfailed assertion" }] } },
      { type: "system", subtype: "away_summary", content: "The remaining work is to finish the handoff." }
    ];
    await writeFile(path.join(projectDir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n"), "utf8");

    const result = await readPeerContext({
      profile: "peer",
      projectKey,
      context: { homeDir },
      maxMessages: 10,
      maxChars: 2_000
    });

    expect(result.found).toBe(true);
    expect(result.sessionId).toBe(sessionId);
    expect(result.title).toBe("Finish gateway handoff");
    expect(result.summary).toContain("remaining work");
    expect(result.activeFiles).toContain("src/collab/hub.ts");
    const transcript = result.messages.map((message) => message.text).join("\n");
    expect(transcript).toContain("checking the handoff state");
    expect(transcript).toContain("[tool_use Read]");
    expect(transcript).not.toContain("private chain of thought");
    expect(transcript).not.toContain("secret-token");
    expect(transcript).not.toContain("secret-value");
    expect(transcript).toContain("[REDACTED]");
  });

  it("rejects traversal-like project and session selectors", async () => {
    const result = await readPeerContext({
      profile: "peer",
      projectKey: "../outside",
      context: { homeDir: process.cwd() }
    });

    expect(result.found).toBe(false);
    expect(result.error).toContain("Invalid project key");
  });
});
