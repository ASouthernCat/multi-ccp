import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createApiProfile, createCcrProfile, createLoginProfile, listProfiles, removeProfile, resolveConfigDir } from "../../src/core/profiles.js";
import { getProfilesRoot } from "../../src/core/paths.js";

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
