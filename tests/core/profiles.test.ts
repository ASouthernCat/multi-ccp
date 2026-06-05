import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApiProfile, createCcrProfile, createLoginProfile, listProfiles, removeProfile, resolveConfigDir } from "../../src/core/profiles.js";
import { getProfilesRoot, getProjectKey } from "../../src/core/paths.js";
import { parseSelectionText, syncSessions } from "../../src/core/sessions.js";

async function createContext() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-test-"));
  return { homeDir };
}

describe("profiles", () => {
  it("creates login profiles without API env", async () => {
    const context = await createContext();
    const profile = await createLoginProfile({ name: "claudeA" }, context);

    expect(profile.name).toBe("claudeA");
    expect(profile.type).toBe("login");
    expect(profile.model).toBe("login");
    expect(profile.tokenStatus).toBe("missing");

    const settings = JSON.parse(await readFile(path.join(profile.dir, "settings.json"), "utf8"));
    expect(settings).toEqual({ theme: "dark" });
  });

  it("creates API profiles with Claude model env", async () => {
    const context = await createContext();
    const profile = await createApiProfile(
      { name: "apiA", baseUrl: "https://example.test", token: "secret", model: "claude-test" },
      context
    );

    expect(profile.type).toBe("api");
    expect(profile.baseUrl).toBe("https://example.test");
    expect(profile.model).toBe("claude-test");
    expect(profile.tokenStatus).toBe("set");

    const settings = JSON.parse(await readFile(path.join(profile.dir, "settings.json"), "utf8"));
    expect(settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe("claude-test");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-test");
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-test");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME).toBeUndefined();
    expect(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME).toBeUndefined();
  });


  it("creates CCR profiles and preset manifests", async () => {
    const context = await createContext();
    const ccrDir = path.join(context.homeDir, ".claude-code-router");
    await mkdir(ccrDir, { recursive: true });
    await writeFile(
      path.join(ccrDir, "config.json"),
      JSON.stringify({
        HOST: "0.0.0.0",
        PORT: 3456,
        Providers: [{ name: "openai", api_base_url: "https://example.test", models: ["gpt-test"] }],
        Router: { longContextThreshold: 12345 }
      }),
      "utf8"
    );

    const profile = await createCcrProfile({ name: "ccrTest", route: "openai,gpt-test", token: "" }, context);
    expect(profile.type).toBe("ccr");
    expect(profile.baseUrl).toBe("http://127.0.0.1:3456/preset/ccrTest");
    expect(profile.model).toBe("ccr:openai,gpt-test");

    const manifest = JSON.parse(
      await readFile(path.join(ccrDir, "presets", "ccrTest", "manifest.json"), "utf8")
    );
    expect(manifest.Router.default).toBe("openai,gpt-test");
    expect(manifest.Router.longContextThreshold).toBe(12345);
  });

  it("lists profiles sorted by name", async () => {
    const context = await createContext();
    await createLoginProfile({ name: "zeta" }, context);
    await createLoginProfile({ name: "alpha" }, context);

    const profiles = await listProfiles(context);
    expect(profiles.map((item) => item.name)).toEqual(["alpha", "zeta"]);
  });


  it("reads legacy PowerShell JSON files with a UTF-8 BOM", async () => {
    const context = await createContext();
    const dir = path.join(getProfilesRoot(context), "legacyCcr");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:3456/preset/legacyCcr" } }),
      "utf8"
    );
    await writeFile(
      path.join(dir, ".ccp.json"),
      String.fromCharCode(0xfeff) + JSON.stringify({ version: 1, type: "ccr", ccrRoute: "openai,gpt-5.5" }),
      "utf8"
    );

    const profiles = await listProfiles(context);
    expect(profiles[0].name).toBe("legacyCcr");
    expect(profiles[0].type).toBe("ccr");
    expect(profiles[0].model).toBe("ccr:openai,gpt-5.5");
  });


  it("parses sync session selections", () => {
    expect(parseSelectionText("1 3-4", 5)).toEqual([0, 2, 3]);
    expect(parseSelectionText("2,2,5", 5)).toEqual([1, 4]);
    expect(() => parseSelectionText("4-2", 5)).toThrow("Invalid range");
  });

  it("syncs session logs and assets with --all", async () => {
    const context = await createContext();
    const cwd = path.join(context.homeDir, "project");
    const projectKey = getProjectKey(cwd);
    const mainDir = path.join(context.homeDir, ".claude");
    const target = await createLoginProfile({ name: "target" }, context);
    const sourceProjectDir = path.join(mainDir, "projects", projectKey);
    const sessionId = "abc123";
    await mkdir(path.join(sourceProjectDir, sessionId), { recursive: true });
    await writeFile(
      path.join(sourceProjectDir, sessionId + ".jsonl"),
      JSON.stringify({ type: "user", message: { content: "hello sync" } }) + "\n",
      "utf8"
    );
    await writeFile(path.join(sourceProjectDir, sessionId, "asset.txt"), "asset", "utf8");

    const result = await syncSessions({ first: "target", args: ["--all"], cwd, context });
    expect(result?.counts.copied).toBe(1);
    expect(await readFile(path.join(target.dir, "projects", projectKey, sessionId + ".jsonl"), "utf8")).toContain("hello sync");
    expect(await readFile(path.join(target.dir, "projects", projectKey, sessionId, "asset.txt"), "utf8")).toBe("asset");
  });

  it("rejects invalid profile names", async () => {
    const context = await createContext();
    await expect(createLoginProfile({ name: "_bad" }, context)).rejects.toThrow("Invalid profile name");
  });

  it("resolves and removes profile directories", async () => {
    const context = await createContext();
    await createLoginProfile({ name: "removeMe" }, context);
    const resolved = await resolveConfigDir("removeMe", { allowMain: false, context });
    expect(resolved.dir).toBe(path.join(getProfilesRoot(context), "removeMe"));

    await removeProfile("removeMe", context);
    await expect(resolveConfigDir("removeMe", { allowMain: false, context })).rejects.toThrow("does not exist");
  });
});
