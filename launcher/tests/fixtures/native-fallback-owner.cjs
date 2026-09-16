const fs = require("node:fs");
const path = require("node:path");
const { RuntimeSupervisor } = require("../../electron/runtime-supervisor.cjs");

const [root, bun, consumerPid] = process.argv.slice(2);
const sourceRoot = path.resolve(__dirname, "../../..");
const supervisor = new RuntimeSupervisor({
  app: { getVersion: () => "5.0.7", isPackaged: false },
  logger: { info() {}, warn() {}, error() {} },
  sourceRoot,
  coreHome: root,
  browserDescriptorPath: path.join(root, "runtime", "launcher-browser.json"),
  runtimeInvocationFactory: () => ({
    executable: bun,
    args: [path.join(sourceRoot, "tests", "fixtures", "native-fallback-daemon.ts"), root, String(process.pid), consumerPid],
    cwd: sourceRoot,
  }),
});
process.on("SIGINT", () => process.exit(130));
void (async () => {
  await supervisor.startDaemon(supervisor.readConfig());
  fs.writeFileSync(path.join(root, "ready.json"), JSON.stringify({ pid: supervisor.daemon.pid, ownerPid: process.pid }));
  const timer = setInterval(async () => {
    if (!fs.existsSync(path.join(root, "quit"))) return;
    clearInterval(timer);
    await supervisor.handoffNativeFallback([Number(consumerPid)]);
    process.exit(0);
  }, 20);
})().catch(error => { console.error(error); process.exit(1); });
