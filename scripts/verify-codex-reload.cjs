// Isolated regression for an external plugin enable in an already-running chat.
// Uses a temporary Codex home, this repository's plugin artifact, and a counted
// loopback endpoint that rejects model requests. No live credentials are loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

async function main() {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'mainsequence-codex-host-'));
  let modelRequests = 0;
  const endpoint = http.createServer((request, response) => {
    if (request.url?.includes('/responses')) modelRequests++;
    request.resume(); // Never record request headers, credentials or model context.
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'Offline integration fixture: inference disabled.' } }));
  });
  let child;
  const pending = new Map();
  const notifications = [];
  let sequence = 0;
  const deadline = setTimeout(() => child?.kill(), 45_000);
  try {
    const isolatedHome = path.join(cwd, 'codex-home');
    await fs.mkdir(isolatedHome, { recursive: true });
    const fixtureEnv = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'TERM'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    fixtureEnv.CODEX_HOME = isolatedHome;
    const marketplace = path.resolve(__dirname, '../artifacts/local-marketplace');
    for (const args of [ ['plugin','marketplace','add',marketplace], ['plugin','add','mainsequence-devtools@mainsequence-local','--json'] ]) {
      const install = spawnSync('codex', args, { env: fixtureEnv, encoding: 'utf8' });
      assert.equal(install.status, 0, install.stderr);
    }
    const configPath = path.join(isolatedHome, 'config.toml');
    let fixtureConfig = await fs.readFile(configPath, 'utf8');
    fixtureConfig = fixtureConfig.replace('enabled = true', 'enabled = false');
    // Carry forward only the exact already-reviewed MainSequence hook hash.
    fixtureConfig += '\n[hooks.state."mainsequence-devtools@mainsequence-local:hooks/hooks.json:user_prompt_submit:0:0"]\ntrusted_hash = "sha256:8935862c1c3aea477344a8c2f547aa33096cdd19992c04456c10734891d0124a"\n';
    await fs.writeFile(configPath, fixtureConfig);
    await new Promise((resolve, reject) => { endpoint.once('error', reject); endpoint.listen(0, '127.0.0.1', resolve); });
    const baseUrl = `http://127.0.0.1:${endpoint.address().port}/v1`;
    child = spawn(process.env.MAINSEQUENCE_CODEX_BINARY || 'codex', [
      'app-server', '-c', 'analytics.enabled=false',
      '-c', 'model_provider="mainsequence_offline_fixture"',
      '-c', 'model_providers.mainsequence_offline_fixture.name="Offline integration fixture"',
      '-c', `model_providers.mainsequence_offline_fixture.base_url="${baseUrl}"`,
      '-c', 'model_providers.mainsequence_offline_fixture.wire_api="responses"',
      '-c', 'model_providers.mainsequence_offline_fixture.requires_openai_auth=false',
      '-c', 'model_providers.mainsequence_offline_fixture.request_max_retries=0',
      '-c', 'model_providers.mainsequence_offline_fixture.stream_max_retries=0',
      '-c', 'features.enable_mcp_apps=false',
      '-c', 'features.remote_plugin=false',
      '-c', 'features.recommended_plugins=false',
    ], { stdio: ['pipe', 'pipe', 'pipe'], env: fixtureEnv });
    let diagnostic=''; child.stderr.on('data',d=>{ diagnostic=(diagnostic+d.toString()).slice(-2000); });
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    child.on('error', error => { for (const wait of pending.values()) wait.reject(error); });
    child.on('exit', () => { for (const wait of pending.values()) wait.reject(new Error('Codex exited before responding: '+diagnostic)); });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && pending.has(message.id)) {
        const wait = pending.get(message.id); pending.delete(message.id);
        if (message.error) wait.reject(new Error(JSON.stringify(message.error))); else wait.resolve(message.result);
      } else if (message.method) notifications.push(message);
    });
    const initialized = await request('initialize', { clientInfo: { name: 'mainsequence-host-verification', version: require('../package.json').version }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const pluginId = process.env.MAINSEQUENCE_CODEX_PLUGIN_ID || 'mainsequence-devtools@mainsequence-local';
    const startThread = () => request('thread/start', { cwd, ephemeral: true, model: 'offline-fixture-model', modelProvider: 'mainsequence_offline_fixture', approvalPolicy: 'never', sandbox: 'read-only', environments: [] });
    const old = await startThread();
    await fs.writeFile(configPath, fixtureConfig.replace('enabled = false', 'enabled = true'));
    const observations = [];
    const probe = async (label, threadId) => {
      const cursor = notifications.length, before = modelRequests;
      const turn = await request('turn/start', { threadId, input: [{ type:'text', text:'/ms --help', text_elements:[] }] });
      let completed = false;
      for(let attempt=0;attempt<300;attempt++) {
        completed = notifications.slice(cursor).some(m=>m.method==='turn/completed' && m.params.turn.id===turn.turn.id);
        if(completed) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      assert.ok(completed, 'The offline fixture turn must finish within 15 seconds.');
      const runs=notifications.slice(cursor).filter(m=>m.method==='hook/completed' && m.params.turnId===turn.turn.id).map(m=>m.params.run.status);
      observations.push({label,modelRequests:modelRequests-before,hookRuns:runs});
    };
    await probe('existing thread after external enable',old.thread.id);
    const fresh = await startThread();
    await probe('new thread in same backend after external enable',fresh.thread.id);
    await request('config/batchWrite',{edits:[{keyPath:'plugins.mainsequence-devtools@mainsequence-local.enabled',value:true,mergeStrategy:'upsert'}],reloadUserConfig:true});
    await probe('existing thread after supported config hot reload',old.thread.id);
    const listed=await request('hooks/list',{cwds:[cwd]});
    assert.deepEqual(observations.map(x=>({modelRequests:x.modelRequests,hookRuns:x.hookRuns})), [
      {modelRequests:1,hookRuns:[]},
      {modelRequests:0,hookRuns:['blocked']},
      {modelRequests:0,hookRuns:['blocked']},
    ]);
    console.log(JSON.stringify({host:initialized.userAgent,observations,listedHooks:listed.data.flatMap(x=>x.hooks).filter(x=>x.pluginId===pluginId).map(x=>({enabled:x.enabled,trust:x.trustStatus})),realModelRequests:0},null,2));
  } finally {
    clearTimeout(deadline);
    child?.kill();
    endpoint.closeAllConnections();
    await new Promise(resolve => endpoint.close(resolve));
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
