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
test('a host that shares only the repositories folder saves it alone; reads say whether the folder was saved',async t=>{
 const {readWorkspacePreferences}=require('../dist');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ms-settings-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const configPath=path.join(root,'config.json'),options={configPath,homeDir:root,env:{}};
 assert.deepEqual(await readWorkspacePreferences(options),{backend:'https://api.main-sequence.app',baseDir:path.join(root,'mainsequence'),baseDirSaved:false});
 await fs.writeFile(configPath,JSON.stringify({backend_url:'http://local-backend:8000',command_center_url:'https://command.example',custom:{keep:true}}));
 const saved=await writeWorkspacePreferences({baseDir:'mainsequence-dev'},options);
 assert.equal(saved.baseDir,path.join(root,'mainsequence-dev'));assert.equal(saved.baseDirSaved,true);assert.equal(saved.backend,'http://local-backend:8000');
 assert.deepEqual(JSON.parse(await fs.readFile(configPath)),{backend_url:'http://local-backend:8000',command_center_url:'https://command.example',custom:{keep:true},mainsequence_path:path.join(root,'mainsequence-dev')});
 await assert.rejects(writeWorkspacePreferences({},options),/Name a workspace setting/);
});
