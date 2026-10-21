const assert = require('node:assert/strict');
const fs = require('node:fs');
const pkg = require('../package.json');
const marketplace = JSON.parse(fs.readFileSync('.agents/plugins/marketplace.json', 'utf8'));
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
for (const removed of ['src/hosts', 'dist/hosts', 'manifests', '.codex-plugin', 'hooks', 'skills', 'assets', 'build-info.json', 'plugin.json']) {
  assert.equal(fs.existsSync(removed), false, `${removed} belongs to a host repository, not to the shared package`);
}
// The Codex marketplace stays in this repository because people added it by this
// repository's URL. Its entries point at published npm packages. The plugin itself is
// released from mainsequence-sdk/mainsequence-codex-plugin; devtools 0.2.8 is the last
// package that carried it, so an entry may still pin that version until the new package
// is published, but never a newer devtools version.
const compare = (a, b) => a.map((n, i) => n - b[i]).find(d => d !== 0) ?? 0;
assert.equal(marketplace.name, 'mainsequence');
assert.ok(Array.isArray(marketplace.plugins) && marketplace.plugins.length > 0, 'The marketplace must list a plugin');
for (const plugin of marketplace.plugins) {
  assert.equal(plugin.source.source, 'npm');
  assert.match(plugin.source.version, /^\d+\.\d+\.\d+$/);
  const version = plugin.source.version.split('.').map(Number);
  if (plugin.source.package === pkg.name) {
    assert.equal(plugin.name, 'mainsequence-devtools');
    assert.ok(compare(version, [0, 2, 8]) <= 0, 'devtools 0.2.8 is the last package that contains the Codex plugin');
  } else {
    assert.equal(plugin.source.package, '@dev-mainsequence/codex-plugin');
    assert.equal(plugin.name, 'mainsequence');
  }
}
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`);
console.log(`Release metadata agrees: ${pkg.name}@${pkg.version}; the Codex marketplace lists ${marketplace.plugins.map(plugin => `${plugin.name} from ${plugin.source.package}@${plugin.source.version}`).join(', ')}.`);
// The pack step that follows writes into artifacts/; npm pack does not create it.
fs.mkdirSync('artifacts', { recursive: true });
