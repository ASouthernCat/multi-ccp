import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { assertProfileName, CcpError } from "../core/errors.js";
import { readGatewayProfile } from "../core/gateway-profile.js";
import { getProfilesRoot, type PathContext } from "../core/paths.js";
import { getMetaPath } from "../core/settings.js";
import type { GatewayProfileConfig, GatewayProfileSecret } from "../core/types.js";
import { getGatewaySecretPath } from "../core/gateway-profile.js";

export interface GatewayRouteSnapshot {
  profileName: string;
  profileDir: string;
  config: Readonly<GatewayProfileConfig>;
  secret: Readonly<GatewayProfileSecret>;
  fingerprint: string;
}

interface CacheEntry {
  fingerprint: string;
  snapshot: GatewayRouteSnapshot;
}

export class GatewayRegistry {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly pending = new Map<string, Promise<GatewayRouteSnapshot>>();

  constructor(private readonly context: PathContext = {}) {}

  async resolve(profileName: string): Promise<GatewayRouteSnapshot> {
    assertProfileName(profileName);
    const fingerprint = await this.readFingerprint(profileName);
    const cached = this.cache.get(profileName);
    if (cached?.fingerprint === fingerprint) {
      return cached.snapshot;
    }

    const existing = this.pending.get(profileName);
    if (existing) {
      return existing;
    }

    const load = this.load(profileName, fingerprint).finally(() => {
      if (this.pending.get(profileName) === load) {
        this.pending.delete(profileName);
      }
    });
    this.pending.set(profileName, load);
    return load;
  }

  async countProfiles(): Promise<number> {
    const root = getProfilesRoot(this.context);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue;
      }
      try {
        await readGatewayProfile(path.join(root, entry.name));
        count += 1;
      } catch {
        // Invalid and non-gateway profiles are not included in the health count.
      }
    }
    return count;
  }

  private async load(profileName: string, expectedFingerprint: string): Promise<GatewayRouteSnapshot> {
    const profileDir = path.join(getProfilesRoot(this.context), profileName);
    const loaded = await readGatewayProfile(profileDir);
    const actualFingerprint = await this.readFingerprint(profileName);
    if (actualFingerprint !== expectedFingerprint) {
      return this.load(profileName, actualFingerprint);
    }
    const snapshot = deepFreeze({
      profileName,
      profileDir,
      config: loaded.config,
      secret: loaded.secret,
      fingerprint: actualFingerprint
    });
    this.cache.set(profileName, { fingerprint: actualFingerprint, snapshot });
    return snapshot;
  }

  private async readFingerprint(profileName: string): Promise<string> {
    const profileDir = path.join(getProfilesRoot(this.context), profileName);
    try {
      const [meta, secret] = await Promise.all([
        stat(getMetaPath(profileDir)),
        stat(getGatewaySecretPath(profileDir))
      ]);
      return `${meta.mtimeMs}:${meta.size}:${secret.mtimeMs}:${secret.size}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CcpError(`Gateway profile '${profileName}' is missing configuration or secret files.`);
      }
      throw error;
    }
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    deepFreeze(nested);
  }
  return value;
}
