export type ProfileType = "api" | "login" | "ccr" | "unknown";

export interface ClaudeSettings {
  theme?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProfileMeta {
  version: number;
  type: Exclude<ProfileType, "unknown">;
  createdAt?: string;
  endpoint?: string;
  autoStart?: boolean;
  ccrPreset?: string;
  ccrRoute?: string;
}

export interface ProfileSummary {
  name: string;
  dir: string;
  type: ProfileType;
  baseUrl: string;
  model: string;
  tokenStatus: "set" | "missing";
  settingsPath: string;
  meta?: ProfileMeta;
}

export interface CreateApiProfileInput {
  name: string;
  baseUrl: string;
  token: string;
  model: string;
}

export interface CreateLoginProfileInput {
  name: string;
}
