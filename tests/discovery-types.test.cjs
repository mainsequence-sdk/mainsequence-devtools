const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

test('public dispatcher infers read payloads and preserves legacy ActionResult compatibility', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-discovery-types-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const entry = path.resolve('dist/index').replaceAll('\\', '/');
  const source = `import { createDevTools, createNodeHost, ActionResult, McpConnection, McpTool } from ${JSON.stringify(entry)};
const api = createDevTools({ host: createNodeHost() });
async function read() {
  const state = await api.dispatch({action:'auth-status'});
  const username: string | undefined = state.data?.username;
  const saved = await api.dispatch({action:'mcp-list', readOnly:true, expectedAccount:'alice'});
  const connections: McpConnection[] | undefined = saved.data;
  const catalog = await api.dispatch({action:'mcp-tools', releaseUid:'id', expectedAccount:'alice'});
  const tools: McpTool[] | undefined = catalog.data?.tools;
  const environments = await api.dispatch({action:'mcp-environments'});
  const production: boolean | undefined = environments.data?.[0].isProduction;
  const agents = await api.dispatch({action:'agents-list',environmentUid:'id'});
  const name: string | undefined = agents.data?.results[0].name;
  const legacy: ActionResult = saved;
  // @ts-expect-error The result of mcp-list is connections, not a tool catalog.
  saved.data?.tools;
  // @ts-expect-error Read-only listing must use a boolean.
  api.dispatch({action:'mcp-list',readOnly:'yes'});
  return {username,connections,tools,production,name,legacy};
}
void read;`;
  const file = path.join(dir, 'consumer.ts'); await fs.writeFile(file, source);
  const result = spawnSync(process.execPath, [require.resolve('typescript/lib/tsc.js'), '--strict', '--noEmit', '--skipLibCheck', '--target', 'ES2022', '--module', 'commonjs', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
