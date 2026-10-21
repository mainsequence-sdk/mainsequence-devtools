const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const target = path.join(root, 'opencode');
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(target, { recursive: true });
fs.cpSync(path.join(root, 'manifests/opencode'), target, { recursive: true });
fs.cpSync(path.join(root, 'dist'), path.join(target, 'dist'), { recursive: true });
// The plugin is ESM; the shared Node library keeps its original CommonJS format.
fs.writeFileSync(path.join(target, 'dist/package.json'), JSON.stringify({ type: 'commonjs' }) + '\n');
// OpenCode's terminal loader rewrites ESM imports and does not provide CJS default interop.
// Compile the same presentation sources as ESM for the UI; retain CJS for Node/VS Code.
fs.mkdirSync(path.join(target, 'ui'));
for (const name of ['codexPresentation', 'opencodePresentation']) {
  const source = fs.readFileSync(path.join(root, `src/hosts/${name}.ts`), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
  fs.writeFileSync(path.join(target, `ui/${name}.mjs`), compiled.replace(/from ['"]\.\/codexPresentation['"]/g, "from './codexPresentation.mjs'"));
  const declaration = fs.readFileSync(path.join(root, `dist/hosts/${name}.d.ts`), 'utf8');
  fs.writeFileSync(path.join(target, `ui/${name}.d.mts`), declaration.replace(/['"]\.\.\/shared\/models['"]/g, "'../dist/shared/models.js'"));
}
fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
  name: 'mainsequence-devtools-opencode-artifact', version: pkg.version, private: true,
  mainsequenceArtifact: true, type: 'module', engines: pkg.engines,
  exports: { '.': './index.mjs', './tui': './tui.mjs', './rpc': './rpc.mjs' },
}, null, 2) + '\n');
fs.chmodSync(path.join(target, 'dist/runner.js'), 0o755);
console.log(`Built OpenCode V2 adapter ${pkg.version} inside the single npm package.`);
