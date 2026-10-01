const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version;
const result = spawnSync('tar', ['-czf', path.join(root, 'artifacts', `mainsequence-devtools-codex-${version}.tgz`), '-C', path.join(root, 'artifacts', 'codex'), 'mainsequence-devtools'], { stdio: 'inherit' });
if (result.status !== 0) process.exit(result.status || 1);
console.log(`Packed artifacts/mainsequence-devtools-codex-${version}.tgz`);
