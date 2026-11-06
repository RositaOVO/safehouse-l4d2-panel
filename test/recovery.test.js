import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import * as tar from 'tar';
import { extractTar } from '../src/archive.js';
import { Store } from '../src/store.js';
import { Tasks } from '../src/tasks.js';
import { Content } from '../src/content.js';
import { Servers } from '../src/servers.js';
import { tempDir,fixtureServer } from './helpers.js';

test('RCON：同步默认地图配置，保留其他设置与历史，重复执行保持幂等',async()=>{
 const root=await tempDir(),store=new Store(path.join(root,'data'));
 try{const game=await fixtureServer(path.join(root,'game')),server={id:'rcon-test',root:game},servers=new Servers({},store,null),file=path.join(game,'left4dead2/cfg/server.cfg');
 const original='hostname "Keep"\r\nrcon_password "old-password" // legacy\r\nsv_lan 0\r\n';await fs.writeFile(file,original);
 await servers.syncRconConfig(server,'New-RCON-Password-123456');
 const result=await fs.readFile(file,'utf8');assert.equal(result,'hostname "Keep"\r\nrcon_password "New-RCON-Password-123456"\r\nsv_lan 0\r\n');assert.equal(store.list('configVersion')[0].text,original);
 await servers.syncRconConfig(server,'New-RCON-Password-123456');assert.equal(store.list('configVersion').length,1);
 await fs.writeFile(file,'hostname "No RCON"');await servers.syncRconConfig(server,'New-RCON-Password-123456');assert.match(await fs.readFile(file,'utf8'),/\nrcon_password "New-RCON-Password-123456"\n$/);
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});

test('账号升级：移除旧双重验证密钥和绑定暂存，保留账号',async()=>{
 const root=await tempDir();let store=new Store(root);
 try{store.addUser({name:'migration-admin',password:'test-hash'});store.db.exec('ALTER TABLE users ADD COLUMN totp TEXT; ALTER TABLE users ADD COLUMN last_totp INTEGER DEFAULT -1;');store.db.prepare('UPDATE users SET totp=?').run('old-encrypted-secret');store.put('mfaPending',{id:'pending',secret:'old'});store.close();store=new Store(root);
 assert(store.userByName('migration-admin'));const columns=store.db.prepare('PRAGMA table_info(users)').all().map(c=>c.name);assert(!columns.includes('totp'));assert(!columns.includes('last_totp'));assert.deepEqual(store.list('mfaPending'),[]);
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});

test('TAR.GZ：Linux 标准插件目录解压、拒绝软链接与解压配额',async()=>{
 const root=await tempDir();try{
  const source=path.join(root,'source');await fs.mkdir(path.join(source,'addons/sourcemod/configs'),{recursive:true});await fs.writeFile(path.join(source,'addons/sourcemod/configs/a.cfg'),'test');
  const file=path.join(root,'safe.tar.gz');await tar.c({file,cwd:source,gzip:true},['addons']);const list=await extractTar(file,path.join(root,'out'));assert.equal(list.length,1);assert.equal(await fs.readFile(path.join(root,'out/addons/sourcemod/configs/a.cfg'),'utf8'),'test');
  await assert.rejects(()=>extractTar(file,path.join(root,'quota'),{maxBytes:1}));
  await fs.symlink(source,path.join(source,'addons/sourcemod/configs/link'),process.platform==='win32'?'junction':'dir');
  const bad=path.join(root,'symlink.tar.gz');await tar.c({file:bad,cwd:source,gzip:true},['addons']);await assert.rejects(()=>extractTar(bad,path.join(root,'bad')),/链接/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('服务重启：未完成任务标记为中断，单纯读取 Store 不修改任务',async()=>{
 const root=await tempDir();let store=new Store(root);try{store.put('task',{id:'pending',status:'running'});store.close();store=new Store(root);assert.equal(store.get('task','pending').status,'running');store.recoverTasks();assert.equal(store.get('task','pending').status,'interrupted');}finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('文件事务：提交后能恢复旧文件并删除新增文件',async()=>{
 const root=await tempDir();const store=new Store(path.join(root,'data'));try{
  const game=await fixtureServer(path.join(root,'game')),server={id:'s',root:game};const servers={get:()=>server,validateRoot:async()=>game};const content=new Content({},store,servers,{});
  const source=path.join(root,'replacement.cfg');await fs.writeFile(source,'replacement');
  const tx=await content.transaction(server,[{source,relative:'left4dead2/cfg/server.cfg'},{source,relative:'left4dead2/cfg/new.cfg'}]);assert.equal(tx.state,'committed');assert.equal(await fs.readFile(path.join(game,'left4dead2/cfg/server.cfg'),'utf8'),'replacement');
  await content.rollbackTransaction(tx);assert.equal(await fs.readFile(path.join(game,'left4dead2/cfg/server.cfg'),'utf8'),'hostname "Fixture"\n');await assert.rejects(()=>fs.stat(path.join(game,'left4dead2/cfg/new.cfg')));
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('任务：失败隔离，后续任务仍执行，日志中的密码被脱敏',async()=>{
 const root=await tempDir();const store=new Store(root),tasks=new Tasks(store);try{
  const failed=tasks.create('bad','s','u',async ctx=>{ctx.update('password=private-value');throw new Error('failure');});const good=tasks.create('good','s','u',async()=>42);
  for(let i=0;i<100&&store.get('task',good.id).status!=='succeeded';i++)await new Promise(r=>setTimeout(r,10));
  assert.equal(store.get('task',failed.id).status,'failed');assert.equal(store.get('task',good.id).result,42);assert(!JSON.stringify(store.get('task',failed.id)).includes('private-value'));
 }finally{await tasks.close();store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('Linux SteamCMD：仅遇到 Invalid platform 时执行一次平台兼容流程',async()=>{
 const content=new Content({},null,null,null),calls=[];let first=true;
 content.runSteam=async args=>{calls.push(args);if(first){first=false;throw new Error('ERROR! Invalid platform');}return 'Success';};
 await content.steamServer('/srv/l4d2/test',{update:()=>{}},'linux');assert.equal(calls.length,3);assert(calls[1].includes('windows'));assert(calls[2].includes('linux'));assert(calls[2].includes('validate'));
 const rejected=new Content({},null,null,null);let attempts=0;rejected.runSteam=async()=>{attempts++;throw new Error('Access Denied');};await assert.rejects(()=>rejected.steamServer('/srv/l4d2/test',{update:()=>{}},'linux'));assert.equal(attempts,1);
});
test('事务提交：元数据失败时 SQLite 与文件同时回滚',async()=>{
 const root=await tempDir();const store=new Store(path.join(root,'data'));try{
  const game=await fixtureServer(path.join(root,'game')),server={id:'s',root:game},content=new Content({},store,{get:()=>server,validateRoot:async()=>game},{});
  const source=path.join(root,'next.cfg');await fs.writeFile(source,'new');
  await assert.rejects(()=>content.transaction(server,[{source,relative:'left4dead2/cfg/server.cfg'}],[],()=>{store.put('map',{id:'should-rollback'});throw new Error('simulated metadata failure');}));
  assert.equal(store.get('map','should-rollback'),null);assert.equal(await fs.readFile(path.join(game,'left4dead2/cfg/server.cfg'),'utf8'),'hostname "Fixture"\n');assert.equal(store.list('transaction')[0].state,'rolled_back');
 }finally{store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('兼容下载器：明确配置后服务器安装优先使用已配置工具',async()=>{
 const content=new Content({depotDownloader:'/configured/DepotDownloader'},null,null,null);let called;
 content.runSteam=async()=>{throw new Error('SteamCMD should not run');};content.runDepot=async(root,ctx,platform)=>{called={root,platform};return {ok:true};};
 assert.deepEqual(await content.steamServer('/srv/l4d2/example',{update:()=>{}},'linux'),{ok:true});assert.deepEqual(called,{root:'/srv/l4d2/example',platform:'linux'});
});
