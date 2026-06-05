# multi-ccp

Cross-platform Claude Code profile manager for multiple API profiles, separate Claude login accounts, and future Claude Code Router workflows.

The command name is `ccp`.

## Goals

- Manage multiple Claude Code config directories through `CLAUDE_CONFIG_DIR`.
- Support API profiles with `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and model env.
- Support login profiles that keep separate Claude Code account login state without storing account passwords.
- Run on Windows, macOS, and Linux from one npm package.
- Keep the core profile logic reusable for a future framework-free local Web UI.

## Install

```bash
npm install -g multi-ccp
```

For local development:

```bash
npm install
npm run build
npm run dev -- help
```

## Commands

```bash
ccp help
ccp list
ccp add <profile>
ccp add-login <profile>
ccp add-ccr <profile>
ccp remove <profile>
ccp status <profile|main>
ccp start <profile> [claude args...]
ccp path <profile|main>
ccp edit <profile>
ccp ccr status
ccp ccr install
ccp ccr start
ccp ccr stop
ccp ccr restart
ccp ccr ui
ccp ccr model
```

## Profile Types

### API profile

```bash
ccp add deepseek
ccp start deepseek
```

Creates `~/.claude-profiles/deepseek/settings.json` with Anthropic-compatible API environment variables.

### Login profile

```bash
ccp add-login work
ccp start work
```

Creates a profile without `ANTHROPIC_BASE_URL` or `ANTHROPIC_AUTH_TOKEN`. Claude Code stores that account's login state under the profile config directory when you complete the normal Claude Code login flow.

Create another login account with:

```bash
ccp add-login personal
ccp start personal
```

Each profile gets its own `CLAUDE_CONFIG_DIR`.

## Current Scope

This TypeScript npm version currently implements the cross-platform profile manager MVP:

- `list`
- `add`
- `add-login`
- `remove`
- `status`
- `path`
- `edit`
- `start`
- `add-ccr`
- CCR preset generation and CCR profile auto-start integration
- `ccp ccr status|install|start|stop|restart|ui|model`

Planned migrations from the legacy PowerShell tool:

- `sync-session`
- `ccp ui`

The future Web UI should use vanilla browser APIs or Web Components. Vue and React are intentionally out of scope for the runtime UI. Icon libraries such as Lucide are acceptable.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## License

MIT
