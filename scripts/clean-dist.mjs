import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.resolve(root, "dist");

if (path.dirname(target) !== root || path.basename(target) !== "dist") {
  throw new Error(`Refusing to clean unexpected build directory: ${target}`);
}

await rm(target, { recursive: true, force: true });
