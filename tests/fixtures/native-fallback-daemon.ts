import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../../src/config";
import { installCodexIntegration } from "../../src/codex-integration";
import { processAlive } from "../../src/process-lifecycle";
import { startServer } from "../../src/server";

const root = process.argv[2]!;
const launcherPid = Number(process.argv[3]);
const consumerPid = Number(process.argv[4]);
const config = { ...defaultConfig("browser-only"), ...JSON.parse(readFileSync(join(root, "config.json"), "utf8")) };
installCodexIntegration(config);
// The lifecycle must preserve an already-installed roster byte-for-byte.
writeFileSync(join(process.env.CODEX_HOME!, "models_cache.json"), '{"fixture_roster":"installed-once"}\n');
startServer(config, {
  launcherPid,
  listCodexProcesses: () => processAlive(consumerPid) ? [consumerPid] : [],
  fetchUpstream: async request => {
    const delay = Number(request.headers.get("x-fixture-delay") || 0);
    if (delay) await Bun.sleep(delay);
    if (request.signal.aborted) throw new Error("Native request was aborted during handoff");
    return Response.json({ output: [], status: "completed", endpoint: new URL(request.url).pathname });
  },
});
