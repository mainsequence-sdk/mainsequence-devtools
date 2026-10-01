const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { project } = require('./helpers.cjs');

test('setup reuses existing backend contracts, registers a synthetic SSH key, clones canonical layout, and writes endpoint only', async t => {
  const p = await project(t, 'python', false);
  const home = path.join(p.base, 'isolated home'), base = path.join(p.base, 'repositories');
  await fs.mkdir(home);
  const library = path.resolve('dist/index.js'), processModule = path.resolve('dist/shared/process.js');
  const program = `
const fs = require('node:fs/promises'), path = require('node:path');
const {createDevTools, createNodeHost} = require(${JSON.stringify(library)});
const {runProcess} = require(${JSON.stringify(processModule)});
const calls = [];
let checks = 0;
const host = { ...createNodeHost(), async runProcess(spec) {
  if (spec.executable === 'git' && spec.args[0] === 'ls-remote') return {exitCode: ++checks === 1 ? 1 : 0, stdout:'', stderr:''};
  if (spec.executable === 'git' && spec.args[0] === 'clone') {
    const result = await runProcess({...spec, args:['clone','--branch','main','--',${JSON.stringify(p.root)},spec.args.at(-1)]});
    if (result.exitCode === 0) await runProcess({executable:'git',args:['remote','set-url','origin','git@github.com:Example/Shared.git'],cwd:spec.args.at(-1)});
    return result;
  }
  return runProcess(spec);
}};
const fetchImpl = async (url, options) => {
  const endpoint = new URL(url).pathname;
  calls.push({endpoint, method:options.method});
  let result;
  if(endpoint === '/api/v1/code-repositories/repo-1/') result = {uid:'repo-1',code_repository_name:'Shared',code_repository_type:'python',primary_language:'python',framework:'none',github_repository_binding_uid:'binding-1',branches:[{uid:'branch-1',repository_branch:'main'}]};
  else if(endpoint === '/api/v1/code-repository-branches/branch-1/') result = {uid:'branch-1',code_repository_uid:'repo-1',code_repository_name:'Shared',repository_branch:'main',github_repository_binding_uid:'binding-1',is_initialized:true};
  else if(endpoint === '/api/v1/github-repository-bindings/binding-1/') result = {uid:'binding-1',code_repository_uid:'repo-1',code_repository_name:'Shared',repo_name:'Shared',github_full_name:'Example/Shared',git_ssh_url:'git@github.com:Example/Shared.git'};
  else if(endpoint === '/api/v1/users/me/') result = {username:'fixture',organization:{name:'Fixture Org'}};
  else if(endpoint === '/api/v1/code-repositories/repo-1/add-deploy-key/') {
    const key = JSON.parse(options.body); if(!key.public_key.startsWith('ssh-ed25519 ')) throw Error('invalid fixture key'); result={};
  } else throw Error('Unexpected backend API');
  return new Response(JSON.stringify(result), {status:200,headers:{'content-type':'application/json'}});
};
const tools = createDevTools({host,store:null,env:{...process.env,MAINSEQUENCE_ENDPOINT:'https://fixture.example',MAINSEQUENCE_ACCESS_TOKEN:'fixture-process-access'},fetch:fetchImpl});
(async()=>{
  const request = {action:'setup',backend:'https://fixture.example',repositoryUid:'repo-1',branch:'main',baseDir:${JSON.stringify(base)}};
  const parent = path.join(request.baseDir, 'fixture-org', 'projects');
  await fs.mkdir(parent, {recursive:true});
  const lock = path.join(parent, '.shared-repo-1.mainsequence-devtools.lock');
  await fs.writeFile(lock, 'fixture held lock');
  const busy = await tools.dispatch(request);
  await fs.unlink(lock);
  const result=await tools.dispatch(request);
  const second=await tools.dispatch(request);
  console.log(JSON.stringify({result,second,busy,calls,checks}));
})();
`;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  for (const key of Object.keys(env)) if (/MAIN.?SEQUENCE|MAIN_SEQUENCE/.test(key)) delete env[key];
  const execution = spawnSync(process.execPath, ['-e', program], { env, cwd: p.base, encoding: 'utf8', timeout: 10_000 });
  assert.equal(execution.status, 0, execution.stderr);
  const result = JSON.parse(execution.stdout);
  assert.equal(result.result.status, 'success', execution.stdout);
  assert.equal(result.result.data.root, path.join(base, 'fixture-org', 'projects', 'shared-repo-1'));
  assert.equal(result.second.error.code, 'INVALID_REQUEST');
  assert.equal(result.busy.error.code, 'PROJECT_BUSY');
  assert.equal(result.calls.filter(call => call.endpoint.endsWith('/add-deploy-key/')).length, 1);
  assert.equal(result.checks, 2);
  assert.equal(await fs.readFile(path.join(result.result.data.root, '.env'), 'utf8'), 'MAINSEQUENCE_ENDPOINT=https://fixture.example\n');
  assert.doesNotMatch(execution.stdout, /fixture-process-access|PRIVATE KEY/);
  assert.equal((await fs.readdir(path.join(home, '.ssh'))).length, 2);
});
