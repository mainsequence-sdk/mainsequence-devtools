const test = require('node:test');
const assert = require('node:assert/strict');
const { createDevTools, createNodeHost } = require('../dist');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const backend = 'https://platform.example', environmentUid = id(1), agentUid = id(2), sessionUid = id(3), taskUid = id(4);
const row = () => ({ uid: agentUid, name: 'Analyst', description: 'Analyze risk', organization_environment_uid: environmentUid,
  organization_environment_name: 'Research', repository_branch: 'develop', runtime_release_uid: id(5), runtime_update: {state:'current'},
  a2a_profile: {supported_response_kinds:['message','task']}, agent_card: {url:'https://never-contact.example/',skills:[{name:'Risk',description:'Explain exposure',examples:['Explain risk']} ]},
  configuration: {secret:'not-public'}, runtime_config: {token:'not-public'} });
function fixture() {
 const calls = [], state = {account:'person@example.test',row:row(),catalog:['agent.list','agent.search','agent.get','a2a.send_message','a2a.get_task','a2a.wait_task','a2a.cancel_task']};
 const task = () => ({agent_uid:agentUid,agent_session_uid:sessionUid,task_uid:taskUid,status:'working',terminal:false,event_cursor:2,outputs:[],cancellation_requested:false});
 const session = {status:async (url,check)=>{assert.equal(url,backend);assert.equal(check,true);return {authenticated:true,username:state.account}},sanitize:s=>s.replaceAll('known-secret','[redacted]'),
 request:async(url,method,path,body,retrySafe,options)=>{
  calls.push({url,method,path,body,retrySafe,options});assert.equal(path,'/mcp');assert.equal(url,backend);
  const reply = result=>({jsonrpc:'2.0',id:body.id,result});
  if(body.method==='initialize')return reply({protocolVersion:'2025-11-25',capabilities:{tools:{}}});
  if(body.method==='notifications/initialized')return;
  if(body.method==='tools/list')return reply({tools:state.catalog.map(name=>({name,inputSchema:{type:'object'}}))});
  const {name,arguments:args}=body.params;let data;
  if(name==='agent.list')data={count:35,results:[state.row]};
  if(name==='agent.search')data={results:[state.row]};
  if(name==='agent.get')data=state.row;
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
 const api=createDevTools({host:createNodeHost(),session,env:{}});
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
 assert.ok(sends.every(c=>c.retrySafe===false&&c.options.timeoutMs===75000));assert.ok(sends.every(c=>!Object.hasOwn(c.body.params.arguments,'completion_policy')));
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
