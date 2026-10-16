const test = require('node:test');
const assert = require('node:assert/strict');
const { createDevTools, createNodeHost } = require('../dist');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const backend = 'https://platform.example', environmentUid = id(1), agentUid = id(2), sessionUid = id(3), taskUid = id(4);
const row = () => ({ uid: agentUid, name: 'Analyst', description: 'Analyze risk', organization_environment_uid: environmentUid,
  organization_environment_name: 'Research', repository_branch: 'develop', runtime_release_uid: id(5), runtime_update: {state:'current'},
  a2a_profile: {supported_response_kinds:['message','task']}, agent_card: {url:'https://never-contact.example/',skills:[{name:'Risk',description:'Explain exposure',examples:['Explain risk']} ]},
  llm_provider:'anthropic', llm_model:'claude-sonnet-test', llm_thinking:'high', configuration: {secret:'not-public'}, runtime_config: {token:'not-public'} });
function fixture(options = {}) {
 const calls = [], state = {account:'person@example.test',row:row(),catalog:['agent.list','agent.search','agent.get','agent.get_or_create_session','agent_session.resolve_runtime_access','a2a.send_message','a2a.get_task','a2a.wait_task','a2a.cancel_task']};
 const task = () => ({agent_uid:agentUid,agent_session_uid:sessionUid,task_uid:taskUid,status:'working',terminal:false,event_cursor:2,outputs:[],cancellation_requested:false});
 const session = {status:async (url,check)=>{assert.equal(url,backend);assert.equal(check,true);return {authenticated:true,username:state.account}},sanitize:s=>s.replaceAll('known-secret','[redacted]'),
 request:async(url,method,path,body,retrySafe,options)=>{
  calls.push({url,method,path,body,retrySafe,options});assert.equal(path,'/mcp');assert.equal(url,backend);
  const reply = result=>({jsonrpc:'2.0',id:body.id,result});
  if(body.method==='initialize')return reply({protocolVersion:'2025-11-25',capabilities:{tools:{}}});
  if(body.method==='notifications/initialized')return;
  if(body.method==='tools/list')return reply({tools:state.catalog.map(name=>({name,inputSchema:{type:'object'},...(state.timeoutMeta===undefined?{}:{_meta:{'mainsequence.ai/timeout-seconds/v1':state.timeoutMeta}})}))});
  const {name,arguments:args}=body.params;let data;
  if(name==='agent.list')data={count:35,results:[state.row]};
  if(name==='agent.search')data={results:[state.row]};
  if(name==='agent.get')data=state.row;
  if(name==='agent.get_or_create_session')data={uid:args.session_uid||sessionUid,agent_uid:agentUid,organization_environment_uid:environmentUid,bound_handle:{handle_unique_id:args.handle_unique_id},runtime_token:'not-public',...(state.sessionOverride||{})};
  if(name==='agent_session.resolve_runtime_access') {
   data=state.accessQueue?.length ? state.accessQueue.shift() : {mode:'token',token:'private-runtime-token',rpc_url:'https://private-runtime.invalid',runtime_interaction:{state:'ready',can_submit:true}};
   state.afterAccess?.();
  }
  if(name==='a2a.get_task')data={...task(),...(state.taskOverride||{})};
  if(name==='a2a.wait_task')data={...task(),events:[],timed_out:true};
  if(name==='a2a.cancel_task')data={...task(),cancellation_requested:true};
  if(name==='a2a.send_message'){
   if(state.failSend)throw new Error('network known-secret');
   data=args.response_kind==='task'?{...task(),response_kind:'task',completion_policy:'poll'}:{agent_uid:agentUid,agent_session_uid:sessionUid,response_kind:'message',message:'I explain risk known-secret'};
   if(state.replyOverride)Object.assign(data,state.replyOverride);
  }
  return reply({structuredContent:data,isError:false});
 }};
 const api=createDevTools({host:createNodeHost(options.progress),session,env:{},signal:options.signal});
 return {calls,state,send:extra=>api.dispatch({action:'agent-send',backend,environmentUid,agentUid,expectedAccount:'person@example.test',message:'What do you do?',responseKind:'message',handleId:'claude_conversation_1',...extra}),
 dispatch:(action,extra={})=>api.dispatch({action,backend,environmentUid,...extra})};
}
test('agent discovery sends environment and pagination and projects only public card fields',async()=>{
 const f=fixture();const result=await f.dispatch('agents-list',{offset:25});assert.equal(result.status,'success');assert.equal(result.data.count,35);assert.equal(result.data.account,'person@example.test');
 const call=f.calls.find(c=>c.body.params?.name==='agent.list');assert.deepEqual(call.body.params.arguments,{organization_environment_uid:environmentUid,limit:25,offset:25});
 assert.doesNotMatch(JSON.stringify(result),/not-public|never-contact/);assert.equal(result.data.results[0].skills[0].name,'Risk');
 const search=await f.dispatch('agents-list',{search:'exposure'});assert.equal(search.data.semantic,true);assert.equal(search.data.count,1);
 assert.equal(f.calls.find(c=>c.body.params?.name==='agent.search').body.params.arguments.organization_environment_uid,environmentUid);
});
test('mixed-environment results are refused instead of displayed',async()=>{
 const f=fixture();f.state.row.organization_environment_uid=id(9);assert.equal((await f.dispatch('agents-list')).status,'failure');
 assert.equal((await f.send()).status,'failure');assert.equal(f.calls.filter(c=>c.body.params?.name==='a2a.send_message').length,0);
});
test('send allocates a stable handle; follow-up reuses its session with no replay or credential exchange',async()=>{
 const f=fixture();const first=await f.send();assert.equal(first.status,'success');assert.equal(first.data.sessionUid,sessionUid);assert.match(first.data.message,/\[redacted\]/);
 await f.send({handleId:undefined,sessionUid});const sends=f.calls.filter(c=>c.body.params?.name==='a2a.send_message');assert.equal(sends.length,2);
 assert.equal(sends[0].body.params.arguments.handle_unique_id,'claude_conversation_1');assert.equal(sends[1].body.params.arguments.agent_session_uid,sessionUid);
 assert.ok(sends.every(c=>c.retrySafe===false&&c.options.timeoutMs===145000));assert.ok(sends.every(c=>!Object.hasOwn(c.body.params.arguments,'completion_policy')));
 assert.notEqual(sends[0].body.params.arguments.message_id,sends[1].body.params.arguments.message_id);
});
test('changed account, missing account binding, malformed selections and undeployed agents never send',async()=>{
 for(const change of [f=>{f.state.account='someone-else'},f=>{f.state.row.runtime_release_uid=null},f=>{f.state.row.a2a_profile.supported_response_kinds=[]}]){
  const f=fixture();change(f);assert.equal((await f.send()).status,'failure');assert.equal(f.calls.filter(c=>c.body.params?.name==='a2a.send_message').length,0);
 }
 for(const input of [{expectedAccount:undefined},{environmentUid:'bad'},{handleId:'invalid/handle'},{sessionUid},{responseKind:undefined},{message:''}]){
  const f=fixture();assert.equal((await f.send(input)).status,'failure');assert.equal(f.calls.filter(c=>c.body.params?.name==='a2a.send_message').length,0);
 }
});
test('task messages use poll, wait and cancellation validate the task target first',async()=>{
 const f=fixture();assert.equal((await f.send({responseKind:'task'})).data.taskUid,taskUid);
 assert.equal(f.calls.find(c=>c.body.params?.name==='a2a.send_message').body.params.arguments.completion_policy,'poll');
 const selection={agentUid,taskUid,expectedAccount:'person@example.test'};
 const waited=await f.dispatch('agent-task-wait',selection);assert.equal(waited.data.timedOut,true);
 assert.deepEqual(f.calls.find(c=>c.body.params?.name==='a2a.wait_task').body.params.arguments,{task_uid:taskUid,after_sequence:2,timeout_seconds:15});
 assert.equal((await f.dispatch('agent-task-cancel',selection)).data.cancellationRequested,true);
 assert.equal(f.calls.find(c=>c.body.params?.name==='a2a.cancel_task').retrySafe,false);
 f.state.taskOverride={agent_uid:id(99)};const before=f.calls.filter(c=>c.body.params?.name==='a2a.cancel_task').length;
 assert.equal((await f.dispatch('agent-task-cancel',selection)).status,'failure');assert.equal(f.calls.filter(c=>c.body.params?.name==='a2a.cancel_task').length,before);
});
test('task continuation derives target from the task and refuses Message mode',async()=>{
 const f=fixture();assert.equal((await f.send({handleId:undefined,taskUid,responseKind:'task'})).status,'success');
 const args=f.calls.find(c=>c.body.params?.name==='a2a.send_message').body.params.arguments;assert.equal(args.task_uid,taskUid);assert.equal(args.agent_uid,undefined);
 assert.equal((await f.send({handleId:undefined,taskUid})).status,'failure');
});
test('an ambiguous send or mismatched response is reported without repeating the operation',async()=>{
 for(const change of [f=>{f.state.failSend=true},f=>{f.state.replyOverride={agent_uid:id(99)}}]){
  const f=fixture();change(f);const result=await f.send();assert.equal(result.status,'failure');assert.equal(result.effects.state,'partial-or-uncertain');assert.equal(f.calls.filter(c=>c.body.params?.name==='a2a.send_message').length,1);assert.doesNotMatch(JSON.stringify(result),/known-secret/);
 }
});
test('an older platform without messaging reports unsupported capability before sending',async()=>{
 const f=fixture();f.state.catalog=f.state.catalog.filter(n=>n!=='a2a.send_message');const result=await f.send();assert.equal(result.error.code,'UNSUPPORTED_ACTION');assert.equal(result.effects,undefined);
});

test('session resolution creates or resumes without messaging, exposes only public identity, and is safely repeatable',async()=>{
 const f=fixture(), selection={agentUid,expectedAccount:'person@example.test',handleId:'claude_host_agent_default'};
 const first=await f.dispatch('agent-session',selection);assert.equal(first.status,'success');assert.equal(first.data.sessionUid,sessionUid);
 await f.dispatch('agent-session',selection);
 await f.dispatch('agent-session',{agentUid,expectedAccount:'person@example.test',sessionUid});
 const calls=f.calls.filter(c=>c.body.params?.name==='agent.get_or_create_session');assert.equal(calls.length,3);
 assert.deepEqual(calls[0].body.params.arguments,{agent_uid:agentUid,handle_unique_id:selection.handleId});
 assert.deepEqual(calls[2].body.params.arguments,{agent_uid:agentUid,session_uid:sessionUid});assert.ok(calls.every(c=>c.retrySafe));
 assert.equal(f.calls.some(c=>c.body.params?.name==='a2a.send_message'),false);
 assert.doesNotMatch(JSON.stringify(first),/runtime_token|not-public|parent_session/);
});
test('session resolution rejects mismatched identities and missing account or ambiguous selectors',async()=>{
 for(const extra of [{},{expectedAccount:'person@example.test',handleId:'bad/handle'},{expectedAccount:'person@example.test',handleId:'ok',sessionUid}]){
  const f=fixture();assert.equal((await f.dispatch('agent-session',{agentUid,...extra})).status,'failure');
  assert.equal(f.calls.some(c=>c.body.params?.name==='agent.get_or_create_session'),false);
 }
 for(const override of [{uid:'invalid'},{agent_uid:id(99)},{organization_environment_uid:id(99)},{bound_handle:{handle_unique_id:'wrong'}}]){
  const f=fixture();f.state.sessionOverride=override;
  assert.equal((await f.dispatch('agent-session',{agentUid,expectedAccount:'person@example.test',handleId:'ok'})).status,'failure');
 }
});
test('advertised tool deadlines are bounded and invalid values cannot shorten agent sends',async()=>{
 for(const [value,expected] of [[140,145000],[200,205000],[295,300000],[-1,145000],[999999,145000],['140',145000],[0,145000]]){
  const f=fixture();f.state.timeoutMeta=value;assert.equal((await f.send()).status,'success');
  assert.equal(f.calls.find(c=>c.body.params?.name==='a2a.send_message').options.timeoutMs,expected);
 }
});

const readinessSelection={agentUid,sessionUid,expectedAccount:'person@example.test'};
const waking=(retry=1)=>({is_ready:true,mode:'unavailable',token:null,runtime_interaction:{state:'waking',can_submit:false,retry_after_ms:retry},runtime_presence:{detail:'private-runtime-token https://private-runtime.invalid'}});
test('readiness waits for admission, ignoring routability, and exposes no access credentials or URL',async()=>{
 const progress=[],f=fixture({progress:s=>progress.push(s)});f.state.accessQueue=[waking()];
 const result=await f.dispatch('agent-readiness',readinessSelection);
 assert.equal(result.status,'success');assert.deepEqual(result.data,{account:'person@example.test',agentUid,sessionUid,ready:true});
 assert.deepEqual(progress,['Checking agent…','Starting agent…','Agent ready']);
 assert.equal(f.calls.filter(c=>c.body.params?.name==='agent_session.resolve_runtime_access').length,2);
 assert.equal(f.calls.some(c=>c.body.params?.name==='a2a.send_message'),false);
 assert.doesNotMatch(JSON.stringify([result,progress]),/private-runtime|rpc_url|token/);
});
test('readiness fails closed for missing, inconsistent and terminal decisions without sending',async()=>{
 for(const access of [{is_ready:true}, {runtime_interaction:{state:'ready',can_submit:'true'}},
 {runtime_interaction:{state:'ready',can_submit:true},mode:'unavailable'},waking(NaN),
 {runtime_interaction:{state:'unavailable',can_submit:false,retry_after_ms:1},detail:'private-runtime-token'}]) {
  const f=fixture();f.state.accessQueue=[access];const result=await f.dispatch('agent-readiness',readinessSelection);
  assert.equal(result.status,'failure');assert.equal(result.effects,undefined);assert.doesNotMatch(JSON.stringify(result),/private-runtime/);
  assert.equal(f.calls.filter(c=>c.body.params?.name==='agent_session.resolve_runtime_access').length,1);
 }
});
test('readiness respects its wait budget and never polls earlier than a long server retry',async()=>{
 const f=fixture();f.state.accessQueue=[waking(60000)];
 const result=await f.dispatch('agent-readiness',{...readinessSelection,timeoutMs:10});
 assert.equal(result.error.code,'PROCESS_TIMEOUT');assert.equal(result.effects,undefined);
 assert.equal(f.calls.filter(c=>c.body.params?.name==='agent_session.resolve_runtime_access').length,1);
 for(const timeoutMs of [0,-1,Infinity,630001,'5']) assert.equal((await f.dispatch('agent-readiness',{...readinessSelection,timeoutMs})).error.code,'INVALID_REQUEST');
});
test('cancellation ends an in-progress wake without polling or sending',async()=>{
 const controller=new AbortController(),f=fixture({signal:controller.signal,progress:s=>{if(s==='Starting agent…')controller.abort();}});
 f.state.accessQueue=[waking(60000)];const result=await f.dispatch('agent-readiness',readinessSelection);
 assert.equal(result.status,'cancelled');assert.equal(result.effects,undefined);
 assert.equal(f.calls.filter(c=>c.body.params?.name==='agent_session.resolve_runtime_access').length,1);
});
test('resumed sessions revalidate identity and account changes stop a readiness wait',async()=>{
 const f=fixture();await f.dispatch('agent-readiness',readinessSelection);await f.dispatch('agent-readiness',readinessSelection);
 assert.equal(f.calls.filter(c=>c.body.params?.name==='agent_session.resolve_runtime_access').length,2);
 f.state.accessQueue=[waking()];f.state.afterAccess=()=>{f.state.account='changed'};
 assert.equal((await f.dispatch('agent-readiness',readinessSelection)).error.code,'AUTH_REJECTED');
 const mismatch=fixture();mismatch.state.sessionOverride={agent_uid:id(99)};
 assert.equal((await mismatch.dispatch('agent-readiness',readinessSelection)).status,'failure');
 assert.equal(mismatch.calls.some(c=>c.body.params?.name==='agent_session.resolve_runtime_access'),false);
});
test('opt-in send readiness stops known-unsent failures and dispatches exactly once when ready',async()=>{
 const f=fixture();f.state.accessQueue=[waking()];assert.equal((await f.send({waitForReady:true})).status,'success');
 const names=f.calls.map(c=>c.body.params?.name);assert.equal(names.filter(n=>n==='a2a.send_message').length,1);
 assert.ok(names.lastIndexOf('agent_session.resolve_runtime_access')<names.indexOf('a2a.send_message'));
 const blocked=fixture();blocked.state.accessQueue=[{runtime_interaction:{state:'unavailable',can_submit:false}}];
 const result=await blocked.send({waitForReady:true});assert.equal(result.status,'failure');assert.equal(result.effects,undefined);
 assert.equal(blocked.calls.some(c=>c.body.params?.name==='a2a.send_message'),false);
 const uncertain=fixture();uncertain.state.failSend=true;assert.equal((await uncertain.send({waitForReady:true})).effects.state,'partial-or-uncertain');
 assert.equal(uncertain.calls.filter(c=>c.body.params?.name==='a2a.send_message').length,1);
});

test('agent defaults are a read-only allowlisted projection across list, search and detail',async()=>{
 const f=fixture();
 for(const [action,extra] of [['agents-list',{}],['agents-list',{search:'risk'}],['agent-get',{agentUid}]]) {
  const result=await f.dispatch(action,extra),agent=result.data.agent||result.data.results[0];
  assert.deepEqual(agent.defaults,{provider:'anthropic',model:'claude-sonnet-test',thinking:'high'});
  assert.doesNotMatch(JSON.stringify(result),/not-public/);
 }
 f.state.row.llm_provider='';delete f.state.row.llm_model;f.state.row.llm_thinking={token:'not-public'};
 assert.deepEqual((await f.dispatch('agents-list')).data.results[0].defaults,{provider:'',model:'',thinking:''});
 assert.equal(f.calls.some(c=>c.body.params?.name==='a2a.send_message'),false);
});
