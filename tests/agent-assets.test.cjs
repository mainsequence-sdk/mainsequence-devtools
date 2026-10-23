const test = require('node:test');
const assert = require('node:assert/strict');
const {createAgentAssets, createNodeHost, stillAgentPng} = require('../dist');
const uid='11111111-1111-4111-8111-111111111111', envUid='22222222-2222-4222-8222-222222222222';
const backend='https://fixture.example';
function fixture(overrides={}) {
 const calls=[]; let account='fixture';
 const service=createAgentAssets({host:createNodeHost(),store:null,env:{MAINSEQUENCE_ENDPOINT:backend,MAINSEQUENCE_ACCESS_TOKEN:'synthetic-test-token'},fetch:async (url,init)=>{
   const p=new URL(url).pathname,body=init.body&&JSON.parse(init.body);calls.push({path:p,body});
   if(p==='/api/v1/users/me/') return Response.json({username:account});
   assert.equal(p,'/mcp','No per-agent icon GET or separate REST directory');
   const reply=result=>Response.json({jsonrpc:'2.0',id:body.id,result});
   if(body.method==='initialize')return reply({protocolVersion:'2025-11-25',capabilities:{tools:{}}});
   if(body.method==='notifications/initialized')return new Response(null,{status:202});
   if(body.method==='tools/list')return reply({tools:[{name:'agent.list',inputSchema:{type:'object'}}]});
   assert.equal(body.params.name,'agent.list');assert.equal(body.params.arguments.include_icons,true);
   if(overrides.switchAccount) account='another-account';
   return reply({structuredContent:{count:1,results:[{uid,name:'Fixture',organization_environment_uid:envUid,
     command_center_icon:{rendering:'mask',url:'https://never-fetch.example/icon',idle:{mime:'image/svg+xml',bytes:Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'),...overrides.idle}}}]}});
 }});
 return {calls,read:()=>service.read({backend,expectedAccount:'fixture',environmentUid:envUid,agentUids:[uid]})};
}
test('compatibility assets use one inline MCP directory and never fetch icon URLs',async()=>{
 const f=fixture(), out=await f.read();assert.match(out[uid].source,/^data:image\/svg\+xml;base64,/);assert.equal(out[uid].rendering,'mask');
 assert.doesNotMatch(JSON.stringify(out),/synthetic-test-token|https:/);
 assert.equal(f.calls.filter(c=>c.body?.params?.name==='agent.list').length,1);
});
test('malformed, unsupported, missing and oversized inline assets fall back without any image requests',async()=>{
 for(const idle of [{mime:'text/html'},{bytes:'not-base64!'},{bytes:''},{bytes:Buffer.alloc(524289).toString('base64')}]) {
  const f=fixture({idle});assert.deepEqual(await f.read(),{});
  assert.ok(f.calls.every(c=>['/api/v1/users/me/','/mcp'].includes(c.path)));
 }
});
test('inline assets are discarded if the shared account changes',async()=>{
 await assert.rejects(fixture({switchAccount:true}).read(),e=>e.code==='AUTH_REJECTED');
});
test('reduced motion removes animation chunks but keeps PNG image data; truncated chunks fail',()=>{
 const signature=Buffer.from([137,80,78,71,13,10,26,10]);
 const chunk=(name,data=Buffer.alloc(0))=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(name,4);data.copy(b,8);return b;};
 const ihdr=chunk('IHDR'),idat=chunk('IDAT',Buffer.from('pixels')),end=chunk('IEND');
 assert.deepEqual(stillAgentPng(Buffer.concat([signature,ihdr,chunk('acTL'),chunk('fcTL'),idat,chunk('fdAT'),end])),Buffer.concat([signature,ihdr,idat,end]));
 assert.throws(()=>stillAgentPng(Buffer.concat([signature,chunk('IDAT').subarray(0,6)])),/incomplete/);
});
