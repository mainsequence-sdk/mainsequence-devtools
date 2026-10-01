// Opt-in integration check for an installed, reviewed plugin. The only model
// endpoint is a loopback HTTP fixture; no real inference service is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

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
      '-c', 'mcp_servers.main_sequence.enabled=false',
      '-c', 'features.enable_mcp_apps=false',
      '-c', 'features.remote_plugin=false',
      '-c', 'features.recommended_plugins=false',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const request = (method, params) => new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
    child.on('error', error => { for (const wait of pending.values()) wait.reject(error); });
    child.on('exit', () => { for (const wait of pending.values()) wait.reject(new Error('Codex exited before responding.')); });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id != null && pending.has(message.id)) {
        const wait = pending.get(message.id); pending.delete(message.id);
        if (message.error) wait.reject(new Error(JSON.stringify(message.error))); else wait.resolve(message.result);
      } else if (message.method) notifications.push(message);
    });
    const initialized = await request('initialize', { clientInfo: { name: 'mainsequence-host-verification', version: '0.2.0' }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
    const pluginId = process.env.MAINSEQUENCE_CODEX_PLUGIN_ID || 'mainsequence-devtools@mainsequence-local';
    const listed = await request('hooks/list', { cwds: [cwd] });
    const hook = listed.data.flatMap(entry => entry.hooks).find(entry => entry.pluginId === pluginId && entry.eventName === 'userPromptSubmit');
    assert.ok(hook, 'The installed plugin must expose a UserPromptSubmit hook.');
    assert.equal(hook.trustStatus, 'trusted', 'Review and trust this exact hook in Codex before testing.');
    assert.equal(hook.enabled, true);
    const skills = await request('skills/list', { cwds: [cwd], forceReload: true });
    const skill = skills.data.flatMap(entry => entry.skills).find(entry => entry.pluginId === pluginId && entry.name === 'mainsequence-devtools:ms');
    assert.ok(skill?.enabled, 'The installed plugin must register its enabled ms skill in the native slash-menu skill registry.');
    assert.equal(skill.interface?.displayName, 'ms', 'Codex desktop uses this name for its slash-menu entry.');
    const started = await request('thread/start', { cwd, ephemeral: true, model: 'offline-fixture-model', modelProvider: 'mainsequence_offline_fixture', approvalPolicy: 'never', sandbox: 'read-only', environments: [] });
    const threadId = started.thread.id;
    const cases = [];
    // Codex desktop replaces the selected /ms entry with a linked skill mention.
    // Exercise that emitted input, including the accompanying explicit skill item.
    const mention = `[$${skill.name}?label=ms](${skill.path})`;
    for (const [prompt, expected, explicitSkill] of [ [`${mention} --help`, 'success', true], [`${mention} --help --json\n`, 'success', true], [`${mention} --help\n`, 'success', true], [`${mention}\n`, 'success', true], [`${mention} invalid-action`, 'failure', true], [`${mention} sync`, 'failure', true], ['/ms --help\n', 'success', false], ['/ms --help\r\n', 'success', false], ['/ms --help --all\n', 'success', false], ['/ms sync --help\n', 'success', false], ['/ms --help\nstatus\n', 'failure', false], ['ordinary fixture prompt', null, false], [':ms --help', null, false] ]) {
      const before = modelRequests;
      const cursor = notifications.length;
      const input = [{ type: 'text', text: prompt, text_elements: [] }];
      if (explicitSkill) input.push({ type: 'skill', name: skill.name, path: skill.path });
      const turn = await request('turn/start', { threadId, input });
      let completed;
      for (let attempt = 0; attempt < 300; attempt++) {
        completed = notifications.slice(cursor).find(message => message.method === 'turn/completed' && message.params.turn.id === turn.turn.id);
        if (completed) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert.ok(completed, 'The fixture turn must finish within 15 seconds.');
      const run = notifications.slice(cursor).find(message => message.method === 'hook/completed' && message.params.turnId === turn.turn.id && message.params.run.sourcePath === hook.sourcePath)?.params.run;
      assert.ok(run, 'The installed hook must run in the actual host.');
      const calls = modelRequests - before;
      if (expected) {
        assert.equal(run.status, 'blocked');
        assert.equal(calls, 0, 'Handled commands must never reach inference.');
        if (prompt.includes('--json')) {
          const result = run.entries.map(entry => { try { return JSON.parse(entry.text); } catch { return null; } }).find(value => value?.schemaVersion === 1);
          assert.equal(result?.status, expected, 'Explicit --json must retain the structured result.');
        } else {
          const text = run.entries.map(entry => entry.text).join('\n');
          if (expected === 'success') {
            assert.match(text, /MainSequence[^\n]*\n\n/);
            assert.match(text, /\/ms sync --message "Describe your changes"/);
            if (prompt.includes('--all')) assert.match(text, /\/ms env-cleanup/);
            else if (prompt.includes('sync --help')) assert.match(text, /--dry-run  Preview the operation/);
            else assert.match(text, /Get started\n\nSign in\n\/ms login/);
          } else assert.match(text, /MainSequence · [^\n]+ · Failed\n\n/);
          assert.doesNotMatch(text, /"schemaVersion"|\\n/, 'Default output must be readable in the host event stream.');
        }
      } else {
        assert.equal(run.status, 'completed');
        assert.ok(calls > 0, 'An ordinary prompt must pass through to the offline fixture endpoint.');
      }
      cases.push({ prompt, hookStatus: run.status, actionStatus: expected, modelRequests: calls });
    }
    console.log(JSON.stringify({ host: initialized.userAgent, pluginId, nativeEntry: { name: skill.name, displayName: skill.interface.displayName, enabled: skill.enabled }, hookTrust: hook.trustStatus, cases, realModelRequests: 0 }, null, 2));
    await request('thread/unsubscribe', { threadId });
  } finally {
    clearTimeout(deadline);
    child?.kill();
    endpoint.closeAllConnections();
    await new Promise(resolve => endpoint.close(resolve));
    await fs.rm(cwd, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
