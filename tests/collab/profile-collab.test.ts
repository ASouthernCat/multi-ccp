import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureProfileCollabConfig, COLLAB_APPROVED_TOOLS } from "../../src/collab/profile-collab.js";
import { readSettings, writeSettings } from "../../src/core/settings.js";

describe("Profile Collab Injection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), "ccp-test-profile-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("injects mcpServers and approvedTools into an empty profile settings", async () => {
    await writeSettings(tempDir, {});

    const settings = await ensureProfileCollabConfig(tempDir, "my-agent");

    expect(settings.mcpServers).toBeDefined();
    const collabMcp = (settings.mcpServers as any)["ccp-collab"];
    expect(collabMcp).toEqual({
      command: "ccp",
      args: ["mcp", "--profile", "my-agent"]
    });

    expect(settings.approvedTools).toBeDefined();
    for (const tool of COLLAB_APPROVED_TOOLS) {
      expect(settings.approvedTools).toContain(tool);
      expect(((settings.permissions as any).allow as string[])).toContain(tool);
    }

    const saved = await readSettings(tempDir);
    expect(saved?.mcpServers).toEqual(settings.mcpServers);
    expect(saved?.approvedTools).toEqual(settings.approvedTools);

    const skillContent = await import("node:fs/promises").then(fs =>
      fs.readFile(path.join(tempDir, "skills", "multi-agent-collab", "SKILL.md"), "utf8")
    );
    expect(skillContent).toContain("multi-agent-collab");
    expect(skillContent).toContain("ask_peer");
    expect(skillContent).toContain("额度耗尽");
    expect(skillContent).toContain("接管未完成工作");
    expect(skillContent).toContain("直接调用 `mcp__ccp-collab__read_peer_context`");
    expect(skillContent).toContain("禁止调用 `ask_peer` 或 `send_task`");
    expect(skillContent).toContain("mcp__ccp-collab__notify_supervisor");
    expect(skillContent).toContain("禁止对 Web UI 调用 `ask_peer`、`send_task` 或 `reply_peer`");
    expect(skillContent).toContain("Web UI 是用户操作的上层监管界面，不是另一个 Agent CLI");
    expect(skillContent).toContain("同一个 `reply_to_id` 只能调用一次");
    expect(skillContent).toContain("`delivered` 或 `duplicate_ignored` 后必须停止");
  });

  it("preserves existing mcpServers and custom approved tools", async () => {
    await writeSettings(tempDir, {
      theme: "dark",
      mcpServers: {
        "custom-server": { command: "node", args: ["server.js"] }
      },
      approvedTools: ["Bash", "FileRead"]
    });

    const settings = await ensureProfileCollabConfig(tempDir, "dev");

    expect(settings.theme).toBe("dark");
    expect((settings.mcpServers as any)["custom-server"]).toEqual({ command: "node", args: ["server.js"] });
    expect((settings.mcpServers as any)["ccp-collab"]).toEqual({ command: "ccp", args: ["mcp", "--profile", "dev"] });
    expect(settings.approvedTools).toContain("Bash");
    expect(settings.approvedTools).toContain("FileRead");
    expect(settings.approvedTools).toContain("mcp__ccp-collab__ask_peer");
    expect(((settings.permissions as any).allow as string[])).toContain("mcp__ccp-collab__ask_peer");
  });

  it("preserves existing permission rules while approving collaboration tools", async () => {
    await writeSettings(tempDir, {
      permissions: { allow: ["Bash(npm test *)"], deny: ["Read(.env)"] }
    });

    const settings = await ensureProfileCollabConfig(tempDir, "dev");
    const permissions = settings.permissions as any;

    expect(permissions.allow).toContain("Bash(npm test *)");
    expect(permissions.allow).toContain("mcp__ccp-collab__ask_peer");
    expect(permissions.deny).toEqual(["Read(.env)"]);
  });

  it("is idempotent when run repeatedly", async () => {
    await ensureProfileCollabConfig(tempDir, "dev");
    const first = await readSettings(tempDir);

    await ensureProfileCollabConfig(tempDir, "dev");
    const second = await readSettings(tempDir);

    expect(second).toEqual(first);
  });

  it("repairs a collaboration MCP entry that points at the wrong profile", async () => {
    await writeSettings(tempDir, {
      mcpServers: {
        "ccp-collab": { command: "ccp", args: ["mcp", "--profile", "old-profile"] }
      }
    });

    const settings = await ensureProfileCollabConfig(tempDir, "new-profile");

    expect((settings.mcpServers as any)["ccp-collab"]).toEqual({
      command: "ccp",
      args: ["mcp", "--profile", "new-profile"]
    });
  });
});
