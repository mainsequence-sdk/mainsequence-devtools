const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('MCP and CLI survive deleted cwd with explicit backend; implicit project lookup reports actionable failure', { skip: process.platform === 'win32' }, async t => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ms deleted cwd '));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const script = `
    const assert = require('node:assert/strict');
    const fs = require('node:fs');
    const { createDevTools, createNodeHost, parseArguments } = require(${JSON.stringify(path.resolve('dist'))});
    (async () => {
      let calls = 0;
      const session = {
        status: async backend => ({backend, authenticated:true, username:'fixture', checked:true}),
        request: async (backend, method) => {
          assert.equal(backend,'https://fixture.example'); assert.equal(method,'GET'); calls++;
          return [{uid:'00000000-0000-4000-8000-000000000001',name:'Fixture',is_production:false}];
        }
      };
      const tools = env => createDevTools({host:createNodeHost(),session,env});
      // Ordinary CLI users must retain their project .env selection.
      fs.writeFileSync('.env','MAINSEQUENCE_ENDPOINT=https://fixture.example\\n');
      assert.equal((await tools({}).dispatch({action:'mcp-environments'})).status,'success');
      fs.unlinkSync('.env');
      fs.rmdirSync(process.cwd());
      // Clear Node's cached cwd so the OS lookup sees the removed inode.
      process.chdir('.');
      assert.throws(() => process.cwd(),{code:'ENOENT'});
      assert.equal((await tools({}).dispatch({action:'auth-status',backend:'https://fixture.example',check:true})).status,'success');
      for (const [env,request] of [
        [{},{action:'mcp-environments',backend:'https://fixture.example'}],
        [{MAINSEQUENCE_ENDPOINT:'https://fixture.example'},{action:'mcp-environments'}]
      ]) {
        const result = await tools(env).dispatch(request);
        assert.equal(result.status,'success',JSON.stringify(result)); assert.equal(result.data.length,1);
      }
      const failed = await tools({}).dispatch({action:'mcp-environments'});
      assert.equal(failed.error.code,'CURRENT_DIRECTORY_UNAVAILABLE');
      assert.match(failed.error.message,/reload the plugin host/);
      assert.equal(calls,3,'No fallback backend or network retry on missing cwd');
      assert.equal(parseArguments(['--help']).help,true);
      assert.equal(parseArguments(['auth-status','--backend','https://fixture.example']).request.action,'auth-status');
      assert.equal(parseArguments(['mcp-list','--backend','https://fixture.example']).request.backend,'https://fixture.example');
      assert.equal(parseArguments(['status','--path','/explicit/project']).request.root,'/explicit/project');
      assert.throws(() => parseArguments(['status']),{code:'CURRENT_DIRECTORY_UNAVAILABLE'});
      console.log('deleted-cwd regression passed; fake session only; zero network');
    })().catch(error => { console.error(error); process.exitCode=1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd:temporary, encoding:'utf8', timeout:10000 });
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/deleted-cwd regression passed/);
});
