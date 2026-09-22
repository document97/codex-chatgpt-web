const { validateRuntimeBundle } = require('../launcher/electron/runtime-install.cjs');
const [runtimeRoot, bundleId] = process.argv.slice(2);
if (!runtimeRoot || !/^[a-f0-9]{64}$/.test(bundleId ?? '')) {
  throw new Error('Expected a runtime directory and its SHA-256 bundle ID');
}
validateRuntimeBundle(runtimeRoot, {
  version: '5.0.7', platform: 'win32', arch: 'x64', bundleId,
});
