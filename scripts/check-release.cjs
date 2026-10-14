const assert = require('node:assert/strict');
const fs = require('node:fs');
const pkg = require('../package.json');
const manifest = require('../.codex-plugin/plugin.json');
const build = require('../build-info.json');
const marketplace = JSON.parse(fs.readFileSync('.agents/plugins/marketplace.json', 'utf8'));
assert.equal(pkg.private, undefined);
assert.equal(pkg.publishConfig.access, 'public');
assert.equal(manifest.version, pkg.version);
assert.equal(manifest.hooks, './hooks/hooks.json');
assert.equal(manifest.skills, './skills/');
assert.equal(fs.existsSync('skills/ms/SKILL.md'), true);
assert.equal(fs.existsSync('skills/mainsequence-mcp/SKILL.md'), true);
assert.equal(fs.existsSync('dist/shared/mcp.js'), true);
assert.equal(fs.existsSync('plugin.json'), false, 'A portable root manifest skips hooks in Codex 0.159.2');
assert.equal(build.version, pkg.version);
assert.equal(marketplace.plugins[0].source.package, pkg.name);
// The public catalog may stay on the last published version while a new package
// is prepared. Advance it only after registry publication has been verified.
const catalogVersion = marketplace.plugins[0].source.version;
assert.match(catalogVersion, /^\d+\.\d+\.\d+$/);
const incoming = pkg.version.split('.').map(Number), published = catalogVersion.split('.').map(Number);
assert.ok(!published.some((n, i) => n > incoming[i] && published.slice(0, i).every((m, j) => m === incoming[j])), 'Marketplace cannot be newer than the source package');
assert.equal(Object.keys(pkg.dependencies ?? {}).length, 0, 'SDKs are not npm dependencies');
assert.equal(pkg.exports['.'].default, './dist/index.js');
if (process.env.GITHUB_REF_TYPE === 'tag') assert.equal(process.env.GITHUB_REF_NAME, `v${pkg.version}`);
console.log(`Release metadata agrees: ${pkg.name}@${pkg.version}, plugin ${manifest.name}; public catalog pins ${catalogVersion}.`);
