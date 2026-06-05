import { spawn } from "node:child_process";
import { CcpError } from "../core/errors.js";

export function getDefaultEditor(): string {
  if (process.env.EDITOR) {
    return process.env.EDITOR;
  }
  if (process.platform === "win32") {
    return "notepad";
  }
  return "vi";
}

export async function openEditor(filePath: string, editor = getDefaultEditor()): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(editor, [filePath], { stdio: "inherit", shell: process.platform === "win32" });
    child.on("error", (error) => reject(new CcpError(`Failed to open editor '${editor}': ${error.message}`)));
    child.on("exit", (code) => resolve(code ?? 0));
  });
}
