import { spawnSync } from "node:child_process";
import { join } from "node:path";

export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. Unknown/permission errors must not tear down a route that an
    // existing Codex instance can still be using.
    return (error as NodeJS.ErrnoException)?.code !== "ESRCH";
  }
}

export function runningCodexProcessIds(): number[] {
  if (process.platform !== "win32") return [];
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT || "C:\\Windows";
  const tasklist = join(systemRoot, "System32", "tasklist.exe");
  const result = spawnSync(tasklist, ["/FI", "IMAGENAME eq Codex.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error("Could not enumerate Codex processes; process absence is unconfirmed");
  }
  return [...new Set(String(result.stdout || "")
    .split(/\r?\n/)
    .map(line => /^"Codex\.exe","(\d+)"/i.exec(line)?.[1])
    .filter((pid): pid is string => Boolean(pid))
    .map(Number)
    .filter(pid => Number.isInteger(pid) && pid > 0 && pid !== process.pid))];
}
