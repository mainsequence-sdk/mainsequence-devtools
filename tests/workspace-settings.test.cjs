const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {writeWorkspacePreferences,readDesktopPreferences}=require('../dist');
test('workspace settings preserve unrelated fields and reject corrupt files and relative paths',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ms-settings-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const configPath=path.join(root,'config.json'),options={configPath,homeDir:root,env:{}};
 await fs.writeFile(configPath,JSON.stringify({custom:{keep:true}}));const input={backend:'https://fixture.example',baseDir:path.join(root,'repos'),commandCenterUrl:'https://command.example'};
 assert.equal((await writeWorkspacePreferences(input,options)).baseDir,input.baseDir);assert.deepEqual(JSON.parse(await fs.readFile(configPath)).custom,{keep:true});
 await assert.rejects(writeWorkspacePreferences({...input,baseDir:'relative'},options),/absolute/);
 await fs.writeFile(configPath,'broken');await assert.rejects(writeWorkspacePreferences(input,options),/preserved/);assert.equal(await fs.readFile(configPath,'utf8'),'broken');
 await assert.rejects(readDesktopPreferences(options),/preserved/);
});
