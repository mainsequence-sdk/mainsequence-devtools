const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const { readWorkspacePreferences, createDevTools, createNodeHost } = require('../dist/index.js');
const envA='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', envB='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const uid=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const backend='https://backend.example';
const row=(n,environment=envA)=>({backend,name:'Project',resource_release_uid:uid(n),mcp_connection:{
  transport:'streamable-http',url:'https://project.example/mcp',resource_metadata_url:backend+'/.well-known/oauth-protected-resource/mcp?resource_release_uid='+uid(n),
  organization_environment_uid:environment,organization_environment_name:environment===envA?'Research':'Production',active_revision_uid:uid(999)}});
async function temporary(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ms-settings-env-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('workspace values resolve without authentication, preserve configuration, and honor precedence', async t=>{
 const dir=await temporary(t),configPath=path.join(dir,'config.json');
 assert.deepEqual(await readWorkspacePreferences({env:{},homeDir:dir,configPath}),{backend:'https://api.main-sequence.app',baseDir:path.join(dir,'mainsequence')});
 const original=JSON.stringify({backend_url:'http://127.0.0.1:8000',mainsequence_path:dir,provider:{secret:'fixture-secret'}});
 await fs.writeFile(configPath,original);
 assert.deepEqual(await readWorkspacePreferences({env:{},homeDir:dir,configPath}),{backend:'http://127.0.0.1:8000',baseDir:dir});
 assert.equal((await readWorkspacePreferences({env:{MAINSEQUENCE_ENDPOINT:'https://override.example'},homeDir:dir,configPath})).backend,'https://override.example');
 assert.equal(await fs.readFile(configPath,'utf8'),original);
});
test('MCP environments and filtered discovery include later pages without altering saved connections',async t=>{
 const dir=await temporary(t),file=path.join(dir,'mcp.json'),requests=[];
 const legacy=row(1);delete legacy.mcp_connection.organization_environment_name;
 const original=JSON.stringify([legacy,row(101,envB)]);await fs.writeFile(file,original);
 const session={request:async (b,m,p,body)=>{
  requests.push({p,body});
  if(p.startsWith('/api/v1/organization-environments/'))return {count:2,results:[{uid:envA,name:'Research'},{uid:envB,name:'Production',is_production:true}]};
  if(p==='/mcp'){
   if(body.method==='initialize')return {jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}}}};
   if(body.method==='notifications/initialized')return undefined;
   const offset=body.params.arguments.offset;
   return {jsonrpc:'2.0',id:body.id,result:{structuredContent:{count:101,results:offset===0?Array.from({length:100},(_,i)=>row(i+1)):[row(101,envB)]}}};
  }
  if(p==='/api/v1/resource-releases/'+uid(101)+'/')return row(101,envB);
  throw new Error('Unexpected credential or project request');
 }};
 const api=createDevTools({host:createNodeHost(),session,env:{},mcpConnectionsPath:file});
 const dispatch=(action,extra={})=>api.dispatch({action,backend,environmentUid:envB,...extra});
 assert.deepEqual((await dispatch('mcp-environments')).data,[{uid:envA,name:'Research',isProduction:false},{uid:envB,name:'Production',isProduction:true}]);
 const found=await dispatch('mcp-discover',{limit:25});assert.equal(found.status,'success');assert.equal(found.data.count,1);assert.equal(found.data.results[0].resource_release_uid,uid(101));
 assert.deepEqual(requests.filter(r=>r.body?.method==='tools/call').map(r=>r.body.params.arguments.offset),[0,100]);
 assert.equal((await dispatch('mcp-list')).data.length,1);
 assert.equal((await dispatch('mcp-tools',{environmentUid:envA,releaseUid:uid(101)})).error.code,'INVALID_REQUEST');
 assert.equal((await dispatch('mcp-call',{environmentUid:envA,releaseUid:uid(101),tool:'write',arguments:{}})).error.code,'INVALID_REQUEST');
 assert.equal((await dispatch('mcp-remove',{environmentUid:envA,releaseUid:uid(101)})).error.code,'INVALID_REQUEST');
 assert.equal(await fs.readFile(file,'utf8'),original);
 assert.ok(requests.every(r=>!r.p.includes('exchange-launch')));
 assert.equal((await dispatch('mcp-list',{environmentUid:'invalid'})).error.code,'INVALID_REQUEST');
});
