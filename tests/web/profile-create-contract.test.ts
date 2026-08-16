import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

type FormValues = Record<string, string | undefined>;

interface CreateCall {
  path: string;
  options: { method?: string; body?: string };
}

interface FakeForm {
  values: FormValues;
  reportValidity: () => boolean;
  querySelector: () => null;
}

async function loadCreateProfileFactory(): Promise<(...args: unknown[]) => () => Promise<void>> {
  const source = (await readFile(path.resolve("src/web/assets/app.js"), "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("async function createProfile()");
  const end = source.indexOf("\n\nwindow.openCollabMesh", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const functionSource = source.slice(start, end);
  return new Function(
    "$",
    "validateNewProfileName",
    "toast",
    "selectedPreset",
    "FormData",
    "api",
    "closePrimaryModal",
    "resetNewProfileForm",
    "load",
    "selectProfile",
    `${functionSource}; return createProfile;`
  ) as (...args: unknown[]) => () => Promise<void>;
}

async function submitProfile(values: FormValues, preset: { type: string }) {
  const form: FakeForm = {
    values,
    reportValidity: () => true,
    querySelector: () => null
  };
  const calls: CreateCall[] = [];
  const formData = class {
    constructor(private readonly target: FakeForm) {}

    get(name: string) {
      return this.target.values[name] ?? null;
    }

    entries() {
      return Object.entries(this.target.values);
    }
  };
  const createProfileFactory = await loadCreateProfileFactory();
  const createProfile = createProfileFactory(
    (id: string) => id === "newProfileForm" ? form : { value: "", setCustomValidity: () => {} },
    () => {},
    () => {},
    () => preset,
    formData,
    async (requestPath: string, options: CreateCall["options"]) => {
      calls.push({ path: requestPath, options });
      return {};
    },
    () => {},
    () => {},
    async () => {},
    async () => {}
  );
  await createProfile();
  expect(calls).toHaveLength(1);
  return { path: calls[0].path, payload: JSON.parse(calls[0].options.body || "{}") as Record<string, string> };
}

describe("Profile creation UI request contract", () => {
  it("routes API presets to the preset endpoint", async () => {
    await expect(submitProfile(
      { name: "deepseek", kind: "api", presetId: "deepseek", token: "secret" },
      { type: "api" }
    )).resolves.toEqual({
      path: "/api/profiles/preset",
      payload: { presetId: "deepseek", name: "deepseek", kind: "api", token: "secret" }
    });
  });

  it("routes Custom API profiles to the custom API endpoint", async () => {
    await expect(submitProfile(
      { name: "custom", kind: "custom-api", presetId: "custom-api", baseUrl: "https://provider.test/anthropic", customToken: "secret", model: "model-x" },
      { type: "custom-api" }
    )).resolves.toEqual({
      path: "/api/profiles/api",
      payload: { name: "custom", baseUrl: "https://provider.test/anthropic", token: "secret", model: "model-x" }
    });
  });

  it("routes Login profiles to the login endpoint", async () => {
    await expect(submitProfile(
      { name: "claude-login", kind: "login", presetId: "login" },
      { type: "login" }
    )).resolves.toEqual({
      path: "/api/profiles/login",
      payload: { name: "claude-login" }
    });
  });

  it("keeps Gateway profiles on the preset endpoint with their binding", async () => {
    await expect(submitProfile(
      { name: "gateway", kind: "gateway", presetId: "gateway", gatewayUpstream: "openai", gatewayModel: "gpt-5.6" },
      { type: "gateway" }
    )).resolves.toEqual({
      path: "/api/profiles/preset",
      payload: { presetId: "gateway", name: "gateway", kind: "gateway", upstreamId: "openai", model: "gpt-5.6" }
    });
  });
});
