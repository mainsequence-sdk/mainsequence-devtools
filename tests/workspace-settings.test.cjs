const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {writeWorkspacePreferences,readDesktopPreferences}=require('../dist');
test('workspace settings preserve unrelated fields, save a bare folder name under home as the CLI does, and reject corrupt files',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ms-settings-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const configPath=path.join(root,'config.json'),options={configPath,homeDir:root,env:{}};
 await fs.writeFile(configPath,JSON.stringify({custom:{keep:true}}));const input={backend:'https://fixture.example',baseDir:path.join(root,'repos'),commandCenterUrl:'https://command.example'};
 assert.equal((await writeWorkspacePreferences(input,options)).baseDir,input.baseDir);assert.deepEqual(JSON.parse(await fs.readFile(configPath)).custom,{keep:true});
 assert.equal((await writeWorkspacePreferences({...input,baseDir:'mainsequence-dev'},options)).baseDir,path.join(root,'mainsequence-dev'));
 assert.equal(JSON.parse(await fs.readFile(configPath)).mainsequence_path,path.join(root,'mainsequence-dev'));
 await assert.rejects(writeWorkspacePreferences({...input,baseDir:'  '},options),/required/);
 await fs.writeFile(configPath,'broken');await assert.rejects(writeWorkspacePreferences(input,options),/preserved/);assert.equal(await fs.readFile(configPath,'utf8'),'broken');
 await assert.rejects(readDesktopPreferences(options),/preserved/);
});
