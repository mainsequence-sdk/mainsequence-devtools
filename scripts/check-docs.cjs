// Documentation stays current: links resolve, named npm scripts exist, and the README and
// guides carry no version numbers (versions live in package.json and GitHub releases).
// The two SDK minimums that `sync` requires are the only versions the README may name.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const guides = fs.readdirSync(path.join(root, 'docs')).filter(name => name.endsWith('.md')).map(name => `docs/${name}`);
const adrs = fs.readdirSync(path.join(root, 'docs/adr')).filter(name => name.endsWith('.md')).map(name => `docs/adr/${name}`);
const allowedVersions = new Set(['9.0.5', '0.5.13']);
for (const filename of ['README.md', ...guides, ...adrs]) {
  const source = fs.readFileSync(path.join(root, filename), 'utf8');
  for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^[a-z]+:/.test(target)) continue;
    assert.ok(fs.existsSync(path.resolve(root, path.dirname(filename), target)), `${filename}: missing link ${target}`);
  }
  for (const [, script] of source.matchAll(/npm run ([a-z:-]+)/g)) assert.ok(pkg.scripts[script], `${filename}: unknown npm script ${script}`);
}
for (const filename of ['README.md', ...guides]) {
  const source = fs.readFileSync(path.join(root, filename), 'utf8');
  const versions = [...source.matchAll(/\b\d+\.\d+\.\d+\b/g)].map(match => match[0]).filter(version => !allowedVersions.has(version));
  assert.deepEqual(versions, [], `${filename} must not name versions; found ${versions.join(', ')}`);
}
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
for (const host of ['ms-vscode-extension', 'mainsequence-codex-plugin', 'mainsequence-claude-desktop']) assert.ok(readme.includes(`https://github.com/mainsequence-sdk/${host}`), `README must link ${host}`);
for (const guide of guides) assert.ok(readme.includes(`(${guide})`), `README must link ${guide}`);
console.log('Documentation links, npm scripts and version-free guides verified.');
