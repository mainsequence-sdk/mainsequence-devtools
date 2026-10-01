// Check the public package export from an isolated consumer without npm installation or SDKs.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
async function main() {
  const archive = path.resolve(process.argv[2] || `artifacts/dev-mainsequence-devtools-${require('../package.json').version}.tgz`);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ms npm consumer '));
  try {
    const packageDir = path.join(temporary, 'node_modules', '@dev-mainsequence', 'devtools');
    await fs.mkdir(packageDir, { recursive: true });
    const unpack = spawnSync('tar', ['-xzf', archive, '-C', packageDir, '--strip-components=1'], { encoding: 'utf8' });
    if (unpack.status !== 0) throw new Error('Could not unpack the local npm artifact.');
    const manifest = JSON.parse(await fs.readFile(path.join(packageDir, '.codex-plugin/plugin.json'), 'utf8'));
    const pkg = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
    if (manifest.version !== pkg.version || manifest.hooks !== './hooks/hooks.json') throw new Error('The npm artifact must contain the versioned Codex compatibility manifest.');
    if (manifest.skills !== './skills/' || !await fs.stat(path.join(packageDir, 'skills/ms/SKILL.md')).then(() => true).catch(() => false)) throw new Error('The npm artifact must contain the native ms slash-menu registration.');
    if (await fs.stat(path.join(packageDir, 'plugin.json')).then(() => true).catch(() => false)) throw new Error('A root Agent Plugins manifest suppresses hooks in the tested Codex runtime.');
    await fs.writeFile(path.join(temporary, 'consumer.mjs'), `
import assert from 'node:assert/strict';
import { createDevTools, createNodeHost } from '@dev-mainsequence/devtools';
const tools = createDevTools({ host: createNodeHost(), env: {}, store: null });
const result = await tools.dispatch({ action: 'auth-status', backend: 'https://fixture.example' });
assert.equal(result.status, 'success');
assert.equal(result.data.persistence, 'unavailable');
await assert.rejects(import('@dev-mainsequence/devtools/dist/shared/session.js'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
console.log('Public npm API passed from an isolated ESM consumer, without SDKs or runtime npm dependencies.');
`);
    const result = spawnSync(process.execPath, ['consumer.mjs'], { cwd: temporary, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('Public consumer check failed: ' + result.stderr);
    process.stdout.write(result.stdout);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
