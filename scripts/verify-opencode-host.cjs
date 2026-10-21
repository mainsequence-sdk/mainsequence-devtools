// Actual V2 host verification; no real provider, user config, credential store or project mutation.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { project } = require('../tests/helpers.cjs');
const { installOpenCode } = require('../dist/hosts/opencodeInstall.js');
const { fixture: mcpFixture } = require('../tests/mcp-fixture.cjs');
const { modelFixture } = require('../tests/opencode-model-fixture.cjs');

async function main() {
  const hostBinary = process.env.MS_OPENCODE_BINARY;
  const packageRoot = path.resolve(process.env.MS_OPENCODE_PACKAGE || '.');
  const install = process.env.MS_OPENCODE_PACKAGE ? require(path.join(packageRoot, 'dist/hosts/opencodeInstall.js')).installOpenCode : installOpenCode;
  if (!hostBinary) throw new Error('Set MS_OPENCODE_BINARY to an installed OpenCode V2 executable (tested: 2.0.27).');
  const cleanup = [];
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-opencode-host-'));
  let host;
  try {
    const fixture = await project({ after: fn => cleanup.push(fn) }, 'vite_react', true, 700);
    const mcp = await mcpFixture({ after: fn => cleanup.push(fn) });
    const fakeModel = await modelFixture({ after: fn => cleanup.push(fn) });
    const root = fixture.root;
    const initialCommit = fixture.git(['rev-parse', 'HEAD']);
    await install(['--project', root]);
    const guard = path.join(root, '.opencode/plugins/verification');
    await fs.mkdir(guard);
    await fs.writeFile(path.join(guard, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
    await fs.writeFile(path.join(guard, 'index.mjs'), `
import { Plugin, Model } from '@opencode/plugin';
import { Rpc } from '@opencode/plugin/rpc';
const object={type:'object',additionalProperties:true};
const Verification=Rpc.define({id:'mainsequence_verification',methods:{state:{input:object,output:object},plan:{input:object,output:object}},events:{}});
export default Plugin.define({id:'mainsequence.verification',async setup(ctx){
  let sdkCalls=0,modelCalls=0,permissionActions=[];
  const providerID='mainsequence-fixture';
  await ctx.provider.transform(editor=>editor.add({info:{id:providerID,name:'Offline fixture',activation:'enabled',package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:'${fakeModel.baseURL}'}},models:[Model.Info.default(providerID,'fixture')]}));
  await ctx.model.transform(editor=>editor.default.set(providerID,'fixture'));
  await ctx.aisdk.hook('sdk',input=>{sdkCalls++;if(input.model.providerID!==providerID)throw new Error('Real provider access is forbidden during verification.');});
  await ctx.aisdk.hook('language',input=>{modelCalls++;if(input.model.providerID!==providerID)throw new Error('Real model access is forbidden during verification.');});
  await ctx.permission.hook('evaluate',input=>{permissionActions.push({action:input.action,effect:input.effect});});
  await ctx.rpc.register(Verification,{
    state:async()=>({sdkCalls,modelCalls,permissionActions,tools:(await ctx.tool.list()).filter(t=>t.id.startsWith('mainsequence')).map(t=>({id:t.id,input:t.input,options:t.options}))}),
    plan:async(input)=>{await fetch('${fakeModel.baseURL}/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});return {ready:true};}
  });
}});
`);
    const env = { ...process.env, HOME: temporary, XDG_DATA_HOME: path.join(temporary, 'data'),
      XDG_CONFIG_HOME: path.join(temporary, 'config'), XDG_STATE_HOME: path.join(temporary, 'state'), XDG_CACHE_HOME: path.join(temporary, 'cache') };
    for (const key of Object.keys(env)) if (/TOKEN|API_KEY|SECRET|PASSWORD/.test(key)) delete env[key];
    env.MAINSEQUENCE_ENDPOINT = mcp.backend;
    env.MAINSEQUENCE_ACCESS_TOKEN = 'private-platform-token';
    host = spawn(hostBinary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let privateOutput = '';
    host.stdout.on('data', bytes => { privateOutput += bytes; });
    host.stderr.on('data', bytes => { privateOutput += bytes; });
    const deadline = Date.now() + 30000;
    while (!/server password (\S+)/.test(privateOutput)) {
      if (host.exitCode !== null || Date.now() > deadline) throw new Error('The isolated OpenCode server did not start.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const baseUrl = privateOutput.match(/server listening on (http:\/\/\S+)/)[1];
    const password = privateOutput.match(/server password (\S+)/)[1];
    const { OpenCode } = await import('@opencode/client');
    const client = OpenCode.make({ baseUrl, headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') } });
    const location = { directory: root };
    let plugins;
    for (let attempt = 0; attempt < 40; attempt++) {
      plugins = await client.plugin.list({ location });
      if (plugins.data.some(plugin => plugin.id === 'mainsequence.devtools')) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!plugins.data.some(plugin => plugin.id === 'mainsequence.devtools')) {
      console.error(JSON.stringify(plugins.data.map(plugin => ({ id: plugin.id, state: plugin.state }))));
      console.error(privateOutput.split('\n').filter(line => /plugin|mainsequence|error|failed/i.test(line) && !/password/i.test(line)).join('\n').slice(-6000));
      for (const file of await fs.readdir(path.join(temporary, 'data/opencode/log')).catch(() => [])) {
        const log = await fs.readFile(path.join(temporary, 'data/opencode/log', file), 'utf8');
        console.error(log.split('\n').filter(line => /mainsequence|failed to load plugin|LoadError/.test(line)).join('\n').slice(-7000));
      }
      throw new Error('installed server plugin was not discovered');
    }
    // The client-side contract can come from this checkout; the installed plugin comes from packageRoot.
    const { MainSequence } = await import(pathToFileURL(path.resolve('opencode/rpc.mjs')));
    assert.equal(plugins.data.find(plugin => plugin.id === 'mainsequence.devtools').features.tui, true, 'terminal entry point must be discovered with the server plugin');
    const rpc = client.rpc(MainSequence);
    const calls = { location };
    async function inspect() {
      const verification = await client.rpc.call({ rpcID: 'mainsequence_verification', method: 'state', location, input: {} });
      return verification.output ?? verification.result ?? verification;
    }
    const commands = await client.command.list({ location });
    assert(commands.data.some(command => command.name === 'ms'), 'native executable /ms was not registered');
    const session = await client.session.create({ location, title: 'MainSequence adapter verification' });
    for (const command of ['--help', 'not-a-command', 'sync --message rejected', 'sync']) {
      await client.session.command({ sessionID: session.id, name: 'ms', text: command });
      const state = await rpc.state({}, calls);
      const operation = state.operations.at(-1);
      assert.notEqual(operation.status, 'running');
      assert.equal(operation.status, command === '--help' || command === 'sync' ? 'success' : 'failure', operation.display);
      assert.equal(typeof operation.display, 'string');
      assert(!operation.display.startsWith('{'), 'UI result must not be a JSON envelope');
    }
    assert.equal(fixture.git(['rev-parse', 'HEAD']), initialCommit);
    assert.equal(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'), 'refreshed by the fixture sync\n');
    const invocation = JSON.parse(await fs.readFile(path.join(root, 'fixture-invocation.json'), 'utf8'));
    assert.deepEqual(invocation.args, ['code-repository', 'sync', '--path', '.']);
    const cancelled = await rpc.start({ command: 'sync' }, calls);
    for (let attempt = 0; attempt < 50; attempt++) {
      const view = await rpc.get({ id: cancelled.id }, calls);
      if (view.progress.startsWith('Running sync')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(await rpc.cancel({ id: cancelled.id }, calls), true);
    let result;
    do { await new Promise(resolve => setTimeout(resolve, 50)); result = await rpc.get({ id: cancelled.id }, calls); } while (result.status === 'running');
    assert.equal(result.status, 'cancelled');
    assert(result.result.effects, 'cancellation must report uncertain mutation effects');
    const evidence = await inspect();
    assert.equal(evidence.sdkCalls, 0);
    assert.equal(evidence.modelCalls, 0);
    assert(evidence.tools.some(tool => tool.id === 'mainsequence_discover'));
    assert(evidence.tools.every(tool => tool.options.permission));
    assert.equal((await client.session.context({ sessionID: session.id })).length, 0, 'native commands must not enqueue agent prompts');
    if (process.env.MS_OPENCODE_TUI === '1') {
      const check = spawn('python3', [path.resolve('scripts/verify-opencode-tui.py'), hostBinary, root], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let evidence = '';
      check.stdout.on('data', bytes => { evidence += bytes; });
      check.stderr.on('data', bytes => { evidence += bytes; });
      assert.equal(await new Promise(resolve => check.once('close', resolve)), 0, evidence);
      process.stdout.write(evidence);
    }
    async function direct(command) {
      const operation = await rpc.start({command},calls);
      let view;
      do { await new Promise(resolve=>setTimeout(resolve,25)); view=await rpc.get({id:operation.id},calls); } while(view.status==='running');
      assert.equal(view.status,'success',view.display);
      return view.result;
    }
    const discovered = await direct('mcp-discover');
    assert.equal(discovered.data.results.length,2);
    await direct('mcp-add --uid '+mcp.uid);
    const selected = (await inspect()).tools.find(tool=>tool.id.includes('_set_value_'));
    assert(selected,'connecting in this session must register the live project tools');
    assert.equal(selected.input.properties.value.type,'number');
    assert.equal(selected.options.permission,selected.id);
    const argsFile=path.join(root,'fixture-mcp-arguments.json');
    await fs.writeFile(argsFile,JSON.stringify({value:42}));
    const mcpCommand='mcp-call --uid '+mcp.uid+' --tool set_value --arguments-file '+JSON.stringify(argsFile);
    const called=await direct(mcpCommand);
    assert.equal(called.data.structuredContent.value,42);
    assert(!JSON.stringify(called).includes('private-release-credential'));
    mcp.state.token='private-renewed-release-credential';
    await fs.writeFile(argsFile,JSON.stringify({value:43}));
    assert.equal((await direct(mcpCommand)).data.structuredContent.value,43);
    assert(mcp.calls.filter(call=>call.server==='project').every(call=>call.authorization!=='Bearer private-platform-token'));
    // Exercise the real agent permission path with a counted loopback fake model.
    // Developer commands above still have 0 model calls; these conversation checks use no external provider.
    assert.equal(fakeModel.state.requests, 0, 'developer commands and terminal UI must make zero model requests');
    const functionName = selected.id.slice(selected.options.namespace.length + 1);
    const code = `return await tools.${selected.options.namespace}.${functionName}({value:44});`;
    for (const decision of ['deny', 'allow', 'ask', 'ask-reject']) {
      const effect = decision === 'ask-reject' ? 'ask' : decision;
      const conversation = await client.session.create({ location, model: { providerID: 'mainsequence-fixture', id: 'fixture' },
        permissions: [{ action: '*', resource: '*', effect: 'allow' }, { action: selected.id, resource: '*', effect }] });
      const before = mcp.state.invoked;
      await client.rpc.call({ rpcID: 'mainsequence_verification', method: 'plan', location, input: { code } });
      await client.session.prompt({ sessionID: conversation.id, text: 'Run the selected fixture MCP tool.' });
      if (effect === 'ask') {
        let pending;
        for (let attempt = 0; attempt < 100; attempt++) {
          pending = (await client.permission.list({ sessionID: conversation.id })).find(request => request.action === selected.id);
          if (pending) break;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (!pending) {
          console.error(JSON.stringify(await client.permission.list({ sessionID: conversation.id })));
          console.error(JSON.stringify(await client.session.context({ sessionID: conversation.id })).replace(/private-[a-z-]+/g, '[fixture credential]').slice(-5000));
          console.error(JSON.stringify((await inspect()).permissionActions));
        }
        assert(pending, 'an ask rule must request native host permission before executing the project tool');
        assert.equal(mcp.state.invoked, before, 'the project must not execute before host approval');
        await client.permission.reply({ sessionID: conversation.id, requestID: pending.id, decision: decision === 'ask-reject' ? 'reject' : 'once' });
      }
      await client.session.wait({ sessionID: conversation.id }, { signal: AbortSignal.timeout(10000) });
      const expected = decision === 'deny' || decision === 'ask-reject' ? 0 : 1;
      if (mcp.state.invoked - before !== expected) {
        const context = await client.session.context({ sessionID: conversation.id });
        console.error(JSON.stringify(context).replace(/private-[a-z-]+/g, '[fixture credential]').slice(-7000));
        console.error(JSON.stringify((await inspect()).permissionActions));
      }
      assert.equal(mcp.state.invoked - before, expected, `OpenCode ${decision} permission must govern the nested project MCP tool`);
    }
    await direct('mcp-remove --uid '+mcp.uid);
    assert(!(await inspect()).tools.some(tool => tool.id === selected.id));
    console.log('OpenCode V2 native host passed: executable /ms help/errors/sync/cancellation with 0 provider/model calls and 0 agent messages; shared MCP discovery, live schemas, private credential rotation, disconnect; actual host deny/allow/ask/reject enforcement using a loopback fake model.');
  } finally {
    if (host && host.exitCode === null) { host.kill('SIGTERM'); await Promise.race([new Promise(resolve => host.once('close', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); if (host.exitCode === null) host.kill('SIGKILL'); }
    for (const fn of cleanup.reverse()) await fn();
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
