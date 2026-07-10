# multi-ccp

[![NPM Version][npm-version]][npm-url]
[![NPM Downloads][npm-downloads]][npm-url]
[![License][license]][license-url]

English | [简体中文](README.zh-CN.md)

`multi-ccp` is a profile and session manager for Claude Code. It installs the `ccp` command and helps you run multiple Claude Code windows with fully isolated configuration directories, model providers, login state, and history.

Use it when you want separate Claude Code sessions for work, personal projects, different API providers, or different model routes without manually switching environment variables or editing config files.

![multi-ccp](docs/images/image.png)

## Features

- Run multiple Claude Code windows with independent profiles.
- Keep each profile's Claude Code config, login state, environment variables, and project history isolated.
- Create Anthropic-compatible API profiles with custom `ANTHROPIC_BASE_URL`, token, and model settings.
- Create Claude login profiles that use Claude Code's normal account login flow without storing account passwords.
- Create [Claude Code Router](https://github.com/musistudio/claude-code-router) preset profiles for multiple model providers and routes.
- Manage [Claude Code Router](https://github.com/musistudio/claude-code-router) from the same CLI.
- Sync historical Claude Code sessions between profiles or between `main` and a profile.
- Open and inspect profile settings quickly from the terminal.

## Install

```bash
npm install -g multi-ccp
```

Verify the install:

```bash
ccp --version
ccp help
```

## Quick Start

Want the shortest path? Ask your AI assistant how to use `multi-ccp`. Copy this prompt:

```text
How do I use multi-ccp to manage multiple Claude Code profiles?
```

Then continue with the examples below when you want the full command reference.

Open the local Web UI to browse profiles and create configurations visually:

```bash
ccp ui
```

The Web UI is a local companion for the CLI. It helps you inspect profiles, create preset-based profiles, edit profile settings, and open CCR management shortcuts.

![multi-ccp](docs/images/cli-ui.png)

Create a profile interactively:

```bash
ccp add
ccp start <profile-name>
```

`ccp add` lets you choose a built-in preset template or custom configuration, including DeepSeek, AI CodeMirror, Mimo, CCR GPT, Manual CCR, Claude Login, or Custom API.

If you want to create directly from a built-in preset, pass `--preset`:

```bash
ccp add --preset deepseek
ccp add --preset deepseek my-ds
ccp start my-ds
```

Create another isolated profile for a different provider, account, or project context:

```bash
ccp add
ccp start <profile-name>
```

List and inspect profiles:

```bash
ccp list
ccp status work
ccp path work
```

## Profile Types

### API Profiles

API profiles are for Anthropic-compatible providers. They store API environment variables in the profile's `settings.json`.

```bash
ccp add
ccp start <profile-name>
```

When you choose an API preset, the command prompts for a profile name and token. When you choose Custom API, it prompts for:

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`
- Model name (optional; leave empty to use Claude Code's default model)

#### Customizing Provider Models

`ccp add` keeps provider setup simple by applying the model you enter to all default Claude Code model slots. If you leave the model empty, `multi-ccp` does not write any model environment variables and Claude Code uses its default model. For example, a DeepSeek profile with a model may initially look like this:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-",
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro",
    "ANTHROPIC_MODEL": "deepseek-v4-pro"
  }
}
```

If your provider offers different models for fast tasks, subagents, or long-context work, edit the profile manually:

```bash
ccp edit deepseek
```

For example, you can assign a flash model to lightweight work and a 1M context model to the main model slots:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-",
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro[1M]",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "deepseek-v4-pro[1M]",
    "CLAUDE_CODE_SUBAGENT_MODEL": "deepseek-v4-flash",
    "ANTHROPIC_MODEL": "deepseek-v4-pro[1M]"
  }
}
```

See the [DeepSeek API documentation](https://api-docs.deepseek.com/) for provider-specific model names and endpoint details.

### Login Profiles

Login profiles are for Claude Code account-based authentication. They do not set `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`.

```bash
ccp add
ccp start <profile-name>
```

When Claude Code asks you to sign in, the login state is stored under that profile's config directory. Another profile can use a different account or login state:

```bash
ccp add-login personal
ccp start personal
```

`ccp add-login <profile>` remains available as a direct compatibility entrypoint.

### Claude Code Router Profiles

CCR profiles are bound to [Claude Code Router](https://github.com/musistudio/claude-code-router) presets. Claude Code Router is a separate open source project that can route Claude Code requests to different model providers. `multi-ccp` integrates with its config and preset system so each profile can use its own provider route.

```bash
ccp ccr status
ccp ccr model
ccp add
ccp start <profile-name>
```

A CCR profile stores its route in `.ccp.json` and points Claude Code at a preset endpoint such as:

```text
http://127.0.0.1:3456/preset/gpt-route
```

## Session Sync

`sync-session` copies Claude Code history for the current project between profiles. It can sync selected sessions interactively or all sessions at once.

Sync from `main` to a profile:

```bash
ccp sync-session work
ccp sync-session work --all
```

Sync between two named profiles:

```bash
ccp sync-session work to personal
ccp sync-session work to personal --all
```

Sync from a profile back to `main`:

```bash
ccp sync-session work to main
```

The sync command tracks hashes in `.ccp-sync`, copies session assets, and prompts before overwriting conflicting target sessions.

## Commands

```bash
ccp help
ccp list
ccp ui
ccp add [profile]
ccp add --preset <preset> [profile]
ccp add-login <profile>
ccp add-ccr <profile>
ccp remove <profile>
ccp status <profile|main>
ccp start <profile> [claude args...]
ccp path <profile|main>
ccp edit <profile>
```

[Claude Code Router](https://github.com/musistudio/claude-code-router) commands:

```bash
ccp ccr status
ccp ccr install
ccp ccr start
ccp ccr stop
ccp ccr restart
ccp ccr ui
ccp ccr model
```

`ccp ccr install` pins CCR to `@musistudio/claude-code-router@2.0.0`. CCR 3.x is a rewrite and is not compatible with multi-ccp.

Session sync commands:

```bash
ccp sync-session <target-profile> [--all]
ccp sync-session <source-profile|main> to <target-profile|main> [--all]
```

## Configuration Layout

Profiles are stored under:

```text
~/.claude-profiles/<profile>
```

Claude Code's default config directory is still available as:

```text
main
```

For example:

```bash
ccp status main
ccp sync-session main to work
ccp sync-session work to main
```

## Safety Notes

- `ccp remove <profile>` asks you to type the profile name before deleting it.
- `ccp add`, `ccp add-login`, and `ccp add-ccr` refuse to overwrite existing profiles.
- `sync-session` detects conflicts with SHA-256 hashes and asks before overwriting target files.
- Login profiles do not store Claude account passwords.

## Development

```bash
git clone <repository-url>
cd multi-ccp
npm install
npm run typecheck
npm test
npm run build
```

Run the CLI from source:

```bash
npm run dev -- help
```

Preview the npm package:

```bash
npm pack --dry-run
```

## License

MIT

[npm-version]: https://img.shields.io/npm/v/multi-ccp?style=flat-square
[npm-downloads]: https://img.shields.io/npm/dm/multi-ccp?style=flat-square
[npm-url]: https://www.npmjs.com/package/multi-ccp
[license]: https://img.shields.io/npm/l/multi-ccp?style=flat-square
[license-url]: LICENSE
