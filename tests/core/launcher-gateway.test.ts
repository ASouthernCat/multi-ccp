import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareClaudeLaunch } from "../../src/core/launcher.js";
import { createApiProfile, createGatewayProfile } from "../../src/core/profiles.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.allSettled(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

async function createContext() {
  const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-launcher-gateway-"));
  const cwd = path.join(homeDir, "workspace");
  await mkdir(cwd);
  homes.push(homeDir);
  return { homeDir, cwd };
}

describe("launcher runtime dispatch", () => {
  it("ensures the built-in gateway only for gateway profiles", async () => {
    const context = await createContext();
    const profile = await createGatewayProfile({
      name: "gateway-launch",
      provider: "openai-compatible",
      chatCompletionsUrl: "https://example.test/v1/chat/completions",
      apiKey: "key",
      model: "model"
    }, context);
    const ensureGateway = vi.fn().mockResolvedValue({});
    const ensureCcr = vi.fn().mockResolvedValue(undefined);

    const launch = await prepareClaudeLaunch({
      name: profile.name,
      context,
      cwd: context.cwd,
      claudeArgs: ["--resume"],
      runtimeDeps: {
        ensureBuiltinGatewayProfile: ensureGateway,
        ensureCcrProfileGateway: ensureCcr
      }
    });

    expect(ensureGateway).toHaveBeenCalledWith(profile.dir, profile.name, context);
    expect(ensureCcr).not.toHaveBeenCalled();
    expect(launch).toMatchObject({ command: "claude", args: ["--resume"], cwd: context.cwd });
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(profile.dir);
    expect(launch.env.CCP_PROFILE).toBe(profile.name);
  });

  it("does not start CCR or the built-in gateway for API profiles", async () => {
    const context = await createContext();
    const profile = await createApiProfile({
      name: "api-launch",
      baseUrl: "https://example.test/anthropic",
      token: "key",
      model: "model"
    }, context);
    const ensureGateway = vi.fn();
    const ensureCcr = vi.fn();

    await prepareClaudeLaunch({
      name: profile.name,
      context,
      cwd: context.cwd,
      runtimeDeps: {
        ensureBuiltinGatewayProfile: ensureGateway,
        ensureCcrProfileGateway: ensureCcr
      }
    });

    expect(ensureGateway).not.toHaveBeenCalled();
    expect(ensureCcr).not.toHaveBeenCalled();
  });
});
