export class CcpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CcpError";
  }
}

const WINDOWS_RESERVED_PROFILE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export const RESERVED_PROFILE_NAMES: ReadonlySet<string> = new Set([
  "main",
  "web-ui",
  "supervisor",
  "__supervisor__"
]);

export function assertProfileName(name: string): void {
  if (!name.trim()) {
    throw new CcpError("Missing profile name.");
  }

  if (RESERVED_PROFILE_NAMES.has(name.toLowerCase())) {
    throw new CcpError(`'${name}' is a reserved protocol identity and cannot be used as a profile name.`);
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name.endsWith(".")) {
    throw new CcpError(
      `Invalid profile name '${name}'. Use letters, numbers, periods, underscores, or hyphens; start with a letter or number and do not end with a period.`
    );
  }

  if (WINDOWS_RESERVED_PROFILE_NAME.test(name)) {
    throw new CcpError(`Invalid profile name '${name}'. Windows reserved device names cannot be used.`);
  }
}
