const { spawnSync } = require('node:child_process');
const path = require('node:path');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
if (process.argv.includes('--packaged')) env.REDACT_TEST_APP_ROOT = path.join(__dirname, '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
const result = spawnSync(require('electron'), [path.join(__dirname, 'electron-preview-smoke.cjs')], { env, stdio: 'inherit', windowsHide: true, timeout: 35000 });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
