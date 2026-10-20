const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { OrganizationProjectClient, createDevTools, createNodeHost, readOrganizationProjectWorkspace } = require('../dist');
const uid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const backend = 'https://fixture.example';
const project = { uid: uid(1), organization_environment_uid: uid(2), name: 'Research', description: 'Backend and frontend', code_repository_branch_uids: [uid(4), uid(5)] };
const branches = ['main', 'feature/risk'].map((repository_branch, index) => ({ uid: uid(index + 4), code_repository_uid: uid(3), code_repository_name: 'Pricing', code_repository_type: 'python', organization_environment_uid: uid(2), repository_branch, github_repository_binding_uid: uid(6), is_initialized: true }));
const repository = { uid: uid(3), code_repository_name: 'Pricing', code_repository_type: 'python', primary_language: 'Python', framework: 'None', github_repository_binding_uid: uid(6), branches: branches.map(({uid, repository_branch}) => ({uid, repository_branch})) };
const binding = { uid: uid(6), code_repository_uid: uid(3), code_repository_name: 'Pricing', repo_name: 'pricing', github_full_name: 'fixture/pricing', git_ssh_url: 'git@github.com:fixture/pricing.git', git_repo_url: 'https://github.com/fixture/pricing.git' };
function session(overrides = {}) {
  const calls = [];
  return { calls, status: async () => ({ authenticated: true }), request: async (_backend, method, url) => {
    calls.push({method, url});
    if (overrides[url]) return structuredClone(overrides[url]);
    if (url === `/api/v1/organization-projects/${uid(1)}/`) return structuredClone(project);
    if (url === `/api/v1/organization-projects/${uid(1)}/code-repository-branches/`) return structuredClone(branches);
    if (url === `/api/v1/code-repositories/${uid(3)}/`) return structuredClone(repository);
    const branch = branches.find(branch => url === `/api/v1/code-repository-branches/${branch.uid}/`);
    if (branch) return structuredClone(branch);
    if (url === `/api/v1/github-repository-bindings/${uid(6)}/`) return structuredClone(binding);
    if (url === '/api/v1/users/me/') return { organization: 'Acme' };
    if (url.startsWith('/api/v1/organization-projects/?')) return { results: [project], count: 30 };
    if (url.startsWith('/api/v1/organization-environments/')) return { results: [{uid: uid(2), name: 'Research'}], count: 1 };
    throw new Error(`Unexpected request ${method} ${url}`);
  }};
}
test('project pages keep environment, search and pagination; branch-only access needs no parent repository list', async () => {
  const auth = session(), client = new OrganizationProjectClient(auth, backend);
  assert.equal((await client.environments())[0].uid, uid(2));
  const page = await client.list(uid(2), { search: 'risk & rates', limit: 25, offset: 25 });
  assert.equal(page.count, 30); assert.equal(page.offset, 25);
  const query = new URL(backend + auth.calls.at(-1).url).searchParams;
  assert.equal(query.get('organization_environment_uid'), uid(2)); assert.equal(query.get('search'), 'risk & rates');
  const detail = await client.getProject(uid(2), uid(1)); assert.equal(detail.branches.length, 2);
  assert.ok(auth.calls.every(call => !call.url.startsWith('/api/v1/code-repositories/')));
  await assert.rejects(client.list('', {}), /UUID/);
  await assert.rejects(client.detail(uid(99), uid(1)), /environment/);
});
test('project branches reject cross-environment, duplicate and non-member rows', async () => {
  for (const bad of [{...branches[0], organization_environment_uid: uid(99)}, {...branches[0], uid: uid(99)}]) {
    const client = new OrganizationProjectClient(session({[`/api/v1/organization-projects/${uid(1)}/code-repository-branches/`]: [bad]}), backend);
    await assert.rejects(client.getProject(uid(2), uid(1)), /membership|environment/);
  }
  const client = new OrganizationProjectClient(session({[`/api/v1/organization-projects/${uid(1)}/code-repository-branches/`]: [branches[0], branches[0]]}), backend);
  await assert.rejects(client.getProject(uid(2), uid(1)), /membership/);
});
test('resource links preserve exact repository and branch identity and never open credential URLs', async () => {
  const client = new OrganizationProjectClient(session(), backend);
  const input = { action:'organization-project-link', environmentUid:uid(2), projectUid:uid(1), branchUid:uid(5), target:'branch' };
  assert.equal(await client.link(input), 'https://github.com/fixture/pricing/tree/feature%2Frisk');
  const platform = new URL(await client.link({...input,commandCenterUrl:'https://app.example'}));
  assert.equal(platform.searchParams.get('msCodeRepositoryUid'), uid(3)); assert.equal(platform.searchParams.get('msCodeRepositoryBranchUid'),uid(5));
  await assert.rejects(client.link({...input,commandCenterUrl:'javascript:alert(1)'}),/HTTP/);
  await assert.rejects(client.link({...input,commandCenterUrl:'https://user:secret@app.example'}),/credentials/);
  await assert.rejects(client.link({...input,branchUid:uid(99)}),/member/);
});
async function fixture(t, distinctRepositories = false) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-project-workspace-'));
  const home = await fs.realpath(temp);
  t.mock.method(os, 'homedir', () => home);
  t.after(() => fs.rm(temp, { recursive:true, force:true }));
  const seed = path.join(home, 'seed'), baseDir = path.join(home, 'repos'); await fs.mkdir(seed); await fs.mkdir(baseDir);
  const git = (root,args) => cp.execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(seed,['init','-b','main']); git(seed,['config','user.name','Fixture']); git(seed,['config','user.email','fixture@example.test']);
  await fs.writeFile(path.join(seed,'pyproject.toml'),'[project]\nname="fixture"\nversion="1.0.0"\n'); git(seed,['add','.']);git(seed,['commit','-m','initial']);git(seed,['branch','feature/risk']);git(seed,['branch','work']);
  const otherSeed = path.join(home, 'other-seed');
  if (distinctRepositories) { git(home, ['clone', seed, otherSeed]); git(otherSeed, ['config', 'user.name', 'Fixture']); git(otherSeed, ['config', 'user.email', 'fixture@example.test']); await fs.writeFile(path.join(otherSeed, 'backend.txt'), 'backend'); git(otherSeed, ['add', '.']); git(otherSeed, ['commit', '-m', 'backend']); }
  const secondBinding = {...binding, uid:uid(8), code_repository_uid:uid(7), code_repository_name:'OntologyBackend', git_ssh_url:'git@github.com:fixture/backend.git'};
  const projectBranches = [ {...branches[0],code_repository_name:'Ontology'}, {...branches[0],uid:uid(5),code_repository_uid:uid(7),code_repository_name:'OntologyBackend',github_repository_binding_uid:uid(8)} ];
  const projectOverrides = distinctRepositories ? {
    [`/api/v1/organization-projects/${uid(1)}/`]: {...project,name:'Ontology'},
    [`/api/v1/organization-projects/${uid(1)}/code-repository-branches/`]: projectBranches,
    [`/api/v1/code-repositories/${uid(3)}/`]: {...repository,code_repository_name:'Ontology',branches:[projectBranches[0]]},
    [`/api/v1/code-repositories/${uid(7)}/`]: {...repository,uid:uid(7),code_repository_name:'OntologyBackend',github_repository_binding_uid:uid(8),branches:[projectBranches[1]]},
    [`/api/v1/code-repository-branches/${uid(5)}/`]: projectBranches[1],
    [`/api/v1/github-repository-bindings/${uid(8)}/`]: secondBinding,
  } : {};
  const native = createNodeHost(), calls = [];
  const host = {...native,openBrowser:async()=>{assert.fail('Shared setup must not open an app');},runProcess: async spec => {
    calls.push({executable:spec.executable,args:spec.args,cwd:spec.cwd});
    if (spec.executable==='ssh-keygen') {const file=spec.args[spec.args.indexOf('-f')+1];await fs.writeFile(file,'fixture-key');await fs.writeFile(file+'.pub','ssh-ed25519 fixture-public');return {exitCode:0,stdout:'',stderr:''};}
    if (spec.executable==='git' && spec.args[0]==='ls-remote') return {exitCode:0,stdout:'fixture',stderr:''};
    if (spec.executable==='git' && spec.args[0]==='clone') {
      const args=[...spec.args], origin=args[args.length-2];args[args.length-2]=origin===secondBinding.git_ssh_url?otherSeed:seed;
      const result=await native.runProcess({...spec,args});
      if(result.exitCode===0)git(spec.args.at(-1),['remote','set-url','origin',origin]);
      return result;
    }
    if (spec.executable==='git' && spec.args[0]==='fetch') return native.runProcess({...spec,args:spec.args.map(arg=>arg==='origin'?(git(spec.cwd,['remote','get-url','origin'])===secondBinding.git_ssh_url?otherSeed:seed):arg)});
    return native.runProcess(spec);
  }};
  const auth=session(projectOverrides), tooling=createDevTools({host,session:auth,env:{...process.env,MAINSEQUENCE_ACCESS_TOKEN:undefined,MAINSEQUENCE_REFRESH_TOKEN:undefined,MAINSEQUENCE_ENDPOINT:backend},store:null});
  const input={action:'organization-project-setup',backend,environmentUid:uid(2),projectUid:uid(1),baseDir};
  return {home,baseDir,git,host,calls,auth,tooling,input};
}
test('local setup reuses one project workspace with independent attached branches and preserves edits on repetition', async t => {
  const f=await fixture(t);const first=await f.tooling.dispatch(f.input);
  assert.equal(first.status,'success',JSON.stringify(first));const workspace=first.data;
  assert.equal(workspace.repositories.length,2);assert.equal(f.calls.filter(call=>call.args[0]==='clone').length,3);
  for(const repo of workspace.repositories){assert.equal(f.git(repo.path,['branch','--show-current']),repo.branch);assert.equal(f.git(repo.path,['remote','get-url','origin']),binding.git_ssh_url);assert.match(await fs.readFile(path.join(repo.path,'.env'),'utf8'),/MAINSEQUENCE_ENDPOINT=https:\/\/fixture.example/);}
  assert.equal(f.git(workspace.repositories[0].sourcePath,['branch','--show-current']),'main');
  await fs.writeFile(path.join(workspace.root,'CLAUDE.md'),'My instructions');await fs.writeFile(path.join(workspace.repositories[0].path,'notes.txt'),'keep me');
  const again=await f.tooling.dispatch(f.input);assert.equal(again.status,'success',JSON.stringify(again));assert.equal(again.data.root,workspace.root);assert.equal(f.calls.filter(call=>call.args[0]==='clone').length,3);
  assert.equal(await fs.readFile(path.join(workspace.root,'CLAUDE.md'),'utf8'),'My instructions');assert.equal(await fs.readFile(path.join(workspace.repositories[0].path,'notes.txt'),'utf8'),'keep me');
  const renamedSession = session({
    [`/api/v1/organization-projects/${uid(1)}/`]: {...project, name:'Renamed Research'},
    [`/api/v1/code-repositories/${uid(3)}/`]: {...repository, code_repository_name:'Renamed Pricing'},
  });
  const renamedTools=createDevTools({host:f.host,session:renamedSession,env:{...process.env,GIT_DIR:'/missing/redirected/git'},store:null});
  const renamed=await renamedTools.dispatch(f.input);assert.equal(renamed.status,'success',JSON.stringify(renamed));
  assert.equal(path.basename(renamed.data.root),'Renamed Research');assert.equal(path.dirname(renamed.data.root),path.dirname(workspace.root));assert.deepEqual(renamed.data.repositories.map(r=>r.path),workspace.repositories.map(r=>r.path));
  assert.equal(f.calls.filter(call=>call.args[0]==='clone').length,3);
  const target=workspace.repositories[0].path;f.git(target,['switch','-c','work']);
  const blocked=await f.tooling.dispatch(f.input);assert.equal(blocked.status,'failure');assert.match(blocked.summary,/Commit or stash/);assert.equal(f.git(target,['branch','--show-current']),'work');
  await fs.unlink(path.join(target,'notes.txt'));const switched=await f.tooling.dispatch(f.input);assert.equal(switched.status,'success',JSON.stringify(switched));assert.equal(f.git(target,['branch','--show-current']),'main');
});
test('setup rejects redirected project directories and mismatched existing repository origins', async t => {
  const f=await fixture(t);const result=await f.tooling.dispatch(f.input);assert.equal(result.status,'success',JSON.stringify(result));
  const target=result.data.repositories[0].path;f.git(target,['remote','set-url','origin','git@github.com:other/repo.git']);
  assert.match((await f.tooling.dispatch(f.input)).summary,/origin/);f.git(target,['remote','set-url','origin',binding.git_ssh_url]);
  const moved=target+'-old';await fs.rename(target,moved);await fs.symlink(moved,target);
  assert.match((await f.tooling.dispatch(f.input)).summary,/ordinary directories/);
});
test('cancellation reports partial effects and a retry retains completed checkouts', async t => {
  const f=await fixture(t), abort=new AbortController();const host={...f.host,progress:message=>{if(message==='Preparing Pricing on feature/risk.')abort.abort();}};
  const tool=createDevTools({host,session:f.auth,signal:abort.signal,env:{...process.env},store:null});
  const result=await tool.dispatch(f.input);assert.equal(result.status,'cancelled');assert.equal(result.effects.state,'partial-or-uncertain');
  const resumed=await f.tooling.dispatch(f.input);assert.equal(resumed.status,'success',JSON.stringify(resumed));
});

test('Ontology has two distinct reusable repository checkouts and an exact display folder name', async t => {
  const f = await fixture(t, true), first = await f.tooling.dispatch(f.input);
  assert.equal(first.status, 'success', JSON.stringify(first)); const workspace = first.data;
  assert.equal(path.basename(workspace.root), 'Ontology'); assert.equal(workspace.name, 'Ontology');
  assert.deepEqual(workspace.repositories.map(r => r.name), ['Ontology', 'OntologyBackend']);
  assert.equal(new Set(workspace.repositories.map(r => r.repositoryUid)).size, 2);
  assert.equal(new URL(workspace.claudeUrl).searchParams.get('folder'), workspace.root);
  const before = await Promise.all(workspace.repositories.map(async r => ({path:r.path, inode:(await fs.stat(r.path)).ino, gitInode:(await fs.stat(path.join(r.path,'.git'))).ino})));
  for (const repo of workspace.repositories) {
    assert.ok(path.relative(workspace.root,repo.path).startsWith('../'), 'repositories must be explicitly addable siblings, not nested under Claude cwd');
    assert.equal(f.git(repo.path,['branch','--show-current']),'main'); f.git(repo.path,['switch','-c','test-local']);
  }
  const clones = f.calls.filter(c => c.args[0] === 'clone').length; assert.equal(clones,4);
  const again = await f.tooling.dispatch(f.input); assert.equal(again.status,'success',JSON.stringify(again));assert.equal(again.data.root,workspace.root);
  assert.equal(f.calls.filter(c => c.args[0] === 'clone').length,clones);
  for (const [i,repo] of again.data.repositories.entries()) {
    assert.equal(f.git(repo.path,['branch','--show-current']),'main');assert.equal(f.git(repo.path,['rev-parse','HEAD']),f.git(repo.path,['rev-parse','origin/main']));
    assert.equal((await fs.stat(repo.path)).ino,before[i].inode);assert.equal((await fs.stat(path.join(repo.path,'.git'))).ino,before[i].gitInode);
  }
  assert.equal((await readOrganizationProjectWorkspace(workspace.root)).repositories.length,2);
});
test('legacy UID workspace migrates without moving or recloning either repository', async t => {
  const f=await fixture(t,true), first=await f.tooling.dispatch(f.input);assert.equal(first.status,'success',JSON.stringify(first));
  const w=first.data, container=path.dirname(w.root), file=path.join(container,'.mainsequence-project.json');
  const manifest=JSON.parse(await fs.readFile(file,'utf8'));manifest.schemaVersion=1;delete manifest.root;
  await fs.writeFile(file,JSON.stringify(manifest));await fs.writeFile(path.join(container,'CLAUDE.md'),'Keep my legacy instructions');
  await fs.rm(w.root,{recursive:true});
  const target=w.repositories[0].path, inode=(await fs.stat(target)).ino;await fs.writeFile(path.join(target,'notes.txt'),'keep my edit');
  const again=await f.tooling.dispatch(f.input);assert.equal(again.status,'success',JSON.stringify(again));assert.equal(path.basename(again.data.root),'Ontology');
  assert.deepEqual(again.data.repositories.map(r=>r.path),w.repositories.map(r=>r.path));assert.equal((await fs.stat(target)).ino,inode);
  assert.equal(await fs.readFile(path.join(again.data.root,'CLAUDE.md'),'utf8'),'Keep my legacy instructions');assert.equal(await fs.readFile(path.join(target,'notes.txt'),'utf8'),'keep my edit');
  assert.equal(f.calls.filter(c=>c.args[0]==='clone').length,4);
});
test('workspace membership cannot point outside its managed repository container', async t => {
  const f=await fixture(t,true), first=await f.tooling.dispatch(f.input);assert.equal(first.status,'success',JSON.stringify(first));
  const root=first.data.root, manifest=JSON.parse(await fs.readFile(path.join(root,'.mainsequence-project.json'),'utf8'));
  manifest.repositories[0].path=f.home;
  for(const folder of [root,path.dirname(root)])await fs.writeFile(path.join(folder,'.mainsequence-project.json'),JSON.stringify(manifest));
  await assert.rejects(readOrganizationProjectWorkspace(root),/membership/);
});
