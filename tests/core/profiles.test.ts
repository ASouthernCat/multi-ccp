import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createApiProfile, createLoginProfile, listProfiles, profileExists, removeProfile, resolveConfigDir } from "../../src/core/profiles.js";
import { getProfilesRoot, getProjectKey } from "../../src/core/paths.js";
import { deleteSessionProject, deleteSessionProjectSession, listSessionProjects, parseSelectionText, scanSessionProject, syncSessionProject, syncSessions } from "../../src/core/sessions.js";
import { removeProfileDir } from "../../src/core/settings.js";

async function createContext() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-test-"));
  return { homeDir };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
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

  it("creates API profiles without model env when model is omitted", async () => {
    const context = await createContext();
    const profile = await createApiProfile(
      { name: "apiDefaultModel", baseUrl: "https://api.aicodemirror.com/api/claudecode", token: "", model: "" },
      context
    );

    expect(profile.type).toBe("api");
    expect(profile.baseUrl).toBe("https://api.aicodemirror.com/api/claudecode");
    expect(profile.model).toBe("");
    expect(profile.tokenStatus).toBe("missing");

    const settings = JSON.parse(await readFile(path.join(profile.dir, "settings.json"), "utf8"));
    expect(settings.env).toEqual({
      ANTHROPIC_AUTH_TOKEN: "REPLACE_WITH_FULL_TOKEN",
      ANTHROPIC_BASE_URL: "https://api.aicodemirror.com/api/claudecode"
    });
  });

  it("lists profiles sorted by name", async () => {
    const context = await createContext();
    await createLoginProfile({ name: "zeta" }, context);
    await createLoginProfile({ name: "alpha" }, context);

    const profiles = await listProfiles(context);
    expect(profiles.map((item) => item.name)).toEqual(["alpha", "zeta"]);
  });

  it("does not treat empty profile directories as valid profiles", async () => {
    const context = await createContext();
    const dir = path.join(getProfilesRoot(context), "emptyProfile");
    await mkdir(dir, { recursive: true });

    expect(await profileExists("emptyProfile", context)).toBe(false);
    await expect(resolveConfigDir("emptyProfile", { allowMain: false, context }))
      .rejects.toThrow("is not a valid profile");
  });

  it("cleans empty stale profile directories before creating a profile", async () => {
    const context = await createContext();
    const dir = path.join(getProfilesRoot(context), "staleEmpty");
    await mkdir(dir, { recursive: true });

    const profile = await createLoginProfile({ name: "staleEmpty" }, context);

    expect(profile.dir).toBe(dir);
    expect(JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"))).toEqual({ theme: "dark" });
  });

  it("does not overwrite non-empty invalid profile directories when creating a profile", async () => {
    const context = await createContext();
    const dir = path.join(getProfilesRoot(context), "staleNonEmpty");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "note.txt"), "keep me", "utf8");

    await expect(createLoginProfile({ name: "staleNonEmpty" }, context)).rejects.toThrow("is not a valid profile");
    expect(await readFile(path.join(dir, "note.txt"), "utf8")).toBe("keep me");
  });

  it("reads legacy PowerShell JSON files with a UTF-8 BOM", async () => {
    const context = await createContext();
    const dir = path.join(getProfilesRoot(context), "legacyApi");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "settings.json"),
      JSON.stringify({ theme: "dark", env: { ANTHROPIC_BASE_URL: "https://example.test/anthropic", ANTHROPIC_AUTH_TOKEN: "secret", ANTHROPIC_MODEL: "claude-test" } }),
      "utf8"
    );
    await writeFile(
      path.join(dir, ".ccp.json"),
      String.fromCharCode(0xfeff) + JSON.stringify({ version: 1, type: "api", createdAt: "2026-01-01T00:00:00.000Z" }),
      "utf8"
    );

    const profiles = await listProfiles(context);
    expect(profiles[0].name).toBe("legacyApi");
    expect(profiles[0].type).toBe("api");
    expect(profiles[0].model).toBe("claude-test");
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

  it("scans profile projects and syncs selected sessions with overwrite choices", async () => {
    const context = await createContext();
    const cwd = path.join(context.homeDir, "project");
    const projectKey = getProjectKey(cwd);
    const mainDir = path.join(context.homeDir, ".claude");
    const target = await createLoginProfile({ name: "target" }, context);
    const sourceProjectDir = path.join(mainDir, "projects", projectKey);
    const targetProjectDir = path.join(target.dir, "projects", projectKey);

    await mkdir(path.join(sourceProjectDir, "new-session"), { recursive: true });
    await mkdir(targetProjectDir, { recursive: true });
    await writeFile(
      path.join(sourceProjectDir, "new-session.jsonl"),
      JSON.stringify({ type: "user", message: { content: "new source" } }) + "\n",
      "utf8"
    );
    await writeFile(path.join(sourceProjectDir, "new-session", "asset.txt"), "asset", "utf8");
    await writeFile(
      path.join(sourceProjectDir, "conflict-session.jsonl"),
      JSON.stringify({ type: "user", message: { content: "source conflict" } }) + "\n",
      "utf8"
    );
    await writeFile(
      path.join(targetProjectDir, "conflict-session.jsonl"),
      JSON.stringify({ type: "user", message: { content: "target conflict" } }) + "\n",
      "utf8"
    );

    const projects = await listSessionProjects({ sourceName: "main", targetName: "target", context });
    expect(projects.sourceProjects[0].projectKey).toBe(projectKey);
    expect(projects.sourceProjects[0].matchedInTarget).toBe(true);

    const scan = await scanSessionProject({ sourceName: "main", targetName: "target", projectKey, context });
    expect(scan.counts.copied).toBe(1);
    expect(scan.counts.conflict).toBe(1);

    const result = await syncSessionProject({
      sourceName: "main",
      targetName: "target",
      projectKey,
      context,
      selections: [
        { name: "new-session.jsonl", action: "sync" },
        { name: "conflict-session.jsonl", action: "overwrite" }
      ]
    });

    expect(result.counts.copied).toBe(1);
    expect(result.counts.overwritten).toBe(1);
    expect(await readFile(path.join(targetProjectDir, "new-session.jsonl"), "utf8")).toContain("new source");
    expect(await readFile(path.join(targetProjectDir, "new-session", "asset.txt"), "utf8")).toBe("asset");
    expect(await readFile(path.join(targetProjectDir, "conflict-session.jsonl"), "utf8")).toContain("source conflict");
  });

  it("deletes source session projects and individual source sessions", async () => {
    const context = await createContext();
    const cwd = path.join(context.homeDir, "project");
    const projectKey = getProjectKey(cwd);
    const mainDir = path.join(context.homeDir, ".claude");
    const projectDir = path.join(mainDir, "projects", projectKey);

    await mkdir(path.join(projectDir, "remove-session"), { recursive: true });
    await writeFile(path.join(projectDir, "remove-session.jsonl"), "remove session\n", "utf8");
    await writeFile(path.join(projectDir, "remove-session", "asset.txt"), "asset", "utf8");
    await writeFile(path.join(projectDir, "keep-session.jsonl"), "keep session\n", "utf8");

    const removedSession = await deleteSessionProjectSession({
      sourceName: "main",
      projectKey,
      sessionName: "remove-session.jsonl",
      context
    });

    expect(removedSession.removedSession).toBe(true);
    expect(removedSession.removedAssets).toBe(true);
    expect(await pathExists(path.join(projectDir, "remove-session.jsonl"))).toBe(false);
    expect(await pathExists(path.join(projectDir, "remove-session"))).toBe(false);
    expect(await readFile(path.join(projectDir, "keep-session.jsonl"), "utf8")).toContain("keep session");

    await expect(deleteSessionProjectSession({
      sourceName: "main",
      projectKey,
      sessionName: "../keep-session.jsonl",
      context
    })).rejects.toThrow("Invalid session name");

    const removedProject = await deleteSessionProject({ sourceName: "main", projectKey, context });
    expect(removedProject.removed).toBe(true);
    expect(await pathExists(projectDir)).toBe(false);
  });

  it("accepts periods in profile names", async () => {
    const context = await createContext();
    await createLoginProfile({ name: "gpt-5.6" }, context);

    const resolved = await resolveConfigDir("gpt-5.6", { allowMain: false, context });
    expect(resolved.dir).toBe(path.join(getProfilesRoot(context), "gpt-5.6"));
  });

  it.each(["_bad", "bad.", "bad/name", "bad\\name", "CON", "con.txt"])(
    "rejects invalid profile name %s",
    async (name) => {
      const context = await createContext();
      await expect(createLoginProfile({ name }, context)).rejects.toThrow("Invalid profile name");
    }
  );

  it("rejects path traversal when resolving profile directories", async () => {
    const context = await createContext();
    const escapedDir = path.join(getProfilesRoot(context), "..", "escaped-profile");
    await mkdir(escapedDir, { recursive: true });

    await expect(resolveConfigDir("../escaped-profile", { allowMain: false, context }))
      .rejects.toThrow("Invalid profile name");
  });

  it("resolves and removes profile directories", async () => {
    const context = await createContext();
    await createLoginProfile({ name: "removeMe" }, context);
    const resolved = await resolveConfigDir("removeMe", { allowMain: false, context });
    expect(resolved.dir).toBe(path.join(getProfilesRoot(context), "removeMe"));

    await removeProfile("removeMe", context);
    await expect(resolveConfigDir("removeMe", { allowMain: false, context })).rejects.toThrow("does not exist");
  });

  it("removes stale profile directories even when settings are missing", async () => {
    const context = await createContext();
    const staleDir = path.join(getProfilesRoot(context), "staleRemove");
    await mkdir(staleDir, { recursive: true });

    await removeProfile("staleRemove", context);

    expect(await pathExists(staleDir)).toBe(false);
  });

  it("retries transient Windows delete locks when removing profile directories", async () => {
    const busy = Object.assign(new Error("busy"), { code: "EBUSY", path: "locked-file" });
    const remove = vi.fn()
      .mockRejectedValueOnce(busy)
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await removeProfileDir("locked-profile", { remove, sleep, maxAttempts: 2 });

    expect(remove).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("retries when a recursive delete reports success but leaves the directory behind", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const exists = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await removeProfileDir("left-behind-profile", { remove, pathExists: exists, sleep, maxAttempts: 2 });

    expect(remove).toHaveBeenCalledTimes(2);
    expect(exists).toHaveBeenCalledWith("left-behind-profile");
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it("preserves the original transient delete error after retries are exhausted", async () => {
    const denied = Object.assign(new Error("denied"), { code: "EACCES", path: "locked-file" });
    const remove = vi.fn().mockRejectedValue(denied);
    const sleep = vi.fn().mockResolvedValue(undefined);
    let thrown: unknown;

    try {
      await removeProfileDir("locked-profile", { remove, sleep, maxAttempts: 2 });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("locked-file");
    expect((thrown as Error & { cause?: unknown }).cause).toBe(denied);
    expect(remove).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
  });
});
