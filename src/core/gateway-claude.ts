const COMPACTION_OVERRIDE_ENV_NAMES = [
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "DISABLE_AUTO_COMPACT",
  "DISABLE_COMPACT"
] as const;

/** Keep Gateway sessions on Claude Code's automatic, upstream-governed context policy. */
export function applyGatewayContextPolicy(env: NodeJS.ProcessEnv): void {
  for (const name of COMPACTION_OVERRIDE_ENV_NAMES) delete env[name];
  env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
  env.CLAUDE_CODE_DISABLE_1M_CONTEXT = "1";
}
