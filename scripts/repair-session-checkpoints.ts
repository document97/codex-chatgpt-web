import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { portableSessionCheckpoints, repairSessionCheckpoints } from "../src/portable-session-checkpoints";
import { runningCodexProcessIds } from "../src/process-lifecycle";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const files = args.filter(arg => arg !== "--apply");
if (!files.length) throw new Error("Usage: bun scripts/repair-session-checkpoints.ts [--apply] <session.jsonl> ... (default: preview)");
function assertOffline(): void {
  if (process.platform !== "win32") throw new Error("Offline process detection is currently supported on Windows only");
  if (runningCodexProcessIds().length) throw new Error("Exit Codex completely before applying session repair; preview remains available");
}
for (const name of files) {
  const file = resolve(name);
  if (!file.endsWith(".jsonl")) throw new Error("Expected an explicit session .jsonl file");
  const result = apply ? repairSessionCheckpoints(file, assertOffline)
    : { converted: portableSessionCheckpoints(readFileSync(file, "utf8")).converted };
  console.log(JSON.stringify({ file, applied: apply, ...result }));
}
