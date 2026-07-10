import { confirm, input, password, select } from "@inquirer/prompts";
import { readFileSync } from "node:fs";
import { Command } from "commander";
import { CcpError } from "../core/errors.js";
import { launchClaude } from "../core/launcher.js";
import { resolveConfigDir } from "../core/profiles.js";
import {
  createApiProfile,
  createCcrProfile,
  createLoginProfile,
  listProfiles,
  profileExists,
  removeProfile,
  summarizeProfile
} from "../core/profiles.js";
import { getSettingsPath } from "../core/settings.js";
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
import { createApiProfileFromPreset, createCcrProfileFromPreset, getProfilePreset, listProfilePresets, type BuiltinProfilePreset } from "../core/presets.js";
import { startUiServer } from "../web/server.js";
import { openEditor } from "../platform/editor.js";
import { parseSelectionText, syncSessions, type SessionDisplayInfo } from "../core/sessions.js";

function getPackageVersion(): string {
  try {
    const packageJsonUrl = new URL("../../package.json", import.meta.url);
    const packageJson = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as { version?: string };
    return packageJson.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

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
      const config = await resolveConfigDir(profile, { allowMain: false });
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
    .description("Open a profile settings file in your editor")
    .action(async (profile: string) => {
      const config = await resolveConfigDir(profile, { allowMain: false });
      const code = await openEditor(getSettingsPath(config.dir));
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
