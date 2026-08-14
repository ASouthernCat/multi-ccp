import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ClaudeSettings, ProfileSummary } from "../../src/core/types.js";
import { getGatewayLogPath, getProfilesRoot } from "../../src/core/paths.js";
import { createGatewayUpstream } from "../../src/core/gateway-upstreams.js";
import { readSettings, writeMeta, writeSettings } from "../../src/core/settings.js";
import {
  assertWebProfileWritable,
  listWebProfilePresets,
  publicProfileSettings,
  readGatewayLogTail,
  readWebGatewayUpstreamApiKey,
  readWebProfileApiKey,
  resolveWebGatewayCompatibility
} from "../../src/web/server.js";

const homes: string[] = [];

afterEach(async () => {
  await Promise.allSettled(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

function gatewayProfile(): ProfileSummary {
  return {
    name: "gateway",
    dir: "C:\\profiles\\gateway",
    type: "gateway",
    baseUrl: "http://127.0.0.1:3921/p/gateway",
    model: "model",
    tokenStatus: "set",
    settingsPath: "C:\\profiles\\gateway\\settings.json",
    meta: {
      version: 1,
      type: "gateway",
      gateway: {
        upstreamId: "example",
        model: "model"
      }
    }
  };
}

describe("gateway Web UI policy", () => {
  it("never exposes the local gateway token in public settings", () => {
    const settings: ClaudeSettings = {
      theme: "dark",
      env: {
        ANTHROPIC_AUTH_TOKEN: "local-token-that-must-not-leak",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:3921/p/gateway"
      }
    };

    const publicValue = publicProfileSettings(gatewayProfile(), settings);
    expect(JSON.stringify(publicValue)).not.toContain("local-token-that-must-not-leak");
    expect((publicValue?.env as Record<string, string>).ANTHROPIC_AUTH_TOKEN).toBe("[managed by built-in gateway]");
  });

  it("reveals API Keys only through explicit secret readers", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-web-api-keys-"));
    homes.push(homeDir);
    const context = { homeDir };
    const profileDir = path.join(getProfilesRoot(context), "private-api");
    await mkdir(profileDir, { recursive: true });
    await writeSettings(profileDir, {
      theme: "dark",
      env: {
        ANTHROPIC_BASE_URL: "https://example.com/anthropic",
        ANTHROPIC_AUTH_TOKEN: "profile-secret-key"
      }
    });
    await writeMeta(profileDir, { version: 1, type: "api" });
    await createGatewayUpstream({
      id: "private-upstream",
      provider: "openai-compatible",
      chatCompletionsUrl: "https://example.com/v1/chat/completions",
      apiKey: "upstream-secret-key",
      models: ["model-a"],
      compatibility: resolveWebGatewayCompatibility("openai_chat_completions", "openai-compatible", "modern")
    }, context);

    expect(await readWebProfileApiKey("private-api", context)).toBe("profile-secret-key");
    expect(await readWebGatewayUpstreamApiKey("private-upstream", context)).toBe("upstream-secret-key");

    const publicValue = publicProfileSettings(
      { ...gatewayProfile(), name: "private-api", type: "api" },
      await readSettings(profileDir)
    );
    expect(JSON.stringify(publicValue)).not.toContain("profile-secret-key");
  });

  it("exposes one provider-neutral gateway profile preset", () => {
    const gatewayPresets = listWebProfilePresets().filter((preset) => preset.category === "gateway");
    expect(gatewayPresets).toHaveLength(1);
    expect(gatewayPresets[0]).toMatchObject({ id: "gateway", type: "gateway" });
  });

  it("allows gateway updates but rejects non-editable profile types", () => {
    expect(() => assertWebProfileWritable(gatewayProfile())).not.toThrow();
    expect(() => assertWebProfileWritable({ ...gatewayProfile(), type: "login" })).toThrow("cannot be edited");
  });

  it("keeps protected upstream deletion clickable and reserves wait cursors for busy actions", async () => {
    const [app, css, html, server] = await Promise.all([
      readFile(path.resolve("src/web/assets/app.js"), "utf8"),
      readFile(path.resolve("src/web/assets/gateway.css"), "utf8"),
      readFile(path.resolve("src/web/assets/index.html"), "utf8"),
      readFile(path.resolve("src/web/server.ts"), "utf8")
    ]);

    expect(app).toContain("aria-disabled=\"${references.length ? 'true' : 'false'}\"");
    expect(app).not.toContain("profileNames?.length ? 'disabled' : ''");
    expect(app).toContain('Separate multiple model IDs with ,');
    expect(app).toContain('Common models are suggestions only; availability depends on the provider.');
    expect(app).toContain("const openDialogs = Array.from(document.querySelectorAll('dialog[open]'))");
    expect(app).toContain("openDialogs[openDialogs.length - 1]");
    expect(app).toContain('<span>CCR</span>');
    expect(app).not.toContain('<span>Router</span>');
    expect(css).toContain('button[data-busy="1"]:disabled');
    expect(css).toContain('#gatewayMetric b');
    expect(css).toContain('grid-template-rows: auto auto auto minmax(220px, 1fr)');
    expect(app).toContain("models.slice(0, 5)");
    expect(app).toContain('class="gateway-model-more"');
    expect(app).toContain("gatewayTabButton('upstreams', 'Upstreams'");
    expect(app).toContain("gatewayTabButton('logs', 'Request Logs'");
    expect(app).toContain('id="gatewayCreateProfile"');
    expect(app).toContain('openNewGatewayProfileFromManager');
    expect(app).toContain("openNewProfileDialog({ presetId: 'gateway', presetFilter: 'gateway' })");
    expect(app).not.toContain("$('gatewayDialog').close();\n    await openNewProfileDialog({ presetId: 'gateway'");
    expect(app).not.toContain("document.body.append(dialog)");
    expect(app).toContain("primaryModalHistory.push(current.id)");
    expect(app).toContain("primaryModalSuppressedCloseCounts.set(dialog.id, suppressedCount + 1)");
    expect(app).toContain("primaryModalSuppressedCloseCounts.set(dialogId, suppressedCount - 1)");
    expect(app).toContain("previous.showModal()");
    expect(app).toContain("primaryModalCanReturnTo('newProfileDialog')");
    expect(app).toContain("const canReturnToGateway = primaryModalCanReturnTo('gatewayDialog')");
    expect(app).toContain('button.hidden = canReturnToGateway');
    expect(app).toContain("closePrimaryModal('gatewayDialog')");
    expect(app).toContain("restorePreviousPrimaryModal()");
    expect(app).toContain('placeholder="my-provider"');
    expect(app).not.toContain('name.value = preset.defaultProfileName');
    expect(app).toContain('Renaming also updates bound Profiles.');
    expect(app).toContain('Full Endpoint URL');
    expect(app).toContain('id="upstreamCommonModel"');
    expect(app).toContain('class="gateway-log-endpoint" title=');
    expect(app).toContain('function gatewayLogDetailHasValue');
    expect(app).toContain('function gatewayLogDetailSection');
    expect(app).toContain('values.slice(0, limit)');
    expect(app).toContain('class="gateway-log-diagnostics"');
    expect(app).not.toContain("gatewayLogDetailValue(value)");
    expect(css).toContain('width: min(820px, calc(100vw - 32px))');
    expect(css).toContain('.gateway-log-detail-facts');
    expect(css).toContain('.gateway-log-detail-list-more');
    expect(css).toContain('.gateway-log-diagnostics-body');
    expect(app).toContain('Responses (recommended)');
    expect(app).toContain('Chat Completions (legacy)');
    expect(app).toContain("protocol,");
    expect(app).toContain("? { endpointUrl: $('upstreamEndpointUrl').value }");
    expect(app).toContain(": { baseUrl: $('upstreamBaseUrl').value }");
    expect(app).toContain("gatewayProtocolLabel(upstream.protocol)");
    expect(app).toContain("<label>Default model<select id=\"editGatewayModel\"");
    expect(app).toContain("Running sessions using Default switch on their next request.");
    expect(app).toContain("Explicit /model selections remain selected while available on the chosen Upstream.");
    expect(app).toContain(">Save Default</button>");
    expect(app).toContain("template.protocol === upstream.protocol && template.endpointUrl === upstream.endpointUrl");
    expect(app).toContain("Change protocol from ${gatewayProtocolLabel(form.dataset.originalProtocol)}");
    expect(app).toContain("baseUrl.value = gatewayBaseUrlFromEndpointLikeValue(baseUrl.value)");
    expect(app).toContain("endpointUrl.value = gatewayEndpointForProtocolSwitch(endpointUrl.value, baseUrl.value, protocol)");
    expect(app).not.toContain("baseUrl.value = ''");
    expect(app).not.toContain("endpointUrl.value = ''");
    expect(app).toContain('https://api.example.com/v1/responses');
    expect(app).toContain('https://api.example.com/v1/chat/completions');
    expect(app).toContain("await selectProfile(createdName)");
    expect(app).toContain('placeholder="claude-opus-4-8"');
    expect(app).toContain('placeholder="claude-sonnet-5"');
    expect(app).toContain('placeholder="claude-haiku-4-5"');
    expect(app).not.toContain('placeholder="可选，例如 claude-opus-4"');
    expect(app).toContain('title="打开 Gateway 管理"');
    expect(app).toContain('title="打开 CCR 管理"');
    expect(app).toContain('aria-label="打开 Gateway 管理，当前状态 ${escapeHtml(gatewayStatus)}"');
    expect(app).toContain('aria-label="打开 CCR 管理，当前状态 ${escapeHtml(ccrStatus)}"');
    expect(css).toContain('.gateway-view-actions');
    expect(html).toContain('placeholder="例如 openai-gpt 或 my-gateway"');
    expect(app).toContain("api('/api/gateway/upstream-templates')");
    expect(app).toContain('Preset Template<select id="upstreamTemplate"');
    expect(app).toContain('applyGatewayUpstreamTemplate');
    expect(app).toContain("deepseek: '/icons/deepseek.svg'");
    expect(app).not.toContain("'/assets/icons/");
    expect(server).toContain('if (filePath.endsWith(".ico")) return "image/x-icon"');
    expect(server).toContain('let data: string | Buffer = await readFile(resolved)');
    expect(app).toContain('empty.hidden = available');
    expect(app).toContain('setCreateProfileAvailability(canCreate, unavailableMessage)');
    expect(html).toContain('id="newGatewayEmpty"');
    expect(html).toContain('<label>Default model <select name="gatewayModel"');
    expect(html).toContain('Every Upstream model remains available through /model.');
    expect(html).toContain('请点击下方 Manage Upstreams');
    expect(html).not.toContain('data-kind-fields="custom-gateway"');
    expect(app).toContain("bindGatewayBinding('newGateway')");
    expect(css).toContain('.gateway-profile-upstream-empty');
    expect(css).toContain('.gateway-manage-upstreams[hidden]');
    expect(css).toContain('#createProfileSubmit[data-unavailable="1"]:disabled');
    expect(css).toContain('flex-wrap: wrap');
    expect(css).toContain('flex-basis: 100%');
    expect(css).toContain('width: min(250px, 100%)');
    expect(app).toContain("function secretInput(");
    expect(app).toContain("data-secret-toggle");
    expect(app).toContain("/api/profiles/${encodeURIComponent(name)}/api-key");
    expect(app).toContain("/api/gateway/upstreams/${encodeURIComponent(id)}/api-key");
    expect(app).toContain("<label>API Key${secretInput('apiKey'");
    expect(app).toContain("<label class=\"gateway-wide\">API Key${secretInput('upstreamApiKey'");
    expect(app).not.toContain("New Token");
    expect(app).not.toContain("Replacement API Key");
    expect(css).toContain('.secret-toggle');
    expect(server).toContain('"cache-control": "no-store"');
    expect(server).toContain('protocol = gatewayRequestProtocol(body)');
    expect(server).toContain('endpointUrl: gatewayRequestUrl(body, protocol, provider)');
    expect(server).toContain('Send either baseUrl or endpointUrl, not both.');
    expect(server).toContain('chatCompletionsUrl cannot be used with the Responses protocol');
    expect(html).toContain('href="https://github.com/ASouthernCat/multi-ccp"');
    expect(html).toContain('v__CCP_VERSION__');
    expect(server).toContain('.replace("__CCP_VERSION__", getPackageVersion())');
    expect(app).toContain('class="ccr-version-notice"');
    expect(app).toContain('CCR 3.x is a major rewrite and is not compatible');
    expect(app).toContain('data.pinnedVersion');
    expect(app).toContain('Connecting an OpenAI-format provider?');
    expect(app).toContain('id="ccrOpenGateway"');
    expect(app).toContain("$('ccrDialog').close(); void openGatewayPanel()");
    expect(css).toContain('.app-version');
    expect(css).toContain('.ccr-version-notice');
    expect(css).toContain('.ccr-gateway-guide');
    expect(css).toContain('max-height: min(82dvh, 690px)');
    expect(css).toContain('.ccr-card .modal-actions');
    expect(css).toContain('padding: 14px 0 2px');
    expect(app).toContain("state.gatewayLogFilter === 'errors'");
    expect(app).toContain("state.gatewayLogFilter === 'success'");
    expect(app).toContain("<span class=\"gateway-error-count success\">");
    expect(css).toContain('.gateway-upstream-drawer');
    expect(css).toContain('@keyframes gateway-drawer-in');
    expect(css).toContain('@keyframes gateway-drawer-out');
    expect(css).toContain('animation: gateway-drawer-in 220ms');
    expect(css).toContain('animation: gateway-drawer-out 120ms');
    expect(app).toContain("button.dataset.pending = '1'");
    expect(app).toContain('}, 140)');
    expect(html).not.toContain('id="upstreamDialog"');
  });

  it("maps protocol-specific Web compatibility modes to validated gateway settings", () => {
    expect(resolveWebGatewayCompatibility("openai_chat_completions", "openai-compatible", "modern")).toMatchObject({
      protocol: "openai_chat_completions",
      instructionRole: "developer",
      maxTokensField: "max_completion_tokens",
      reasoningEffort: "reasoning_effort",
      structuredOutput: "response_format"
    });
    expect(resolveWebGatewayCompatibility("openai_chat_completions", "openai-compatible", "legacy")).toMatchObject({
      protocol: "openai_chat_completions",
      instructionRole: "system",
      maxTokensField: "max_tokens",
      reasoningEffort: "omit",
      structuredOutput: "unsupported"
    });
    expect(resolveWebGatewayCompatibility("openai_responses", "openai-compatible", "responses")).toMatchObject({
      protocol: "openai_responses",
      instructions: "instructions",
      maxOutputTokens: "max_output_tokens",
      reasoningEffort: "reasoning.effort",
      structuredOutput: "text.format",
      store: false
    });
    expect(() => resolveWebGatewayCompatibility("openai_responses", "openai-compatible", "modern"))
      .toThrow("cannot be used with the Responses protocol");
    expect(() => resolveWebGatewayCompatibility("openai_responses", "openai-compatible", "openai"))
      .toThrow("requires the OpenAI provider");
  });

  it("returns a bounded, redacted gateway log view", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "ccp-web-gateway-log-"));
    homes.push(homeDir);
    const context = { homeDir };
    const logPath = getGatewayLogPath(context);
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, [
      "startup apiKey=top-secret-provider-key",
      JSON.stringify({
        event: "gateway_request",
        requestId: "request-safe-1",
        completedAt: "2026-07-11T00:00:00.000Z",
        method: "POST",
        pathname: "/p/gpt-5.6/v1/messages",
        profileName: "gpt-5.6",
        clientModel: "claude-opus-4-8",
        model: "gpt-5.6-sol",
        protocol: "openai_responses",
        endpointUrl: "https://user:pass@provider.test/v1/responses?credential=must-not-leak#fragment",
        stream: true,
        effort: "high",
        requestKind: "messages",
        outcome: "failure",
        errorSummary: "The selected upstream rejected the converted request with HTTP 400.",
        failureStage: "upstream_http",
        failureCode: "upstream_http_error",
        errorType: "invalid_request_error",
        upstreamStatus: 400,
        upstreamRequestId: "upstream-safe-1",
        upstreamErrorCode: "unsupported_value",
        upstreamErrorParam: "input[0].content[1].image_url",
        upstreamFields: ["input", "model"],
        sessionId: "fixture-session",
        agentId: "fixture-agent",
        parentAgentId: "bad id with spaces",
        rawProviderBody: "prompt sentinel must-not-leak",
        status: 400,
        durationMs: 321,
        authorization: "Bearer must-not-leak"
      })
    ].join("\n"), "utf8");

    const result = await readGatewayLogTail(context, 10);
    expect(result.path).toBe(logPath);
    expect(result.entries[0]).toMatchObject({
      kind: "request",
      requestId: "request-safe-1",
      method: "POST",
      pathname: "/p/gpt-5.6/v1/messages",
      profileName: "gpt-5.6",
      clientModel: "claude-opus-4-8",
      model: "gpt-5.6-sol",
      protocol: "openai_responses",
      endpointUrl: "https://provider.test/v1/responses",
      stream: true,
      effort: "high",
      requestKind: "messages",
      outcome: "failure",
      failureStage: "upstream_http",
      failureCode: "upstream_http_error",
      errorType: "invalid_request_error",
      upstreamStatus: 400,
      upstreamRequestId: "upstream-safe-1",
      upstreamErrorCode: "unsupported_value",
      upstreamErrorParam: "input[0].content[1].image_url",
      upstreamFields: ["input", "model"],
      sessionId: "fixture-session",
      agentId: "fixture-agent",
      status: 400,
      durationMs: 321
    });
    expect(result.entries[0]?.parentAgentId).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("must-not-leak");
    expect(JSON.stringify(result)).not.toContain("credential=must-not-leak");
    expect(JSON.stringify(result)).not.toContain("user:pass");
    expect(JSON.stringify(result)).not.toContain("#fragment");
    expect(JSON.stringify(result)).not.toContain("top-secret-provider-key");
    expect(result.entries[1]?.message).toContain("[redacted]");
  });
});
