const http = require('node:http');
async function modelFixture(t) {
  const state = { requests: 0, plan: undefined };
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url === '/plan') { state.plan = body.code; return res.end('{}'); }
    state.requests++;
    const code = body.tools?.some(tool => tool.function?.name === 'execute') ? state.plan : undefined;
    if (code) state.plan = undefined;
    const delta = code ? { role: 'assistant', tool_calls: [{ index: 0, id: 'offline-call-' + state.requests, type: 'function',
      function: { name: 'execute', arguments: JSON.stringify({ code }) } }] } : { role: 'assistant', content: 'Offline fixture complete.' };
    const packet = choices => ({ id: 'offline-' + state.requests, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices });
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify(packet([{ index: 0, delta, finish_reason: null }])) + '\n\n');
      res.write('data: ' + JSON.stringify({ ...packet([{ index: 0, delta: {}, finish_reason: code ? 'tool_calls' : 'stop' }]), usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ...packet([]), object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Offline fixture complete.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { state, baseURL: `http://127.0.0.1:${server.address().port}` };
}
module.exports = { modelFixture };
