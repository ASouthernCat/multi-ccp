import { confirm, input, password } from "@inquirer/prompts";
import { Command } from "commander";
import { CcpError } from "../core/errors.js";
import { launchClaude } from "../core/launcher.js";
import { resolveConfigDir } from "../core/profiles.js";
import {
  createApiProfile,
  createLoginProfile,
  listProfiles,
  removeProfile,
  summarizeProfile
} from "../core/profiles.js";
import { getSettingsPath } from "../core/settings.js";
import { getCcrStatusPlaceholder } from "../core/ccr.js";
import { openEditor } from "../platform/editor.js";

function printProfile(profile: Awaited<ReturnType<typeof summarizeProfile>>): void {
  if (profile.model) {
    console.log(`${profile.name}\t${profile.model}\t${profile.baseUrl}`);
  } else {
    console.log(`${profile.name}\t${profile.baseUrl}`);
  }
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
    .version("0.1.0");

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
    .argument("<profile>")
    .description("Create an API profile with base URL, token, and model")
    .action(async (profile: string) => {
      console.log(`Create Claude API profile: ${profile}`);
      const baseUrl = await input({ message: "ANTHROPIC_BASE_URL", required: true });
      const token = await password({ message: "ANTHROPIC_AUTH_TOKEN (hidden, Enter to leave placeholder)", mask: "*" });
      const model = await input({ message: "Model", required: true });
      const ok = await confirm({ message: "Create this profile?", default: true });
      if (!ok) {
        console.log("Cancelled.");
        return;
      }
      const created = await createApiProfile({ name: profile, baseUrl, token, model });
      console.log(`Created profile '${created.name}'.`);
      console.log(`Run: ccp start ${created.name}`);
    });

  program
    .command("add-login")
    .argument("<profile>")
    .description("Create a login profile that stores a separate Claude Code account login state")
    .action(async (profile: string) => {
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
    .argument("[action]")
    .description("Manage Claude Code Router integration")
    .action(() => {
      const status = getCcrStatusPlaceholder();
      console.log(status.message);
      process.exitCode = 1;
    });

  program
    .command("sync-session")
    .allowUnknownOption(true)
    .description("Sync Claude Code sessions between profiles")
    .action(() => {
      throw new CcpError("sync-session is planned for a later TypeScript CLI release. Use the legacy PowerShell ccp for now.");
    });

  program
    .command("ui")
    .description("Start the local web UI")
    .action(() => {
      throw new CcpError("Web UI is planned. It will use vanilla web components and no Vue/React runtime.");
    });

  return program;
}
