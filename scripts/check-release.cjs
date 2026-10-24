const assert = require('node:assert/strict');
const fs = require('node:fs');
const pkg = require('../package.json');
assert.equal(pkg.private, undefined);
assert.equal(pkg.publishConfig.access, 'public');
assert.equal(pkg.exports['.'].default, './dist/index.js');
assert.equal(pkg.bin['ms-devtools'], './dist/runner.js');
assert.deepEqual(pkg.files, ['dist', 'README.md', 'LICENSE', 'NOTICE']);
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'SDKs are not npm dependencies');
assert.equal(fs.existsSync('dist/index.js'), true);
assert.equal(fs.existsSync('dist/runner.js'), true);
assert.equal(fs.existsSync('dist/shared/mcp.js'), true);
// Host adapters are released from their own repositories (ADR 0003).
for (const removed of ['src/hosts', 'dist/hosts', 'manifests', '.codex-plugin', 'hooks', 'skills', 'assets', 'build-info.json', 'plugin.json', '.agents/plugins/marketplace.json']) {
  assert.equal(fs.existsSync(removed), false, `${removed} belongs to a host repository, not to the shared package`);
}
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`);
console.log(`Release metadata agrees: ${pkg.name}@${pkg.version}; shared library and terminal CLI only.`);
// The pack step that follows writes into artifacts/; npm pack does not create it.
fs.mkdirSync('artifacts', { recursive: true });
