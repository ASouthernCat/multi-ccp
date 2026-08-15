# multi-ccp

[![NPM Version][npm-version]][npm-url]
[![NPM Downloads][npm-downloads]][npm-url]
[![License][license]][license-url]

English | [简体中文](README.zh-CN.md)

`multi-ccp` is a profile and session manager for Claude Code. It installs the `ccp` command and helps you run multiple Claude Code windows with fully isolated configuration directories, model providers, login state, and history.

Use it when you want separate Claude Code sessions for work, personal projects, different API providers, or different model routes without manually switching environment variables or editing config files.
![multi-ccp](docs/images/cli-ui.png)
![multi-ccp](docs/images/image.png)

## Features

- Run multiple Claude Code windows with independent profiles.
- Keep each profile's Claude Code config, login state, environment variables, and project history isolated.
- Create Anthropic-compatible API profiles with custom `ANTHROPIC_BASE_URL`, token, and model settings.
- Create Claude login profiles that use Claude Code's normal account login flow without storing account passwords.
- Use the built-in gateway to run Claude Code against OpenAI or OpenAI-compatible Responses and Chat Completions providers.
- Run multiple gateway profiles concurrently through one local process while keeping upstream URLs, models, credentials, tools, streams, and cancellation state isolated per request.
- Sync historical Claude Code sessions between profiles or between `main` and a profile.

## Install

```bash
npm install -g multi-ccp
```

Verify the install:

```bash
ccp --version
ccp help
```

Update `multi-ccp`:

```bash
npm install -g multi-ccp@latest
```

## Quick Start

Want the shortest path? Ask your AI assistant how to use `multi-ccp`. Copy this prompt:

```text
How do I use multi-ccp to manage multiple Claude Code profiles? Refer to the README: https://github.com/ASouthernCat/multi-ccp.
```

Then continue with the examples below when you want the full command reference.

Open the local Web UI to browse profiles and create configurations visually:

```bash
ccp ui
```

The Web UI is a local companion for the CLI. It helps you inspect profiles, create preset-based profiles, edit profile settings, manage the shared gateway service and reusable upstreams, switch profile models, and inspect redacted request logs.

Create a profile interactively:

```bash
ccp add
ccp start <profile-name>
```

`ccp add` lets you choose a built-in preset template or custom configuration, including Built-in Gateway, DeepSeek, AI CodeMirror, Mimo, Claude Login, or Custom API.

Profile names may contain letters, numbers, periods, underscores, and hyphens, so names such as `gpt-5.6` are valid. Names must start with a letter or number, cannot end with a period, and cannot use Windows reserved device names.

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

### Built-in Gateway

The gateway translates Claude Code's Anthropic Messages protocol to either OpenAI Responses or OpenAI Chat Completions, depending on the selected upstream protocol. It uses three independent layers: one shared local service, reusable upstream provider records, and lightweight profiles that only select an upstream and model.

Create an official OpenAI upstream. The official template defaults to the Responses endpoint `https://api.openai.com/v1/responses`:

Upstream creation provides shared preset templates:

- `OpenAI official`: pre-fills the Responses endpoint with `gpt-5.6`, `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- `xAI Grok 4.5`: pre-fills `https://api.x.ai/v1/responses` and `grok-4.5`.
- `AICodeMirror`: pre-fills the Codex-compatible Responses endpoint and `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.5`.
- `Custom OpenAI-compatible`: lets you choose Responses or Chat Completions and enter a base URL or full endpoint URL, models, and compatibility settings.

```bash
ccp gateway add openai
ccp add --preset gateway openai-work
ccp start openai-work
```

Create an OpenAI-compatible upstream such as AICodeMirror, Mimo, OpenRouter, or another proxy. Custom upstreams can use either Responses or Chat Completions; the Web UI accepts a base URL and completes it to `/v1/responses` or `/v1/chat/completions` based on the selected protocol. The CLI prompts for the full endpoint URL.

Separate multiple model IDs with commas, for example `gpt-5.6-sol, gpt-5.5`. The CLI and Web UI can also query the upstream's `base URL + /models` endpoint with its API key, then let you search, select, and add the returned model IDs without replacing models that are already configured.

```bash
ccp gateway add aicodemirror
ccp add --preset gateway gpt-5.6
ccp start gpt-5.6
```

The single Gateway profile template can bind any existing upstream; OpenAI official and OpenAI-compatible are upstream creation templates rather than separate profile types. One upstream can expose multiple selectable models and can be reused by many profiles. Switch a profile without restarting the running gateway:

```bash
ccp gateway use gpt-5.6 aicodemirror gpt-5.5
```

Responses upstreams offer OpenAI-compatible and advanced Responses mappings. Chat Completions upstreams offer modern, legacy, and advanced Chat Completions mappings. The gateway does not auto-detect provider protocol support: choose the protocol that the upstream actually supports. Native Gemini or Anthropic provider formats are not supported by this gateway.

Existing Chat Completions upstreams continue to work and are not silently migrated to Responses. Legacy v1 upstream configs load as Chat Completions and are saved as v2 only after editing. Starting the upgraded CLI may replace an owned older-protocol gateway process so later requests use the current runtime.

Responses reasoning summaries are currently omitted rather than mapped to Anthropic thinking, and Anthropic extended-thinking requests remain rejected. Ordinary Claude Code image blocks and image-bearing tool results are sent natively to OpenAI Responses (`input_image`) or Chat Completions (`image_url`); Chat tool-result images use a following attributed user message because Chat tool-role content cannot carry images. The gateway does not fetch, resize, persist, or silently remove input images, and an upstream that does not support vision returns its normal error. Completed Responses `image_generation_call` output is validated as PNG, JPEG, or WebP (up to 32 MiB), atomically saved under `~/.claude-profiles/.gateway/generated/<session-or-request>/`, and returned to Claude Code as an absolute local path. Partial images are ignored, duplicate final payloads are de-duplicated by SHA-256, and image base64 is never copied into Anthropic SSE or gateway logs.

All gateway profiles use one loopback-only service at `http://127.0.0.1:3921`. Each Claude Code process receives a profile-specific base path and local token, so concurrent profiles can safely target different providers. Starting a second gateway profile reuses the running service and does not restart active streams.

The local Web UI masks API keys by default. Opening an API profile or upstream editor retrieves the stored key through a UI-token-protected, non-cacheable POST endpoint; normal profile and upstream GET responses never expose the plaintext key.

The gateway writes one redacted JSON line per profile request to `~/.claude-profiles/.gateway/gateway.log`. It records the profile, model, protocol, endpoint host, sanitized endpoint URL, Claude effort, upstream field names, status, duration, and available token usage, but never prompt or response content, authorization headers, API keys, URL userinfo, query strings, or fragments. Failures also include a stable `failureStage` / `failureCode`, the upstream HTTP status and bounded request ID when available, and SSE timing/terminal metadata. This distinguishes an upstream HTTP failure from a stream conversion error or an upstream stream that ended without a terminal event. If an SSE response has already started with HTTP 200 and later fails protocol conversion, the internal log status is `502`. Logs rotate to `gateway.log.1` at 10 MiB when the gateway starts.

The gateway supports Messages requests, non-streaming and SSE responses, text, native image input, native image-bearing tool results, tool calls, parallel tool calls, `output_config.effort`, JSON Schema structured output, usage conversion, client cancellation, and Claude Code's `?beta=true` and `HEAD` probes. Each Gateway Profile routes Claude Code's `Default` row through a display-aware default alias to the Profile Binding's default model and also lists every current-Upstream model as a selectable `From gateway` option alias. The local catalog pre-registers a Default display alias for every model on that Upstream, so changing the Binding refreshes the model name shown by `/model` in an existing session and switches sessions that use Default on their next request without restarting the gateway. An explicit `/model` selection remains fixed when that model is available on the chosen Upstream. Default remains readable, the same model can appear as a selectable entry, and the built-in Opus row is not exposed.

multi-ccp pre-populates and refreshes Claude Code's local gateway model catalog when a Gateway Profile is created, repaired before startup, or rebound, so the readable provider model name is available on the first launch instead of briefly exposing an internal alias. Gateway aliases use only the reserved `anthropic.ccp-*` namespace; old `claude-ccp-*` aliases are not supported. Models outside the current Upstream return `400` instead of silently falling back. When a model is added after Claude Code starts, rebinding the Profile hot-adds it through a temporary `anthropic.<model-id>` picker entry and updates Default through Claude's hot-reloaded tier setting; the next `ccp start` restores the normal catalog labels. A still-valid `/model` selection is preserved.

Because provider-defined model IDs do not carry reliable context-window metadata, Gateway Profiles set `CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT=1` and `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. They do not declare a fixed context window: startup repair removes legacy compact-window overrides and leaves `/autocompact` at Claude Code's default `auto`, while the gateway/upstream error contract governs the actual limit. The gateway accepts Claude Code 2.1.233 auto-mode classifier requests that explicitly disable thinking, while adaptive and enabled thinking remain unsupported. Optional token counting intentionally returns `404`, allowing Claude Code to use its fallback behavior, and the request log marks it as an expected compatibility fallback rather than an inference failure.

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
ccp remove <profile>
ccp status <profile|main>
ccp start <profile> [claude args...]
ccp path <profile|main>
ccp edit <profile>
```

Built-in gateway commands:

```bash
ccp gateway status
ccp gateway start
ccp gateway stop
ccp gateway restart
ccp gateway list
ccp gateway add [upstream-id]
ccp gateway edit <upstream-id>
ccp gateway remove <upstream-id>
ccp gateway use <profile> [upstream-id] [model]
```

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

Gateway profile metadata stores only `upstreamId` and the selected model. Its `.ccp-gateway.json` stores only the generated local token. Reusable upstream configs store the selected `protocol`, full `endpointUrl`, model list, and compatibility mapping under `~/.claude-profiles/.gateway/upstreams/`, while provider API keys are stored separately under `~/.claude-profiles/.gateway/secrets/`. The profile's `settings.json` is derived automatically before launch and should not be used as the source of truth for gateway routing.

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
- `ccp add` and `ccp add-login` refuse to overwrite existing profiles.
- `sync-session` detects conflicts with SHA-256 hashes and asks before overwriting target files.
- Login profiles do not store Claude account passwords.
- Gateway API keys are kept in upstream secret files and out of profile directories, `.ccp.json`, ordinary Web UI GET/list responses, logs, and upstream error envelopes. The local editor retrieves a key only through a UI-token-protected, non-cacheable POST endpoint, keeps it masked by default, and reveals it only when the user presses the eye control.
- The built-in gateway binds only to `127.0.0.1`, authenticates each profile path with a generated local token, and does not follow upstream redirects with credentials.

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
