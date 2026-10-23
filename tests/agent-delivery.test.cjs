const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const {AgentDelivery}=require('../dist/index.js');
const env='10000000-0000-4000-8000-000000000001',agent='20000000-0000-4000-8000-000000000001',session='30000000-0000-4000-8000-000000000001';
const scope={host:'fixture',conversationId:'chat-a',backend:'https://fixture.invalid',account:'fixture@example.test'};
const ok=data=>({schemaVersion:1,status:'success',action:'fixture',summary:'OK',data});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ms-delivery-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const calls=[],state={account:scope.account};
 const createDispatch=signal=>async r=>{calls.push(r);signal?.throwIfAborted();
  if(r.action==='auth-status')return ok({authenticated:true,username:state.account});
  if(r.action==='agent-get')return ok({agent:{uid:agent,name:'Fixture agent',responseKinds:['message']}});
  if(r.action==='agent-session')return ok({sessionUid:session});
  if(r.action==='agent-readiness')return state.preflightFailure||ok({ready:true});
  if(r.action==='agent-send'){state.started?.();if(state.gate)await state.gate;if(state.sendFailure)return state.sendFailure;return ok({responseKind:'message',sessionUid:session,message:'Reply\n  preserved exact spacing'});}
  throw new Error('Unexpected action '+r.action);
 };
 const service=()=>new AgentDelivery({directory,createDispatch});const api=service();
 const draft=(extra={})=>({requestId:randomUUID(),environmentUid:env,agentUid:agent,message:'A harmless fixture question',...extra});
 return {directory,api,service,draft,calls,state,sends:()=>calls.filter(c=>c.action==='agent-send')};
}
test('staging is durable, immutable, deduplicated while pending, private and isolated by host/chat/account/backend',async t=>{
 const f=await fixture(t),d=f.draft(),first=await f.api.stage(scope,d);
 assert.equal(first.state,'pending');assert.equal(f.calls.some(x=>x.action==='agent-session'),false);
 assert.equal((await f.service().stage(scope,f.draft())).requestId,first.requestId);
 await assert.rejects(f.api.stage(scope,{...d,message:'different'}),/immutable/);
 for(const change of [{conversationId:'chat-b'},{host:'other'},{backend:'https://other.invalid'}])assert.equal((await f.api.list({...scope,...change})).length,0);
 await assert.rejects(f.api.get({...scope,account:'different'},d.requestId),/account changed/);
 const stat=await fs.stat(f.directory);assert.equal(stat.mode&0o777,0o700);
 for(const name of await fs.readdir(f.directory))if(name.endsWith('.json'))assert.equal((await fs.stat(path.join(f.directory,name))).mode&0o777,0o600);
 assert.equal(f.sends().length,0);
});
test('Stop before dispatch preserves the original request; concurrent recovery sends once and reuses the receipt',async t=>{
 const f=await fixture(t),r=await f.api.stage(scope,f.draft()),stop=new AbortController();stop.abort();
 await assert.rejects(f.api.deliver(scope,r.requestId,stop.signal));assert.equal(f.sends().length,0);
 const results=await Promise.all([f.api.deliver(scope,r.requestId),f.service().deliver(scope,r.requestId),f.service().deliver(scope,r.requestId)]);
 assert.ok(results.every(r=>r.state==='delivered'));assert.equal(f.sends().length,1);
 assert.equal(f.sends()[0].messageId,r.requestId);
 const again=await f.service().deliver(scope,r.requestId);assert.equal(again.receipt.message,'Reply\n  preserved exact spacing');assert.equal(f.sends().length,1);
});
test('Stop during a send cancels only the native waiter; the background receipt survives and recovery never resends',async t=>{
 const f=await fixture(t),r=await f.api.stage(scope,f.draft());let release,started;
 f.state.gate=new Promise(r=>release=r);const sent=new Promise(r=>started=r);f.state.started=started;
 const stop=new AbortController(),pending=f.api.deliver(scope,r.requestId,stop.signal);await sent;stop.abort();
 await assert.rejects(pending);assert.equal((await f.api.get(scope,r.requestId)).state,'sending');
 release();const result=await f.service().wait(scope,r.requestId);assert.equal(result.state,'delivered');
 assert.equal(result.sendAttempts,1);assert.equal(f.sends().length,1);assert.equal(result.receipt.message,'Reply\n  preserved exact spacing');
});
test('unknown send outcomes block retries and further sends in that agent conversation',async t=>{
 const f=await fixture(t);f.state.sendFailure={status:'failure',summary:'Transport lost',effects:{state:'partial-or-uncertain'}};
 const r=await f.api.stage(scope,f.draft());assert.equal((await f.api.deliver(scope,r.requestId)).state,'uncertain');
 assert.equal((await f.service().deliver(scope,r.requestId)).state,'uncertain');
 const next=await f.api.stage(scope,f.draft({message:'A different message'}));await assert.rejects(f.api.deliver(scope,next.requestId),/uncertain/);assert.equal(f.sends().length,1);
});
test('known pre-send failures, pending cancellation, expiry and account switches cannot send',async t=>{
 const f=await fixture(t);f.state.preflightFailure={status:'failure',summary:'Not ready',error:{code:'UNSUPPORTED_ACTION'}};
 let r=await f.api.stage(scope,f.draft());assert.equal((await f.api.deliver(scope,r.requestId)).state,'failed');assert.equal(f.sends().length,0);
 r=await f.api.stage(scope,f.draft({message:'Cancel me'}));await f.api.cancel(scope,r.requestId);assert.equal((await f.api.deliver(scope,r.requestId)).state,'cancelled');
 r=await f.api.stage(scope,f.draft({message:'Expire me'}));
 const file=(await fs.readdir(f.directory)).find(n=>n.endsWith('.json')),p=path.join(f.directory,file),state=JSON.parse(await fs.readFile(p));state.requests[r.requestId].expiresAt=new Date(0).toISOString();await fs.writeFile(p,JSON.stringify(state));
 assert.equal((await f.api.deliver(scope,r.requestId)).state,'expired');
 f.state.account='other';await assert.rejects(f.api.list(scope),/account changed/);assert.equal(f.sends().length,0);
});
test('a process killed after send leaves an uncertain record; restarting cannot replay it',async t=>{
 const f=await fixture(t),r=await f.api.stage(scope,f.draft()),sentFile=path.join(f.directory,'sent');
 const script=`const fs=require('node:fs'),{AgentDelivery}=require(${JSON.stringify(path.resolve('dist/index.js'))});
 const ok=data=>({status:'success',summary:'OK',data});
 const service=new AgentDelivery({directory:process.argv[1],createDispatch:()=>async r=>{
 if(r.action==='auth-status')return ok({authenticated:true,username:${JSON.stringify(scope.account)}});
 if(r.action==='agent-session')return ok({sessionUid:${JSON.stringify(session)}});
 if(r.action==='agent-readiness')return ok({ready:true});
 if(r.action==='agent-send'){fs.appendFileSync(process.argv[2],r.messageId+'\\n');await new Promise(()=>{});}
 }});service.deliver(${JSON.stringify(scope)},process.argv[3]);`;
 const child=spawn(process.execPath,['-e',script,f.directory,sentFile,r.requestId],{stdio:'ignore'});t.after(()=>child.kill('SIGKILL'));
 for(let i=0;i<200&&!await fs.stat(sentFile).then(()=>true,()=>false);i++)await delay(10);
 assert.equal(await fs.readFile(sentFile,'utf8'),r.requestId+'\n');
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 const recovered=await f.service().deliver(scope,r.requestId);assert.equal(recovered.state,'uncertain');assert.equal(recovered.sendAttempts,1);assert.equal(f.sends().length,0);
 assert.equal(await fs.readFile(sentFile,'utf8'),r.requestId+'\n');
});
test('corrupt and symlinked storage fail closed rather than discarding deduplication history',async t=>{
 const f=await fixture(t),r=await f.api.stage(scope,f.draft()),file=(await fs.readdir(f.directory)).find(n=>n.endsWith('.json')),p=path.join(f.directory,file);
 await fs.writeFile(p,'broken');await assert.rejects(f.api.deliver(scope,r.requestId));assert.equal(await fs.readFile(p,'utf8'),'broken');
 await fs.unlink(p);await fs.symlink(path.join(f.directory,'missing'),p);await assert.rejects(f.api.list(scope));assert.equal(f.sends().length,0);
});

test('status readers tolerate a lock being released while opening it',async t=>{
 const f=await fixture(t),r=await f.api.stage(scope,f.draft());
 for(let pass=0;pass<8;pass++) await Promise.all(Array.from({length:8},()=>f.service().get(scope,r.requestId)));
 assert.equal(f.sends().length,0);
});

test('explicit recovery retries only failed preparation with zero dispatches, retaining request and session identity',async t=>{
 const f=await fixture(t),r=await f.api.stage(scope,f.draft());
 f.state.preflightFailure={status:'failure',summary:'Temporary backend outage',error:{code:'API_ERROR'}};
 assert.equal((await f.api.deliver(scope,r.requestId)).state,'failed');assert.equal(f.sends().length,0);
 delete f.state.preflightFailure;
 const result=await f.service().deliver(scope,r.requestId);assert.equal(result.state,'delivered');assert.equal(result.requestId,r.requestId);assert.equal(f.sends().length,1);
 assert.equal((await f.service().deliver(scope,r.requestId)).receipt.message,result.receipt.message);assert.equal(f.sends().length,1);
});

test('an agent-send preflight failure proves no remote mutation and permits same-ID recovery; an ambiguous send never does',async t=>{
 const f=await fixture(t),r=await f.api.stage(scope,f.draft());
 f.state.sendFailure={status:'failure',summary:'Backend failed during client preflight',error:{code:'BACKEND_UNREACHABLE'}};
 const failed=await f.api.deliver(scope,r.requestId);assert.equal(failed.state,'failed');assert.equal(failed.sendAttempts,0);
 delete f.state.sendFailure;
 const delivered=await f.service().deliver(scope,r.requestId);assert.equal(delivered.state,'delivered');assert.equal(delivered.sendAttempts,1);
 assert.deepEqual(f.sends().map(x=>x.messageId),[r.requestId,r.requestId]);
 assert.equal((await f.api.deliver(scope,r.requestId)).state,'delivered');assert.equal(f.sends().length,2);
});
test('fresh agent conversation gets a distinct stable handle without losing old receipts',async t=>{
 const f=await fixture(t),first=await f.api.stage(scope,f.draft());await f.api.deliver(scope,first.requestId);
 const key=randomUUID(),next=await f.api.stage(scope,f.draft({conversationKey:key}));assert.notEqual(next.handleId,first.handleId);
 assert.equal((await f.api.stage(scope,f.draft({conversationKey:key}))).handleId,next.handleId);assert.equal((await f.api.get(scope,first.requestId)).state,'delivered');
});
test('accepted tasks survive Stop and repeated recovery without another send; task reads and cancellation bind the saved receipt',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ms-task-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));let sends=0,cursor=1;
 const taskUid=randomUUID(),api=new AgentDelivery({directory,createDispatch:()=>async r=>{
  if(r.action==='auth-status')return ok({authenticated:true,username:scope.account});
  if(r.action==='agent-get')return ok({agent:{uid:agent,name:'Task agent',responseKinds:['task']}});
  if(r.action==='agent-session')return ok({sessionUid:session});if(r.action==='agent-readiness')return ok({ready:true});
  if(r.action==='agent-send'){sends++;assert.equal(r.responseKind,'task');return ok({responseKind:'task',taskUid,sessionUid:session,status:'working',eventCursor:1,terminal:false});}
  assert.equal(r.taskUid,taskUid);return ok({responseKind:'task',taskUid,sessionUid:session,status:r.action==='agent-task-cancel'?'cancelled':'completed',eventCursor:++cursor,terminal:true,outputs:[{text:'Task answer'}]});
 }});
 const draft={requestId:randomUUID(),environmentUid:env,agentUid:agent,message:'Fixture task',responseKind:'task'};
 await api.stage(scope,draft);const stop=new AbortController();stop.abort();await assert.rejects(api.deliver(scope,draft.requestId,stop.signal));
 const accepted=await api.deliver(scope,draft.requestId);assert.equal(accepted.task.taskUid,taskUid);await api.deliver(scope,draft.requestId);assert.equal(sends,1);
 const completed=await api.task(scope,draft.requestId,'get');assert.match(completed.receipt.message,/Task answer/);await api.task(scope,draft.requestId,'cancel');assert.equal(sends,1);await assert.rejects(api.task({...scope,conversationId:'other'},draft.requestId,'get'),/No saved request/);
});
test('Talk prepares the same durable handle without sending an introductory message',async t=>{
 const f=await fixture(t),key=randomUUID(),prepared=await f.api.prepare(scope,{environmentUid:env,agentUid:agent,conversationKey:key});assert.equal(prepared.ready,true);assert.equal(f.sends().length,0);
 const saved=await f.api.stage(scope,f.draft({conversationKey:key}));assert.equal(saved.handleId,prepared.handleId);
});
