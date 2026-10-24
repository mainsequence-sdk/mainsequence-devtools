const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createSharedTransport } = require('../dist');
const token = seconds => 'eyJ.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+seconds})).toString('base64url')+'.fixture';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ms-http-test-'));
  const counts = new Map(), sockets = new Set();
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null, key = [req.method, req.url, req.headers.authorization || '', body?.method || ''].join(' ');
    counts.set(key, (counts.get(key) || 0) + 1);
    if (req.url === '/fail-after-send') { req.socket.destroy(); return; }
    await new Promise(resolve => setTimeout(resolve, req.url.includes('slow') ? 300 : 35));
    if (req.url === '/auth/jwt-token/token/refresh/') { res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({access:token(3600),refresh:'rotated-fixture-refresh'})); return; }
    if (req.url === '/api/v1/users/me/') { res.writeHead(200, {'content-type':'application/json'}).end(JSON.stringify({username:'fixture@example.test'})); return; }
    if (req.url === '/sse') { res.writeHead(200, {'content-type':'text/event-stream'}); res.write('data: '+JSON.stringify({jsonrpc:'2.0',id:body.id,result:{ok:true}})+'\n\n'); return; }
    if (body?.method === 'notifications/initialized') { res.writeHead(202).end(); return; }
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify(body?.jsonrpc ? {jsonrpc:'2.0',id:body.id,result:{ok:true}} : {url:req.url, account:req.headers.authorization}));
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1'); await once(server,'listening');
  const client = createSharedTransport({directory});
  t.after(async () => { try { process.kill((await client.status()).pid); } catch {} client.close(); server.closeAllConnections(); server.close(); await fs.rm(directory,{recursive:true,force:true}); });
  return {directory,client,counts,sockets,url:'http://127.0.0.1:'+server.address().port};
}

test('20 independent chat processes share one owner, one read and bounded sockets', async t => {
  const f=await fixture(t), children=[];
  t.after(()=>children.forEach(child=>child.kill()));
  const code=`const {createSharedTransport}=require(${JSON.stringify(path.resolve('dist'))});const c=createSharedTransport({directory:process.argv[1]});process.send({ready:true});process.on('message',async()=>{try{const value=await(await c.fetch(process.argv[2]+'/api/v1/command-center/agents/?environment=one',{headers:{Authorization:'Bearer one'}})).json();process.send({value,status:await c.status()});c.close();process.disconnect();}catch(e){process.send({error:e.message});process.exit(1);}});`;
  await Promise.all(Array.from({length:20},async()=>{const child=spawn(process.execPath,['-e',code,f.directory,f.url],{stdio:['ignore','ignore','pipe','ipc']});children.push(child);await once(child,'message');}));
  const results=await Promise.all(children.map(child=>{const answer=once(child,'message');child.send('go');return answer.then(([value])=>value);}));
  assert.ok(results.every(result=>!result.error),JSON.stringify(results));
  assert.equal(new Set(results.map(result=>result.status.instanceId)).size,1);
  assert.equal([...f.counts.values()].reduce((a,b)=>a+b,0),1);
  assert.ok(f.sockets.size<=2);
  const before=(await f.client.status()).requests;
  await f.client.fetch(f.url+'/api/v1/command-center/agents/?environment=one',{headers:{Authorization:'Bearer one'}});
  assert.equal((await f.client.status()).requests,before,'warm panel must not make another read');
  console.log(JSON.stringify({clients:20,owners:1,upstreamRequests:before,openSockets:f.sockets.size}));
});

test('scope isolation, MCP ID correlation, live refresh and no mutation replay', async t=>{
  const f=await fixture(t), auth={Authorization:'Bearer one'};
  for(const [environment,token] of [['one','one'],['two','one'],['one','two']])await f.client.fetch(f.url+'/api/v1/command-center/agents/?environment='+environment,{headers:{Authorization:'Bearer '+token}});
  assert.equal((await f.client.status()).requests,3);
  const call=(id,method='tools/list',cache='force-cache',url='/mcp')=>f.client.fetch(f.url+url,{method:'POST',cache,headers:auth,body:JSON.stringify({jsonrpc:'2.0',id,method,params:{}})});
  const results=await Promise.all(Array.from({length:20},(_,i)=>call(i+1).then(r=>r.json())));
  assert.deepEqual(results.map(r=>r.id),Array.from({length:20},(_,i)=>i+1));
  assert.equal((await f.client.status()).requests,4);
  await f.client.invalidate(); await call(21);
  assert.equal((await f.client.status()).requests,5);
  await assert.rejects(call(22,'tools/call','default','/fail-after-send'),/not replayed/);
  assert.equal([...f.counts].filter(([key])=>key.includes('/fail-after-send')).reduce((n,[,v])=>n+v,0),1);
  assert.equal((await(await call(23,'tools/call','default','/sse')).json()).id,23,'SSE completes at its matching response without waiting for stream close');
});

test('one stopped panel does not cancel another panel sharing its read', async t=>{
  const f=await fixture(t), other=createSharedTransport({directory:f.directory});t.after(()=>other.close());
  await other.status();
  const controller=new AbortController();
  const stopped=f.client.fetch(f.url+'/slow',{signal:controller.signal});
  const completed=other.fetch(f.url+'/slow');
  const assertion=assert.rejects(stopped);
  await new Promise(resolve=>setTimeout(resolve,80));controller.abort();
  assert.equal((await(await completed).json()).url,'/slow');await assertion;
  assert.equal((await other.status()).requests,1);
});

test('worker failure never replays an accepted POST; subsequent reads reconnect', async t=>{
  const f=await fixture(t);const original=await f.client.status();
  const pending=f.client.fetch(f.url+'/slow-send',{method:'POST',body:'{}'});const failure=assert.rejects(pending,/No request was replayed/);
  await new Promise(resolve=>setTimeout(resolve,80));process.kill(original.pid,'SIGKILL');await failure;
  const next=await f.client.status();assert.notEqual(next.instanceId,original.instanceId);
  await f.client.fetch(f.url+'/api/v1/users/me/');
  assert.equal([...f.counts].filter(([key])=>key.includes('/slow-send')).reduce((n,[,v])=>n+v,0),1);
});

test('private directory and expiry boundaries prevent unsafe cache reuse',async t=>{
  const f=await fixture(t);
  const token='eyJ.'+Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)-1})).toString('base64url')+'.signature';
  for(let i=0;i<2;i++)await f.client.fetch(f.url+'/api/v1/users/me/',{headers:{Authorization:'Bearer '+token}});
  assert.equal((await f.client.status()).requests,2);
  const unsafe=path.join(f.directory,'unsafe');await fs.mkdir(unsafe,{mode:0o755});const client=createSharedTransport({directory:unsafe});
  await assert.rejects(client.status(),/private directory/);client.close();
});

test('20 processes renew an expired shared session once and persist one returned pair',async t=>{
 const f=await fixture(t),file=path.join(f.directory,'fixture-session.json'),writes=path.join(f.directory,'writes.txt');
 await fs.writeFile(file,JSON.stringify({username:'fixture@example.test',access:token(-60),refresh:'old-fixture-refresh'}));
 const children=[];t.after(()=>children.forEach(c=>c.kill()));
 const code=`const fs=require('node:fs/promises');const {createSharedTransport,createSessionService,createNodeHost}=require(${JSON.stringify(path.resolve('dist'))});const c=createSharedTransport({directory:process.argv[1]});const session=createSessionService(createNodeHost(),{env:{},fetch:c.fetch,sessionLock:c.sessionLock,persistence:{mode:'machine',name:'fixture',read:async()=>JSON.parse(await fs.readFile(process.argv[3],'utf8')),write:async(_,value)=>{const pending=process.argv[3]+'.'+process.pid;await fs.writeFile(pending,JSON.stringify(value));await fs.rename(pending,process.argv[3]);await fs.appendFile(process.argv[4],'write\\n');},remove:async()=>{}}});process.send({ready:true});process.on('message',async()=>{try{process.send({status:await session.status(process.argv[2],true)});}catch(e){process.send({error:e.code||e.message});}finally{c.close();process.disconnect();}});`;
 await Promise.all(Array.from({length:20},async()=>{const c=spawn(process.execPath,['-e',code,f.directory,f.url,file,writes],{stdio:['ignore','ignore','pipe','ipc']});children.push(c);await once(c,'message');}));
 const results=await Promise.all(children.map(child=>{const answer=once(child,'message');child.send('go');return answer.then(([value])=>value);}));
 assert.ok(results.every(r=>r.status?.checked&&r.status?.username==='fixture@example.test'),JSON.stringify(results));
 assert.equal((await fs.readFile(writes,'utf8')).trim().split('\n').length,1);
 assert.equal([...f.counts].filter(([key])=>key.includes('/auth/jwt-token/token/refresh/')).reduce((n,[,v])=>n+v,0),1);
});

test('a disconnected session lease owner releases a waiting client',async t=>{
 const f=await fixture(t),other=createSharedTransport({directory:f.directory});t.after(()=>other.close());
 let entered;const started=new Promise(resolve=>entered=resolve);let finish;
 const first=f.client.sessionLock(f.url,()=>{entered();return new Promise(resolve=>finish=resolve);});await started;
 const second=other.sessionLock(f.url,async()=>true);f.client.close();assert.equal(await second,true);finish();await first;
 // fixture cleanup uses the surviving client after the first was intentionally closed.
 const pid=(await other.status()).pid;process.kill(pid);
});


test('directory reads stay cached across thirty seconds and expire after sixty seconds', {timeout:70000}, async t=>{
 const f=await fixture(t),headers={Authorization:'Bearer '+token(3600)},url=f.url+'/api/v1/code-repositories/';
 await f.client.fetch(url,{headers});
 await new Promise(resolve=>setTimeout(resolve,31000));
 await f.client.fetch(url,{headers});assert.equal((await f.client.status()).requests,1);
 await new Promise(resolve=>setTimeout(resolve,30000));
 await f.client.fetch(url,{headers});assert.equal((await f.client.status()).requests,2);
});
