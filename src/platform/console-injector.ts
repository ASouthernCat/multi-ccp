import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Injects text as console input keystrokes into the target process's console.
 *
 * This works by spawning a hidden PowerShell process (no console of its own)
 * that AttachConsole's to the target PID, then uses WriteConsoleInput to
 * inject each character as KEY_EVENT_RECORD entries, followed by an Enter key.
 *
 * When the target PID is the ccp launcher process (which shares its console
 * with the child claude process via stdio:"inherit"), injected keystrokes are
 * read by claude as if the user had typed them.
 */

function buildInjectorScript(pid: number, base64Text: string): string {
  return `
Add-Type @"
using System;
using System.Runtime.InteropServices;

public class ConsoleInjector {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AttachConsole(uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool FreeConsole();

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        uint dwShareMode,
        IntPtr lpSecurityAttributes,
        uint dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool WriteConsoleInput(
        IntPtr hConsoleInput,
        INPUT_RECORD[] lpBuffer,
        uint nLength,
        out uint lpNumberOfEventsWritten
    );

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_RECORD {
        [FieldOffset(0)] public ushort EventType;
        [FieldOffset(4)] public KEY_EVENT_RECORD KeyEvent;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct KEY_EVENT_RECORD {
        public bool bKeyDown;
        public ushort wRepeatCount;
        public ushort wVirtualKeyCode;
        public ushort wVirtualScanCode;
        public char UnicodeChar;
        public uint dwControlKeyState;
    }

    public static string SendStringToProcess(uint pid, string text) {
        FreeConsole();
        if (!AttachConsole(pid)) {
            int err = Marshal.GetLastWin32Error();
            return "ERR:AttachConsole failed (error " + err + ")";
        }

        // Use CreateFile("CONIN$") instead of GetStdHandle(-10) because
        // GetStdHandle returns INVALID_HANDLE after AttachConsole when the
        // calling process was spawned with CREATE_NO_WINDOW (windowsHide).
        const uint GENERIC_READ = 0x80000000;
        const uint GENERIC_WRITE = 0x40000000;
        const uint FILE_SHARE_READ = 1;
        const uint FILE_SHARE_WRITE = 2;
        const uint OPEN_EXISTING = 3;
        IntPtr hIn = CreateFile("CONIN$",
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero);
        if (hIn == IntPtr.Zero || hIn == new IntPtr(-1)) {
            int err = Marshal.GetLastWin32Error();
            FreeConsole();
            return "ERR:CreateFile CONIN$ failed (error " + err + ")";
        }

        var records = new INPUT_RECORD[text.Length * 2 + 2];
        int idx = 0;
        foreach (char c in text) {
            records[idx].EventType = 1;
            records[idx].KeyEvent.bKeyDown = true;
            records[idx].KeyEvent.wRepeatCount = 1;
            records[idx].KeyEvent.UnicodeChar = c;
            idx++;

            records[idx].EventType = 1;
            records[idx].KeyEvent.bKeyDown = false;
            records[idx].KeyEvent.wRepeatCount = 1;
            records[idx].KeyEvent.UnicodeChar = c;
            idx++;
        }

        records[idx].EventType = 1;
        records[idx].KeyEvent.bKeyDown = true;
        records[idx].KeyEvent.wRepeatCount = 1;
        records[idx].KeyEvent.wVirtualKeyCode = 0x0D;
        records[idx].KeyEvent.wVirtualScanCode = 0x1C;
        records[idx].KeyEvent.UnicodeChar = (char)13;
        idx++;

        records[idx].EventType = 1;
        records[idx].KeyEvent.bKeyDown = false;
        records[idx].KeyEvent.wRepeatCount = 1;
        records[idx].KeyEvent.wVirtualKeyCode = 0x0D;
        records[idx].KeyEvent.wVirtualScanCode = 0x1C;
        records[idx].KeyEvent.UnicodeChar = (char)13;
        idx++;

        uint written;
        bool ok = WriteConsoleInput(hIn, records, (uint)records.Length, out written);
        CloseHandle(hIn);
        FreeConsole();

        if (!ok) {
            int err = Marshal.GetLastWin32Error();
            return "ERR:WriteConsoleInput failed (error " + err + ", written=" + written + ")";
        }
        return "OK:written=" + written;
    }
}
"@

$$pidTarget = [uint32]${pid}
$$base64Text = "${base64Text}"
$$bytes = [System.Convert]::FromBase64String($$base64Text)
$$text = [System.Text.Encoding]::UTF8.GetString($$bytes)
$$res = [ConsoleInjector]::SendStringToProcess($$pidTarget, $$text)
Write-Output "RESULT:$$res"
`.replace(/\$\$/g, "$");
}

export async function injectActiveConsoleInput(pid: number, text: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  if (!Number.isInteger(pid) || pid <= 0) return false;

  const base64Text = Buffer.from(text, "utf-8").toString("base64");
  const script = buildInjectorScript(pid, base64Text);
  const tmpFile = join(tmpdir(), `ccp_inject_${pid}_${Date.now()}.ps1`);

  try {
    await writeFile(tmpFile, script, "utf-8");
  } catch {
    return false;
  }

  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmpFile],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
    );

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    child.on("exit", () => {
      // Cleanup temp file
      void unlink(tmpFile).catch(() => {});

      const success = stdout.includes("RESULT:OK:");
      if (!success && (stderr || stdout)) {
        try {
          process.stderr.write(
            `\x1b[90m[console-injector] pid=${pid} stdout=${stdout.trim()} stderr=${stderr.trim()}\x1b[0m\n`
          );
        } catch {
          // ignore
        }
      }
      resolve(success);
    });

    child.on("error", () => {
      void unlink(tmpFile).catch(() => {});
      resolve(false);
    });
  });
}
