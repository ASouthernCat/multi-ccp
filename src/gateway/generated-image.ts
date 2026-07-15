import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getGatewayGeneratedDir, type PathContext } from "../core/paths.js";
import { upstreamProtocolError } from "./errors.js";

const DEFAULT_MAX_IMAGE_BYTES = 32 * 1024 * 1024;

export interface PreparedGeneratedImage {
  path: string;
  bytes: Buffer;
  sha256: string;
  format: "png" | "jpeg" | "webp";
}

export function formatGeneratedImageSavedText(imagePath: string): string {
  return `Generated image saved to:\n\`${imagePath}\``;
}

export interface GeneratedImageStoreOptions {
  context?: PathContext;
  requestId: string;
  sessionId?: string;
  maxBytes?: number;
}

function safeSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return (normalized || "image").slice(0, 96);
}

function decodeBase64(value: string, maxBytes: number): Buffer {
  const compact = value.replace(/\s+/g, "");
  if (!compact || compact.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw upstreamProtocolError("image_generation_call.result: Expected valid base64 image data.");
  }
  const paddingBytes = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const estimatedBytes = Math.floor(compact.length * 3 / 4) - paddingBytes;
  if (estimatedBytes > maxBytes) {
    throw upstreamProtocolError(`image_generation_call.result: Image exceeds the ${maxBytes}-byte limit.`);
  }
  const bytes = Buffer.from(compact, "base64");
  const canonicalInput = compact.replace(/=+$/, "");
  const canonicalDecoded = bytes.toString("base64").replace(/=+$/, "");
  if (canonicalDecoded !== canonicalInput) {
    throw upstreamProtocolError("image_generation_call.result: Expected valid base64 image data.");
  }
  if (bytes.length === 0 || bytes.length > maxBytes) {
    throw upstreamProtocolError(`image_generation_call.result: Image exceeds the ${maxBytes}-byte limit.`);
  }
  return bytes;
}

function detectFormat(bytes: Buffer): PreparedGeneratedImage["format"] {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "jpeg";
  }
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "webp";
  }
  throw upstreamProtocolError("image_generation_call.result: Unsupported image format; expected PNG, JPEG, or WebP.");
}

export class GeneratedImageStore {
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly preparedByHash = new Map<string, PreparedGeneratedImage>();

  constructor(private readonly options: GeneratedImageStoreOptions) {
    const scope = safeSegment(options.sessionId ?? options.requestId);
    this.root = path.join(getGatewayGeneratedDir(options.context), scope);
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_IMAGE_BYTES;
  }

  prepare(base64: string, itemId: string): PreparedGeneratedImage {
    const bytes = decodeBase64(base64, this.maxBytes);
    const format = detectFormat(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.preparedByHash.get(sha256);
    if (existing) return existing;
    const fileName = `${safeSegment(itemId)}-${sha256.slice(0, 12)}.${format === "jpeg" ? "jpg" : format}`;
    const prepared = { path: path.join(this.root, fileName), bytes, sha256, format };
    this.preparedByHash.set(sha256, prepared);
    return prepared;
  }

  async persist(image: PreparedGeneratedImage): Promise<void> {
    await mkdir(path.dirname(image.path), { recursive: true, mode: 0o700 });
    const existing = await readFile(image.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (existing) {
      if (existing.equals(image.bytes)) return;
      throw new Error(`Generated image path already exists with different content: ${image.path}`);
    }
    const temporaryPath = path.join(path.dirname(image.path), `.${path.basename(image.path)}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, image.bytes, { mode: 0o600 });
      await rename(temporaryPath, image.path);
    } catch (error) {
      const raced = await readFile(image.path).catch(() => undefined);
      if (raced?.equals(image.bytes)) {
        await unlink(temporaryPath).catch(() => undefined);
        return;
      }
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}
