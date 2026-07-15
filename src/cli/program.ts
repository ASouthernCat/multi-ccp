import { confirm, input, password, select } from "@inquirer/prompts";
import { Command } from "commander";
import { CcpError } from "../core/errors.js";
import { launchClaude } from "../core/launcher.js";
import { resolveConfigDir } from "../core/profiles.js";
import {
  createApiProfile,
  createCcrProfile,
  createGatewayProfile,
  createLoginProfile,
  listProfiles,
  profileExists,
  removeProfile,
  resolveProfileDirForRemoval,
  summarizeProfile
} from "../core/profiles.js";
import { getMetaPath, getSettingsPath, readMeta } from "../core/settings.js";
import {
  CCR_INSTALL_COMMAND,
  getCcrRouteChoices,
  getCcrStatus,
  installCcr,
  readCcrConfig,
  invokeCcrCli,
  printCcrStatus,
  restartCcrService,
  startCcrService,
  stopCcrService
} from "../core/ccr.js";
import {
  createApiProfileFromPreset,
  createCcrProfileFromPreset,
  createGatewayProfileFromPreset,
  getProfilePreset,
  listProfilePresets,
  type BuiltinProfilePreset
} from "../core/presets.js";
import {
  createGatewayUpstream,
  listGatewayUpstreams,
  readGatewayUpstreamConfig,
  removeGatewayUpstream,
  updateGatewayUpstream
} from "../core/gateway-upstreams.js";
import {
  getGatewayUpstreamTemplate,
  listGatewayUpstreamTemplates
} from "../core/gateway-upstream-templates.js";
import { updateGatewayProfile } from "../core/gateway-profile.js";
import {
  getGatewayStatus,
  printGatewayStatus,
  restartGateway,
  startGateway,
  stopGateway
} from "../core/gateway-lifecycle.js";
import { startUiServer } from "../web/server.js";
import { openEditor } from "../platform/editor.js";
import { parseSelectionText, syncSessions, type SessionDisplayInfo } from "../core/sessions.js";
import { getPackageVersion } from "../core/version.js";
import type {
  GatewayCompatibility,
  GatewayProtocolCompatibility,
  GatewayProvider,
  GatewayResponsesCompatibility,
  GatewayUpstreamProtocol,
  GatewayUpstreamSummary
} from "../core/types.js";
import {
  CUSTOM_GATEWAY_COMPATIBILITY,
  CUSTOM_RESPONSES_COMPATIBILITY,
  MODERN_OPENAI_COMPATIBILITY,
  OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_GATEWAY_COMPATIBILITY,
  OPENAI_RESPONSES_COMPATIBILITY,
  OPENAI_RESPONSES_URL
} from "../gateway/config.js";

async function ensureProfileCanBeCreated(name: string): Promise<boolean> {
  if (!(await profileExists(name))) {
    return true;
  }

  const config = await resolveConfigDir(name, { allowMain: false });
  console.log(`Profile '${name}' already exists:`);
  console.log(config.dir);
  console.log("Use a different profile name, or remove the existing profile first with:");
  console.log(`  ccp remove ${name}`);
  return false;
}

function printProfile(profile: Awaited<ReturnType<typeof summarizeProfile>>): void {
  if (profile.model) {
    console.log(`${profile.name}\t${profile.model}\t${profile.baseUrl}`);
  } else {
    console.log(`${profile.name}\t${profile.baseUrl}`);
  }
}

function presetChoiceName(preset: BuiltinProfilePreset): string {
  const tags = preset.tags?.length ? ` [${preset.tags.join(", ")}]` : "";
  return `${preset.label}${tags}`;
}

async function promptProfileName(profile: string | undefined, defaultName: string, options: { promptWhenMissing: boolean }): Promise<string> {
  if (profile?.trim()) {
    return profile.trim();
  }
  if (!options.promptWhenMissing) {
    return defaultName;
  }
  return (await input({ message: "Profile name", default: defaultName, required: true })).trim();
}

async function selectProfilePreset(): Promise<BuiltinProfilePreset> {
  const presets = listProfilePresets().sort((a, b) => {
    if (a.id === "custom-api") return -1;
    if (b.id === "custom-api") return 1;
    return (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.label.localeCompare(b.label);
  });
  return select({
    message: "Choose a profile template",
    choices: presets.map((preset) => ({ name: presetChoiceName(preset), value: preset }))
  });
}

async function ensureCcrSetupForProfileCreation(options: { requireRoutes: boolean }): Promise<void> {
  let status = await getCcrStatus();
  if (!status.installed) {
    console.log("CCR is required for this profile, but it is not installed.");
    const ok = await confirm({ message: `Install CCR now? This runs: ${CCR_INSTALL_COMMAND}`, default: true });
    if (!ok) {
      throw new CcpError("CCR is not installed. Run 'ccp ccr install' first.");
    }
    const code = await installCcr();
    if (code !== 0) {
      throw new CcpError(`CCR install failed with exit code ${code}.`);
    }
    status = await getCcrStatus();
  }

  if (!options.requireRoutes) {
    return;
  }

  if (!status.configExists || !status.hasProviders || status.routeCount === 0) {
    printCcrStatus(status);
    throw new CcpError("CCR has no usable routes. Run 'ccp ccr model' first, then create this profile again.");
  }
}

function printCreatedProfile(created: Awaited<ReturnType<typeof summarizeProfile>>): void {
  console.log(`Created profile '${created.name}'.`);
  console.log(`Run: ccp start ${created.name}`);
}

async function createApiPresetProfile(profile: string | undefined, preset: BuiltinProfilePreset, options: { promptName: boolean }): Promise<void> {
  if (preset.type !== "api") {
    throw new CcpError(`Preset '${preset.id}' is not an API preset.`);
  }

  const profileName = await promptProfileName(profile, preset.defaultProfileName, { promptWhenMissing: options.promptName });
  if (!(await ensureProfileCanBeCreated(profileName))) return;
  console.log(`Create Claude API profile: ${profileName}`);
  console.log(`Preset: ${preset.label}`);
  console.log(`Base:   ${preset.env.ANTHROPIC_BASE_URL}`);
  if (preset.modelSummary) console.log(`Model:  ${preset.modelSummary}`);
  const token = await password({ message: "ANTHROPIC_AUTH_TOKEN (hidden, Enter to leave placeholder)", mask: "*" });
  const ok = await confirm({ message: "Create this profile?", default: true });
  if (!ok) {
    console.log("Cancelled.");
    return;
  }
  printCreatedProfile(await createApiProfileFromPreset({ presetId: preset.id, name: profileName, token }));
}

async function createCcrPresetProfile(profile: string | undefined, preset: BuiltinProfilePreset, options: { promptName: boolean }): Promise<void> {
  if (preset.type !== "ccr") {
    throw new CcpError(`Preset '${preset.id}' is not a CCR preset.`);
  }

  const profileName = await promptProfileName(profile, preset.defaultProfileName, { promptWhenMissing: options.promptName });
  if (!(await ensureProfileCanBeCreated(profileName))) return;
  await ensureCcrSetupForProfileCreation({ requireRoutes: !preset.providerTemplate });
  console.log(`Create CCR profile: ${profileName}`);
  console.log(`Preset: ${preset.label}`);
  console.log(`CCR Preset: ${preset.ccrPreset}`);
  console.log(`Route:      ${preset.ccrRoute}`);
  if (preset.providerTemplate) {
    console.log(`Provider:   ${preset.providerTemplate.name}`);
    console.log(`Endpoint:   ${preset.providerTemplate.api_base_url}`);
  }
  const providerApiKey = preset.providerTemplate ? await password({ message: `${preset.providerTemplate.name} API key for CCR provider (hidden)`, mask: "*" }) : "";
  const token = await password({ message: "ANTHROPIC_AUTH_TOKEN for CCR (hidden, Enter to use preset default)", mask: "*" });
  const ok = await confirm({ message: "Create this CCR profile?", default: true });
  if (!ok) {
    console.log("Cancelled.");
    return;
  }
  printCreatedProfile(await createCcrProfileFromPreset({ presetId: preset.id, name: profileName, token, providerApiKey }));
}

async function createGatewayPresetProfile(
  profile: string | undefined,
  preset: BuiltinProfilePreset,
  options: { promptName: boolean }
): Promise<void> {
  if (preset.type !== "gateway") {
    throw new CcpError(`Preset '${preset.id}' is not a gateway preset.`);
  }
  const profileName = await promptProfileName(profile, preset.defaultProfileName, { promptWhenMissing: options.promptName });
  if (!(await ensureProfileCanBeCreated(profileName))) return;
  const upstream = await chooseGatewayUpstream();
  const model = await chooseGatewayModel(upstream);
  console.log(`Create gateway profile: ${profileName}`);
  console.log(`Upstream: ${upstream.id}`);
  console.log(`Provider: ${upstream.provider}`);
  console.log(`Model:    ${model}`);
  const ok = await confirm({ message: "Create this gateway profile?", default: true });
  if (!ok) {
    console.log("Cancelled.");
    return;
  }
  printCreatedProfile(await createGatewayProfileFromPreset({
    presetId: preset.id,
    name: profileName,
    upstreamId: upstream.id,
    model
  }));
}

async function chooseGatewayUpstream(
  provider?: GatewayProvider,
  defaultId?: string
): Promise<GatewayUpstreamSummary> {
  const upstreams = (await listGatewayUpstreams()).filter((item) => !provider || item.provider === provider);
  if (!upstreams.length) {
    const kind = provider === "openai" ? "OpenAI" : provider === "openai-compatible" ? "OpenAI-compatible" : "gateway";
    throw new CcpError(`No ${kind} upstream exists. Run 'ccp gateway add' first.`);
  }
  if (defaultId) {
    const existing = upstreams.find((item) => item.id === defaultId);
    if (existing && upstreams.length === 1) return existing;
  }
  const id = await select({
    message: "Choose gateway upstream",
    default: defaultId,
    choices: upstreams.map((item) => ({
      name: `${item.id} [${item.provider}] ${item.models.join(", ")}`,
      value: item.id
    }))
  });
  return upstreams.find((item) => item.id === id) as GatewayUpstreamSummary;
}

async function chooseGatewayModel(upstream: GatewayUpstreamSummary, defaultModel?: string): Promise<string> {
  if (upstream.models.length === 1) return upstream.models[0];
  return select({
    message: `Choose model from '${upstream.id}'`,
    default: defaultModel,
    choices: upstream.models.map((model) => ({ name: model, value: model }))
  });
}

function parseGatewayModels(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((model) => model.trim()).filter(Boolean))];
}

async function promptGatewayProvider(defaultValue: GatewayProvider = "openai-compatible"): Promise<GatewayProvider> {
  return select({
    message: "Upstream provider template",
    default: defaultValue,
    choices: [
      {
        name: "OpenAI official (fixed api.openai.com endpoint)",
        value: "openai" as const
      },
      {
        name: "OpenAI-compatible provider (custom endpoint)",
        value: "openai-compatible" as const
      }
    ]
  });
}

async function promptGatewayProtocol(
  defaultValue: GatewayUpstreamProtocol = "openai_responses"
): Promise<GatewayUpstreamProtocol> {
  return select({
    message: "Upstream protocol",
    default: defaultValue,
    choices: [
      { name: "OpenAI Responses (recommended)", value: "openai_responses" as const },
      { name: "OpenAI Chat Completions (legacy compatibility)", value: "openai_chat_completions" as const }
    ]
  });
}

function gatewayProtocolLabel(protocol: GatewayUpstreamProtocol): string {
  return protocol === "openai_responses" ? "OpenAI Responses" : "OpenAI Chat Completions";
}

function officialGatewayEndpoint(protocol: GatewayUpstreamProtocol): string {
  return protocol === "openai_responses" ? OPENAI_RESPONSES_URL : OPENAI_CHAT_COMPLETIONS_URL;
}

async function promptGatewayEndpoint(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider,
  current = ""
): Promise<string> {
  if (provider === "openai") return officialGatewayEndpoint(protocol);
  const responses = protocol === "openai_responses";
  return input({
    message: responses ? "Responses endpoint URL" : "Chat Completions endpoint URL",
    default: current || undefined,
    required: true
  });
}

async function promptGatewayCompatibility(
  protocol: "openai_chat_completions",
  provider: GatewayProvider,
  current?: GatewayProtocolCompatibility
): Promise<GatewayProtocolCompatibility>;
async function promptGatewayCompatibility(
  protocol: "openai_responses",
  provider: GatewayProvider,
  current?: GatewayProtocolCompatibility
): Promise<GatewayProtocolCompatibility>;
async function promptGatewayCompatibility(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider,
  current?: GatewayProtocolCompatibility
): Promise<GatewayProtocolCompatibility>;
async function promptGatewayCompatibility(
  protocol: GatewayUpstreamProtocol,
  provider: GatewayProvider,
  current?: GatewayProtocolCompatibility
): Promise<GatewayProtocolCompatibility> {
  if (protocol === "openai_responses") {
    if (provider === "openai") return { ...OPENAI_RESPONSES_COMPATIBILITY };
    const mode = await select({
      message: "Responses compatibility profile",
      default: current?.protocol === "openai_responses" ? "advanced" : "responses",
      choices: [
        { name: "OpenAI Responses compatible (recommended)", value: "responses" as const },
        { name: "Advanced Responses mapping", value: "advanced" as const }
      ]
    });
    if (mode === "responses") return { ...CUSTOM_RESPONSES_COMPATIBILITY };
    const responsesCurrent = current?.protocol === "openai_responses" ? current : undefined;
    return {
      protocol: "openai_responses",
      instructions: await select({
        message: "Instructions mapping",
        default: responsesCurrent?.instructions ?? "instructions",
        choices: [
          { name: "instructions field", value: "instructions" as const },
          { name: "system input item", value: "system_input" as const }
        ]
      }),
      maxOutputTokens: "max_output_tokens",
      supportsStop: false,
      supportsSampling: await confirm({
        message: "Forward temperature and top_p to the provider?",
        default: responsesCurrent?.supportsSampling ?? true
      }),
      parallelToolCalls: await select({
        message: "parallel_tool_calls parameter",
        default: responsesCurrent?.parallelToolCalls ?? "supported",
        choices: [
          { name: "Forward", value: "supported" as const },
          { name: "Omit", value: "unsupported" as const }
        ]
      }),
      reasoningEffort: await select({
        message: "Claude effort mapping",
        default: responsesCurrent?.reasoningEffort ?? "reasoning.effort",
        choices: [
          { name: "reasoning.effort", value: "reasoning.effort" as const },
          { name: "Unsupported / omit", value: "omit" as const }
        ]
      }),
      structuredOutput: await select({
        message: "Structured output mapping",
        default: responsesCurrent?.structuredOutput ?? "text.format",
        choices: [
          { name: "text.format", value: "text.format" as const },
          { name: "Unsupported / reject", value: "unsupported" as const }
        ]
      }),
      toolStrict: await select({
        message: "Function tool strict mode",
        default: responsesCurrent?.toolStrict ?? "non_strict",
        choices: [
          {
            name: "Non-strict (recommended for Claude Code tools)",
            value: "non_strict" as const
          },
          {
            name: "Strict (requires all properties required + additionalProperties:false)",
            value: "strict" as const
          }
        ]
      }),
      store: false
    };
  }

  const chatCurrent = current?.protocol === "openai_chat_completions" ? current : undefined;
  if (provider === "openai") {
    return { protocol: "openai_chat_completions", ...OPENAI_GATEWAY_COMPATIBILITY };
  }
  const compatibilityMode = await select({
    message: "Chat Completions compatibility profile",
    default: chatCurrent ? "advanced" : "modern",
    choices: [
      { name: "Modern OpenAI Chat Completions", value: "modern" as const },
      { name: "Legacy OpenAI-compatible", value: "legacy" as const },
      { name: "Advanced custom mapping", value: "advanced" as const }
    ]
  });
  if (compatibilityMode === "modern") {
    return { protocol: "openai_chat_completions", ...MODERN_OPENAI_COMPATIBILITY };
  } else if (compatibilityMode === "legacy") {
    return { protocol: "openai_chat_completions", ...CUSTOM_GATEWAY_COMPATIBILITY };
  } else {
    const instructionRole = await select({
      message: "Instruction message role",
      default: chatCurrent?.instructionRole ?? "developer",
      choices: [
        { name: "developer (GPT-5 and reasoning models)", value: "developer" as const },
        { name: "system (legacy providers)", value: "system" as const }
      ]
    });
    const maxTokensField = await select({
      message: "Output token field",
      default: chatCurrent?.maxTokensField ?? "max_completion_tokens",
      choices: [
        { name: "max_completion_tokens (modern OpenAI)", value: "max_completion_tokens" as const },
        { name: "max_tokens (legacy providers)", value: "max_tokens" as const }
      ]
    });
    const supportsStop = await confirm({ message: "Forward stop sequences to the provider?", default: chatCurrent?.supportsStop ?? true });
    const supportsSampling = await confirm({ message: "Forward temperature and top_p to the provider?", default: chatCurrent?.supportsSampling ?? true });
    const parallelToolCalls = await select({
      message: "parallel_tool_calls parameter",
      default: chatCurrent?.parallelToolCalls ?? "supported",
      choices: [
        { name: "Forward", value: "supported" as const },
        { name: "Omit", value: "unsupported" as const }
      ]
    });
    const streamUsage = await select({
      message: "Streaming usage option",
      default: chatCurrent?.streamUsage ?? "include",
      choices: [
        { name: "Include stream_options.include_usage", value: "include" as const },
        { name: "Omit stream_options", value: "omit" as const }
      ]
    });
    const reasoningEffort = await select({
      message: "Claude effort mapping",
      default: chatCurrent?.reasoningEffort ?? "reasoning_effort",
      choices: [
        { name: "reasoning_effort (OpenAI reasoning models)", value: "reasoning_effort" as const },
        { name: "output_config.effort (provider-specific)", value: "output_config" as const },
        { name: "Unsupported / omit", value: "omit" as const }
      ]
    });
    const structuredOutput = await select({
      message: "Structured output mapping",
      default: chatCurrent?.structuredOutput ?? "response_format",
      choices: [
        { name: "response_format (OpenAI JSON Schema)", value: "response_format" as const },
        { name: "output_config.format (provider-specific)", value: "output_config" as const },
        { name: "Unsupported / reject", value: "unsupported" as const }
      ]
    });
    return {
      protocol: "openai_chat_completions",
      instructionRole,
      maxTokensField,
      supportsStop,
      supportsSampling,
      parallelToolCalls,
      streamUsage,
      reasoningEffort,
      structuredOutput
    };
  }
}

async function createCustomApiProfile(profile: string | undefined, preset: BuiltinProfilePreset, options: { promptName: boolean }): Promise<void> {
  const profileName = await promptProfileName(profile, preset.defaultProfileName, { promptWhenMissing: options.promptName });
  if (!(await ensureProfileCanBeCreated(profileName))) return;
  console.log(`Create Claude API profile: ${profileName}`);
  const baseUrl = await input({ message: "ANTHROPIC_BASE_URL", required: true });
  const token = await password({ message: "ANTHROPIC_AUTH_TOKEN (hidden, Enter to leave placeholder)", mask: "*" });
  const model = await input({ message: "Model (optional, Enter for Claude Code default)" });
  const ok = await confirm({ message: "Create this profile?", default: true });
  if (!ok) {
    console.log("Cancelled.");
    return;
  }
  printCreatedProfile(await createApiProfile({ name: profileName, baseUrl, token, model }));
}

async function selectManualCcrRoute(config: Awaited<ReturnType<typeof readCcrConfig>>): Promise<string> {
  const routes = getCcrRouteChoices(config);
  if (!config) {
    throw new CcpError("CCR config not found. Run 'ccp ccr model' first.");
  }
  if (routes.length === 0) {
    console.log("No CCR routes found. Type a route as provider,model.");
    return input({ message: "CCR route", required: true });
  }

  const selected = await select({
    message: "Bind this profile to a CCR route",
    choices: [
      ...routes.map((value) => ({ name: value, value })),
      { name: "Type route manually", value: "__manual__" }
    ]
  });
  if (selected !== "__manual__") {
    return selected;
  }
  return input({ message: "CCR route", required: true });
}

async function promptManualCcrToken(config: Awaited<ReturnType<typeof readCcrConfig>>): Promise<string> {
  if (config?.APIKEY) {
    const useExisting = await confirm({ message: "Use APIKEY from CCR config as ANTHROPIC_AUTH_TOKEN?", default: true });
    if (useExisting) {
      return String(config.APIKEY);
    }
  }
  return password({ message: "ANTHROPIC_AUTH_TOKEN for CCR (hidden, Enter to use ccr-local-secret)", mask: "*" });
}

async function createManualCcrProfile(profile: string | undefined, preset: BuiltinProfilePreset, options: { promptName: boolean }): Promise<void> {
  const profileName = await promptProfileName(profile, preset.defaultProfileName, { promptWhenMissing: options.promptName });
  if (!(await ensureProfileCanBeCreated(profileName))) return;
  await ensureCcrSetupForProfileCreation({ requireRoutes: true });
  const config = await readCcrConfig();
  const route = await selectManualCcrRoute(config);
  const token = await promptManualCcrToken(config);

  console.log("");
  console.log("Profile: " + profileName);
  console.log("Type:    ccr");
  console.log("Route:   " + route);
  console.log("Token:   set");
  const ok = await confirm({ message: "Create this CCR profile?", default: true });
  if (!ok) {
    console.log("Cancelled.");
    return;
  }

  printCreatedProfile(await createCcrProfile({ name: profileName, route, token }));
}

async function createLoginPresetProfile(profile: string | undefined, preset: BuiltinProfilePreset, options: { promptName: boolean }): Promise<void> {
  const profileName = await promptProfileName(profile, preset.defaultProfileName, { promptWhenMissing: options.promptName });
  if (!(await ensureProfileCanBeCreated(profileName))) return;
  console.log(`Create Claude login profile: ${profileName}`);
  console.log("This profile will not set ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN.");
  const ok = await confirm({ message: "Create this login profile?", default: true });
  if (!ok) {
    console.log("Cancelled.");
    return;
  }
  const created = await createLoginProfile({ name: profileName });
  console.log(`Created Claude login profile '${created.name}'.`);
  console.log(`Run: ccp start ${created.name}`);
  console.log("Then complete the Claude Code login flow for this account.");
}

async function createProfileFromPreset(profile: string | undefined, preset: BuiltinProfilePreset, options: { promptName: boolean }): Promise<void> {
  switch (preset.type) {
    case "api":
      await createApiPresetProfile(profile, preset, options);
      break;
    case "ccr":
      await createCcrPresetProfile(profile, preset, options);
      break;
    case "custom-api":
      await createCustomApiProfile(profile, preset, options);
      break;
    case "manual-ccr":
      await createManualCcrProfile(profile, preset, options);
      break;
    case "login":
      await createLoginPresetProfile(profile, preset, options);
      break;
    case "gateway":
      await createGatewayPresetProfile(profile, preset, options);
      break;
  }
}


async function selectSessionFiles(sessions: SessionDisplayInfo[]): Promise<SessionDisplayInfo[]> {
  if (sessions.length === 0) return [];

  console.log("Select sessions to sync:");
  sessions.forEach((item, index) => {
    const when = item.lastWriteTime.toISOString().slice(0, 16).replace("T", " ");
    const shortId = item.sessionId.length > 8 ? item.sessionId.slice(0, 8) : item.sessionId;
    console.log("[" + (index + 1) + "] " + when + "  " + item.relativeTime + "  " + shortId + "  " + item.title + "  " + item.sizeKb + "KB");
  });

  const answer = await input({ message: "Choose numbers/ranges, 'a' for all, or 'q' to cancel" });
  if (!answer.trim() || answer.trim().toLowerCase() === "q") return [];
  if (["a", "all"].includes(answer.trim().toLowerCase())) return sessions;

  return parseSelectionText(answer, sessions.length).map((index) => sessions[index]);
}

async function confirmSessionConflict(details: { sourceFile: string; targetFile: string }): Promise<"yes" | "no" | "all" | "quit"> {
  console.log("");
  console.log("Conflict detected:");
  console.log("  " + details.sourceFile);
  console.log("Target: " + details.targetFile);

  return select({
    message: "Overwrite target with source?",
    choices: [
      { name: "No", value: "no" as const },
      { name: "Yes", value: "yes" as const },
      { name: "All", value: "all" as const },
      { name: "Quit", value: "quit" as const }
    ]
  });
}

async function showStatus(name: string): Promise<void> {
  const config = await resolveConfigDir(name, { allowMain: true });
  const profile = await summarizeProfile(config.name, config.dir);
  console.log(`Profile: ${profile.name}`);
  console.log(`Path:    ${profile.dir}`);
  console.log(`Settings: ${profile.settingsPath}`);
  if (profile.meta) {
    console.log(`Type:    ${profile.meta.type}`);
    if (profile.meta.endpoint) console.log(`Endpoint: ${profile.meta.endpoint}`);
    if (profile.meta.autoStart !== undefined) console.log(`AutoStart: ${profile.meta.autoStart}`);
    if (profile.meta.ccrPreset) console.log(`CCR Preset: ${profile.meta.ccrPreset}`);
    if (profile.meta.ccrRoute) console.log(`CCR Route: ${profile.meta.ccrRoute}`);
  } else {
    console.log(`Type:    ${profile.type}`);
  }

  if (profile.type === "login") {
    console.log("Auth:    Claude Code login");
    console.log("Env:     missing");
    return;
  }

  if (profile.type === "gateway" && profile.meta?.gateway) {
    const upstream = await readGatewayUpstreamConfig(profile.meta.gateway.upstreamId);
    console.log(`Upstream: ${upstream.id}`);
    console.log(`Provider: ${upstream.provider}`);
    console.log(`Protocol: ${gatewayProtocolLabel(upstream.protocol)}`);
    console.log(`Endpoint: ${upstream.endpointUrl}`);
  }

  if (!profile.baseUrl && !profile.model && profile.tokenStatus === "missing") {
    console.log("Env:     missing");
    return;
  }

  console.log(`Base:    ${profile.baseUrl}`);
  if (profile.type === "ccr" && !profile.model) {
    console.log("Model:   (routed by CCR preset)");
  } else {
    console.log(`Model:   ${profile.model}`);
  }
  console.log(`Token:   ${profile.tokenStatus}`);
}

function printGatewayUpstream(upstream: GatewayUpstreamSummary): void {
  console.log(`${upstream.id}\t${upstream.provider}\t${upstream.protocol}\t${upstream.models.join(",")}\t${upstream.endpointUrl}`);
}

async function addGatewayUpstream(id?: string): Promise<void> {
  const templates = listGatewayUpstreamTemplates();
  const templateId = await select({
    message: "Upstream preset template",
    default: "custom",
    choices: templates.map((template) => ({
      name: `${template.label} - ${template.description}`,
      value: template.id
    }))
  });
  const template = getGatewayUpstreamTemplate(templateId);
  const upstreamId = (id?.trim() || await input({
    message: "Upstream ID",
    default: template.defaultUpstreamId || undefined,
    required: true
  })).trim();
  const provider = template.provider;
  const protocol = template.id === "custom"
    ? await promptGatewayProtocol(template.protocol)
    : template.protocol;
  const endpointUrl = await promptGatewayEndpoint(
    protocol,
    provider,
    protocol === template.protocol ? template.endpointUrl : ""
  );
  const models = parseGatewayModels(await input({
    message: "Models (comma-separated, e.g. gpt-5.6-sol, gpt-5.5)",
    default: template.models.length ? template.models.join(", ") : undefined,
    required: true,
    validate: (value) => parseGatewayModels(value).length ? true : "At least one model is required."
  }));
  const apiKey = await password({
    message: "Provider API key (hidden)",
    mask: "*",
    validate: (value) => value.trim() ? true : "API key is required."
  });
  const compatibility = template.id === "custom"
    ? await promptGatewayCompatibility(protocol, provider)
    : { ...template.compatibility };
  console.log(`Template: ${template.label}`);
  console.log(`Upstream: ${upstreamId}`);
  console.log(`Provider: ${provider}`);
  console.log(`Protocol: ${gatewayProtocolLabel(protocol)}`);
  console.log(`Endpoint: ${endpointUrl}`);
  console.log(`Models:   ${models.join(", ")}`);
  if (!(await confirm({ message: "Create this gateway upstream?", default: true }))) {
    console.log("Cancelled.");
    return;
  }
  const created = await createGatewayUpstream({
    id: upstreamId,
    provider,
    protocol,
    endpointUrl,
    apiKey,
    models,
    compatibility
  });
  console.log(`Created gateway upstream '${created.id}'.`);
}

async function editGatewayUpstream(id: string): Promise<void> {
  const current = await readGatewayUpstreamConfig(id);
  const provider = await promptGatewayProvider(current.provider);
  const protocol = await promptGatewayProtocol(current.protocol);
  const endpointUrl = await promptGatewayEndpoint(
    protocol,
    provider,
    protocol === current.protocol && provider === current.provider ? current.endpointUrl : ""
  );
  const models = parseGatewayModels(await input({
    message: "Models (comma-separated, e.g. gpt-5.6-sol, gpt-5.5)",
    default: current.models.join(", "),
    required: true,
    validate: (value) => parseGatewayModels(value).length ? true : "At least one model is required."
  }));
  const apiKey = await password({
    message: "Replacement API key (hidden, Enter to keep current)",
    mask: "*"
  });
  const compatibility = await promptGatewayCompatibility(
    protocol,
    provider,
    current.protocol === protocol ? current.compatibility : undefined
  );
  if (protocol !== current.protocol) {
    const affected = await confirm({
      message: `Change protocol from ${gatewayProtocolLabel(current.protocol)} to ${gatewayProtocolLabel(protocol)}? All profiles bound to '${id}' will use the new protocol on their next request.`,
      default: false
    });
    if (!affected) {
      console.log("Cancelled.");
      return;
    }
  }
  const updated = await updateGatewayUpstream(id, {
    provider,
    protocol,
    endpointUrl,
    apiKey,
    models,
    compatibility
  });
  console.log(`Updated gateway upstream '${updated.id}'. Running requests will use it immediately.`);
}

async function useGatewayBinding(profileName: string, upstreamId?: string, model?: string): Promise<void> {
  const config = await resolveConfigDir(profileName, { allowMain: false });
  const meta = await readMeta(config.dir);
  if (meta?.type !== "gateway" || !meta.gateway) {
    throw new CcpError(`Profile '${profileName}' is not a gateway profile.`);
  }
  let upstream: GatewayUpstreamSummary;
  if (upstreamId?.trim()) {
    const found = (await listGatewayUpstreams()).find((item) => item.id === upstreamId.trim());
    if (!found) throw new CcpError(`Gateway upstream '${upstreamId}' does not exist.`);
    upstream = found;
  } else {
    upstream = await chooseGatewayUpstream(undefined, meta.gateway.upstreamId);
  }
  const selectedModel = model?.trim() || await chooseGatewayModel(
    upstream,
    upstream.id === meta.gateway.upstreamId ? meta.gateway.model : undefined
  );
  if (!upstream.models.includes(selectedModel)) {
    throw new CcpError(`Gateway model '${selectedModel}' is not configured for upstream '${upstream.id}'.`);
  }
  await updateGatewayProfile(config.dir, profileName, {
    upstreamId: upstream.id,
    model: selectedModel
  });
  console.log(`Profile '${profileName}' now uses ${upstream.id}/${selectedModel}.`);
  console.log("The running gateway will apply this binding to the next request.");
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name("ccp")
    .description("Claude Code profile manager")
    .version(getPackageVersion());

  program
    .command("list")
    .description("List Claude Code profiles")
    .action(async () => {
      const profiles = await listProfiles();
      if (profiles.length === 0) {
        console.log("No profiles found.");
        return;
      }
      profiles.forEach(printProfile);
    });

  program
    .command("add")
    .argument("[profile]")
    .option("--preset <preset>", "Create from a built-in preset")
    .description("Create a profile from an interactive template or custom configuration")
    .action(async (profile: string | undefined, options: { preset?: string }) => {
      if (options.preset) {
        const preset = getProfilePreset(options.preset);
        await createProfileFromPreset(profile, preset, { promptName: false });
        return;
      }

      const preset = await selectProfilePreset();
      await createProfileFromPreset(profile, preset, { promptName: true });
    });

  program
    .command("add-login")
    .argument("<profile>")
    .description("Create a login profile that stores a separate Claude Code account login state")
    .action(async (profile: string) => {
      if (!(await ensureProfileCanBeCreated(profile))) return;
      console.log(`Create Claude login profile: ${profile}`);
      console.log("This profile will not set ANTHROPIC_BASE_URL or ANTHROPIC_AUTH_TOKEN.");
      const ok = await confirm({ message: "Create this login profile?", default: true });
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
      const created = await createLoginProfile({ name: profile });
      console.log(`Created Claude login profile '${created.name}'.`);
      console.log(`Run: ccp start ${created.name}`);
      console.log("Then complete the Claude Code login flow for this account.");
    });

  program
    .command("add-ccr")
    .argument("[profile]")
    .option("--preset <preset>", "Create from a built-in CCR preset")
    .description("Create a CCR preset-bound profile")
    .action(async (profile: string | undefined, options: { preset?: string }) => {
      if (options.preset) {
        const preset = getProfilePreset(options.preset);
        if (preset.type !== "ccr") {
          throw new CcpError(`Preset '${options.preset}' is not a CCR preset.`);
        }
        const profileName = profile || preset.defaultProfileName;
        if (!(await ensureProfileCanBeCreated(profileName))) return;
        await ensureCcrSetupForProfileCreation({ requireRoutes: !preset.providerTemplate });
        console.log(`Create CCR profile: ${profileName}`);
        console.log(`Preset: ${preset.label}`);
        console.log(`CCR Preset: ${preset.ccrPreset}`);
        console.log(`Route:      ${preset.ccrRoute}`);
        if (preset.providerTemplate) {
          console.log(`Provider:   ${preset.providerTemplate.name}`);
          console.log(`Endpoint:   ${preset.providerTemplate.api_base_url}`);
        }
        const providerApiKey = preset.providerTemplate ? await password({ message: `${preset.providerTemplate.name} API key for CCR provider (hidden)`, mask: "*" }) : "";
        const token = await password({ message: "ANTHROPIC_AUTH_TOKEN for CCR (hidden, Enter to use preset default)", mask: "*" });
        const ok = await confirm({ message: "Create this CCR profile?", default: true });
        if (!ok) {
          console.log("Cancelled.");
          return;
        }
        const created = await createCcrProfileFromPreset({ presetId: preset.id, name: profileName, token, providerApiKey });
        console.log("Created CCR profile '" + created.name + "'.");
        console.log("Run: ccp start " + created.name);
        return;
      }

      if (!profile) {
        throw new CcpError("Missing profile name. Use 'ccp add-ccr <profile>' or 'ccp add-ccr --preset <preset> [profile]'.");
      }
      if (!(await ensureProfileCanBeCreated(profile))) return;
      await ensureCcrSetupForProfileCreation({ requireRoutes: true });
      const config = await readCcrConfig();
      const routes = getCcrRouteChoices(config);
      if (routes.length === 0) {
        throw new CcpError("No CCR routes found. Run 'ccp ccr model' first.");
      }

      const route = await select({
        message: "Bind this profile to a CCR route",
        choices: routes.map((value) => ({ name: value, value }))
      });

      let token = "";
      if (config?.APIKEY) {
        const useExisting = await confirm({ message: "Use APIKEY from CCR config as ANTHROPIC_AUTH_TOKEN?", default: true });
        if (useExisting) {
          token = String(config.APIKEY);
        }
      }

      if (!token) {
        token = await password({ message: "ANTHROPIC_AUTH_TOKEN for CCR (hidden, Enter to use ccr-local-secret)", mask: "*" });
      }

      console.log("");
      console.log("Profile: " + profile);
      console.log("Type:    ccr");
      console.log("Route:   " + route);
      console.log("Token:   set");
      const ok = await confirm({ message: "Create this CCR profile?", default: true });
      if (!ok) {
        console.log("Cancelled.");
        return;
      }

      const created = await createCcrProfile({ name: profile, route, token });
      console.log("Created CCR profile '" + created.name + "'.");
      console.log("Run: ccp start " + created.name);
    });

  program
    .command("remove")
    .argument("<profile>")
    .description("Delete a profile")
    .action(async (profile: string) => {
      const config = await resolveProfileDirForRemoval(profile);
      console.log(`This will permanently delete Claude profile '${profile}':`);
      console.log(config.dir);
      console.log("This cannot be undone. No backup will be created.");
      const typed = await input({ message: `Type '${profile}' to delete` });
      if (typed !== profile) {
        console.log("Cancelled.");
        return;
      }
      await removeProfile(profile);
      console.log(`Deleted profile '${profile}'.`);
    });

  program
    .command("status")
    .argument("<profile>")
    .description("Show profile status")
    .action(showStatus);

  program
    .command("path")
    .argument("<profile>")
    .description("Print profile config path")
    .action(async (profile: string) => {
      const config = await resolveConfigDir(profile, { allowMain: true });
      console.log(config.dir);
    });

  program
    .command("edit")
    .argument("<profile>")
    .description("Open a profile configuration file in your editor")
    .action(async (profile: string) => {
      const config = await resolveConfigDir(profile, { allowMain: false });
      const meta = await readMeta(config.dir);
      const code = await openEditor(meta?.type === "gateway" ? getMetaPath(config.dir) : getSettingsPath(config.dir));
      process.exitCode = code;
    });

  program
    .command("start")
    .argument("<profile>")
    .allowUnknownOption(true)
    .argument("[claudeArgs...]", "Arguments passed through to Claude Code")
    .description("Start Claude Code with a profile")
    .action(async (profile: string, claudeArgs: string[]) => {
      const code = await launchClaude({
        name: profile,
        claudeArgs,
        confirmMainConfigCwd: async ({ currentDir, fallbackDir, profileName }) => {
          console.log("");
          console.log("Current directory is the Claude main config location:");
          console.log(`  ${currentDir}`);
          console.log("");
          console.log(`Claude Code may read project settings that override profile '${profileName}'.`);
          console.log("");
          console.log("If you continue, ccp will switch to this isolated workdir:");
          console.log(`  ${fallbackDir}`);
          console.log("");
          return confirm({ message: "Continue and switch workdir?", default: false });
        }
      });
      process.exitCode = code;
    });

  const gateway = program
    .command("gateway")
    .description("Manage the gateway service and OpenAI-format upstreams")
    .action(async () => printGatewayStatus(await getGatewayStatus()));

  gateway.command("status")
    .description("Show gateway service status")
    .action(async () => printGatewayStatus(await getGatewayStatus()));

  gateway.command("start")
    .description("Start the shared gateway service")
    .action(async () => printGatewayStatus(await startGateway()));

  gateway.command("stop")
    .description("Stop the shared gateway service")
    .action(async () => printGatewayStatus(await stopGateway()));

  gateway.command("restart")
    .description("Restart the shared gateway service")
    .action(async () => printGatewayStatus(await restartGateway()));

  gateway.command("list")
    .description("List configured OpenAI-format upstreams")
    .action(async () => {
      const upstreams = await listGatewayUpstreams();
      if (!upstreams.length) {
        console.log("No gateway upstreams found. Run 'ccp gateway add'.");
        return;
      }
      upstreams.forEach(printGatewayUpstream);
    });

  gateway.command("add")
    .argument("[id]")
    .description("Create an OpenAI official or OpenAI-compatible upstream")
    .action(addGatewayUpstream);

  gateway.command("edit")
    .argument("<id>")
    .description("Edit an upstream and hot-reload future requests")
    .action(editGatewayUpstream);

  gateway.command("remove")
    .argument("<id>")
    .description("Delete an unused gateway upstream")
    .action(async (id: string) => {
      const typed = await input({ message: `Type '${id}' to delete this upstream` });
      if (typed !== id) {
        console.log("Cancelled.");
        return;
      }
      await removeGatewayUpstream(id);
      console.log(`Deleted gateway upstream '${id}'.`);
    });

  gateway.command("use")
    .argument("<profile>")
    .argument("[upstreamId]")
    .argument("[model]")
    .description("Switch a gateway profile to an upstream and model")
    .action(useGatewayBinding);

  program
    .command("ccr")
    .helpOption(false)
    .argument("[action]")
    .allowUnknownOption(true)
    .argument("[extraArgs...]", "Arguments passed through to ccr")
    .description("Manage Claude Code Router integration")
    .action(async (action: string | undefined, extraArgs: string[]) => {
      switch (action) {
        case undefined:
        case "status": {
          printCcrStatus(await getCcrStatus());
          break;
        }
        case "install": {
          process.exitCode = await installCcr();
          break;
        }
        case "start": {
          await startCcrService();
          break;
        }
        case "stop": {
          await stopCcrService();
          break;
        }
        case "restart": {
          await restartCcrService();
          break;
        }
        case "ui":
        case "model": {
          process.exitCode = await invokeCcrCli(action, extraArgs);
          break;
        }
        default: {
          throw new CcpError(`Unknown ccr command '${action}'. Use 'ccp ccr status|install|start|stop|restart|ui|model'.`);
        }
      }
    });

  program
    .command("sync-session")
    .argument("<first>")
    .allowUnknownOption(true)
    .argument("[syncArgs...]", "Use '<source> to <target>' and optional --all")
    .description("Sync Claude Code sessions between profiles")
    .action(async (first: string, syncArgs: string[]) => {
      const result = await syncSessions({
        first,
        args: syncArgs,
        selectSessions: selectSessionFiles,
        confirmOverwrite: confirmSessionConflict
      });
      if (!result) return;

      console.log("Synced current project sessions.");
      console.log("Project: " + result.projectKey);
      console.log("From:    " + result.sourceName + " -> " + result.sourceProjectDir);
      console.log("To:      " + result.targetName + " -> " + result.targetProjectDir);
      console.log("Selected: " + result.selected);
      console.log("copied=" + result.counts.copied + ", updated=" + result.counts.updated + ", unchanged=" + result.counts.unchanged + ", overwritten=" + result.counts.overwritten + ", conflict=" + result.counts.conflict);
      if (result.conflicts.length > 0) {
        console.log("Conflicts skipped:");
        result.conflicts.forEach((name) => console.log("  " + name));
      }
    });

  program
    .command("ui")
    .description("Start the local web UI")
    .option("--host <host>", "Host to bind", "127.0.0.1")
    .option("--port <port>", "Port to listen on", (value) => Number(value), 7821)
    .option("--no-open", "Do not open the UI in the default browser")
    .action(async (options: { host: string; port: number; open: boolean }) => {
      await startUiServer({ host: options.host, port: options.port, open: options.open });
    });

  return program;
}
