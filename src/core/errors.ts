export class CcpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CcpError";
  }
}

export function assertProfileName(name: string): void {
  if (!name.trim()) {
    throw new CcpError("Missing profile name.");
  }

  if (name.toLowerCase() === "main") {
    throw new CcpError("'main' is reserved and cannot be used as a profile name.");
  }

  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new CcpError(
      `Invalid profile name '${name}'. Use letters, numbers, underscore, or hyphen, and start with a letter or number.`
    );
  }
}
