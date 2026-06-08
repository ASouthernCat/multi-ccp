import { cp, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "src", "web", "assets");
const target = path.join(root, "dist", "web", "assets");

if (existsSync(source)) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}
