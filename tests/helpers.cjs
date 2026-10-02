const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createNodeHost } = require('../dist/index.js');

function memoryStore() {
  const records = new Map();
  return { name: 'fixture memory store', records,
    read(service, account) { return records.get(service + '\n' + account) || null; },
    write(service, account, value) { records.set(service + '\n' + account, value); },
    remove(service, account) { return records.delete(service + '\n' + account); }
  };
}
async function fixtureBackend(t) {
  const calls = [];
  let generation = 1, accepted = 'fixture-access-1';
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ path: req.url, method: req.method, authorization: req.headers.authorization, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/auth/cli/token/') return res.end(JSON.stringify({ access: accepted, refresh: 'fixture-refresh-1', username: 'José' }));
    if (req.url === '/auth/jwt-token/token/refresh/') {
      generation++; accepted = `fixture-access-${generation}`;
      return res.end(JSON.stringify({ access: accepted, refresh: `fixture-refresh-${generation}` }));
    }
    if (req.url === '/auth/cli/revoke/') { res.writeHead(204).end(); return; }
    if (req.headers.authorization !== `Bearer ${accepted}`) { res.writeHead(401).end(JSON.stringify({ detail: 'denied' })); return; }
    if (req.url === '/api/v1/users/me/') return res.end(JSON.stringify({ username: 'José', organization: { name: 'Fixture Org' } }));
    if (req.url === '/api/v1/code-repositories/') return res.end(JSON.stringify({ results: [{ uid: 'repo-1', code_repository_name: 'Shared', code_repository_type: 'python', primary_language: 'python', framework: 'none', branches: [] }] }));
    if (req.url === '/api/v1/code-repository-branches/resolve-git-context/') return res.end(JSON.stringify({ canonical_repository_identity: body.repository_identity, repository_branch: body.repository_branch, repository_ref: `refs/heads/${body.repository_branch}`, commit_sha: body.commit_sha, code_repository_branch: { uid: 'branch-1', code_repository_uid: 'repo-1', code_repository_name: 'Shared', repository_branch: body.repository_branch, is_initialized: true } }));
    res.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { backend: `http://127.0.0.1:${server.address().port}`, calls, accept(value) { accepted = value; } };
}
function browserHost(onAuthorize) {
  return { ...createNodeHost(), async openBrowser(url) {
    const authorize = new URL(url);
    if (onAuthorize) await onAuthorize(authorize);
    const redirect = new URL(authorize.searchParams.get('redirect_uri'));
    redirect.searchParams.set('state', authorize.searchParams.get('state'));
    redirect.searchParams.set('code', 'fixture-authorization-code');
    const response = await fetch(redirect); return response.ok;
  } };
}
function git(root, args) { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
async function project(t, type = 'python', cli = true, syncDelayMs = 0) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ms tooling test '));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'project with spaces');
  await fs.mkdir(root);
  git(root, ['init', '-b', 'main']); git(root, ['config', 'user.email', 'fixture@example.test']); git(root, ['config', 'user.name', 'Fixture']);
  git(root, ['remote', 'add', 'origin', 'https://github.com/Example/Shared.git']);
  await fs.writeFile(path.join(root, '.git', 'info', 'exclude'), '.env\n.venv/\nnode_modules/\nfixture-invocation.json\n');
  await fs.writeFile(path.join(root, type === 'python' ? 'pyproject.toml' : 'package.json'), type === 'python' ? '[project]\nname="fixture"\nversion="0.1.0"\n' : JSON.stringify({ name: 'fixture', version: '0.1.0', dependencies: { '@dev-mainsequence/command-center-sdk': '^0.5.11' } }));
  await fs.writeFile(path.join(root, 'change.txt'), 'initial\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'initial']);
  if (cli) {
    const entry = type === 'python' ? path.join(root, '.venv', 'bin', 'mainsequence') : path.join(root, 'node_modules', '@dev-mainsequence', 'command-center-sdk', 'cli', 'command-center-sdk.mjs');
    await fs.mkdir(path.dirname(entry), { recursive: true });
    const source = `#!${process.execPath}
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('code-repository sync --path --dry-run\napplication sdk-status --path\napplication update-sdk --path --dry-run\ncode-repository freeze-env --path\ncode-repository update --path\nskills install --path --dry-run'); process.exit(0); }
const fs = require('node:fs'), cp = require('node:child_process');
fs.writeFileSync('fixture-invocation.json', JSON.stringify({args, endpoint: process.env.MAINSEQUENCE_ENDPOINT}));
if (args[0] === 'application' && args[1] === 'sdk-status') { console.log(JSON.stringify({package:'sdk', installed:'0.5.11', status:'current', updateAvailable:false, updateSupported:true, declared:'git+https://user:fixture-password@example.test/repo?token=fixture-url-token', refresh_token:'fixture-leak'})); process.exit(0); }
if (args[1] === 'sync' && !args.includes('--dry-run')) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${syncDelayMs});
  const message = args[args.indexOf('-m') + 1];
  cp.execFileSync('git', ['add','--','change.txt']); cp.execFileSync('git', ['commit','-m',message]);
  cp.execFileSync('git', ['tag', 'fixture-sync']);
}
console.log('fixture-access-1 fixture-refresh-1 fixture-leak');
if (process.env.FIXTURE_FAIL) process.exit(7);
if (process.env.FIXTURE_SLOW) setTimeout(()=>{}, 10000);
`;
    // CommonJS body in an .mjs wrapper, to emulate the installed Node CLI entry point.
    await fs.writeFile(entry, type === 'python' ? source.replaceAll("--dry-run\n", "--dry-run\\n").replaceAll("--path\n", "--path\\n") : "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n" + source.replace(/^#!.*\n/, '').replaceAll("--dry-run\n", "--dry-run\\n").replaceAll("--path\n", "--path\\n"), { mode: 0o755 });
  }
  return { root, base, git: args => git(root, args) };
}
module.exports = { memoryStore, fixtureBackend, browserHost, project, git };
