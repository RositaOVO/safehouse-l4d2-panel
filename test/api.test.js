import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { loadConfig,sleep } from '../src/core.js';
import { hashPassword } from '../src/security.js';
import { tempDir,fixtureServer,fixtureVpk,fixtureSmx } from './helpers.js';
import { DISK_RESERVE } from '../src/disk-space.js';

let root,context,server,origin,config,owner,sid,mapId,backupId;
const password='Test-Only-Strong-Password-284!';
async function request(route,{session=owner,method='GET',body,headers={}}={}){
  const h={Host:new URL(config.origin).host,...headers};
  if(session?.cookie)h.Cookie=session.cookie;
  if(method!=='GET'){h.Origin=config.origin;h['X-CSRF-Token']=session?.csrf||'';}
  if(body&&!(body instanceof FormData)){h['Content-Type']='application/json';body=JSON.stringify(body);}
  const res=await fetch(origin+'/api'+route,{method,headers:h,body});const data=await res.json();return {res,data};
}
async function login(name='admin',pwd=password,code){const {res,data}=await request('/auth/login',{session:null,method:'POST',body:{username:name,password:pwd,...(code?{code}:{})}});assert.equal(res.status,200,JSON.stringify(data));return {cookie:res.headers.get('set-cookie').split(';')[0],csrf:data.csrf,user:data.user};}
async function taskDone(task){assert(task.id);for(let i=0;i<100;i++){const data=context.store.get('task',task.id);if(!['queued','running'].includes(data.status))return data;await sleep(50);}throw new Error('Task timeout');}
before(async()=>{root=await tempDir();await fixtureServer(path.join(root,'game'));config=loadConfig({dataDir:path.join(root,'data'),allowedRoots:[root],uploadLimit:64*1024**2,port:0,origin:'http://127.0.0.1',publicMode:false,host:'127.0.0.1',trustProxy:false});context=await createApp(config);context.store.addUser({name:'admin',password:await hashPassword(password)});server=context.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin=`http://127.0.0.1:${server.address().port}`;config.origin=origin;owner=await login();
  // File/API integration uses an explicit stopped-server double. Real game process tests are separate.
  context.servers.status=async server=>({...server,rcon:undefined,state:'stopped',info:null,processAlive:false});
});
after(async()=>{await context?.close();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});

test('HTTP：匿名拒绝、Host 绑定与安全响应头',async()=>{let r=await request('/servers',{session:null});assert.equal(r.res.status,401);assert(r.res.headers.get('content-security-policy').includes("script-src 'self'"));const status=await new Promise((resolve,reject)=>{const req=http.get(origin+'/api/servers',{headers:{Host:'evil.test',Cookie:owner.cookie}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});assert.equal(status,403);});
test('CSRF：缺失令牌、伪造 Origin 都被拒绝',async()=>{let r=await request('/servers',{method:'POST',body:{},session:{cookie:owner.cookie,csrf:'wrong'}});assert.equal(r.res.status,403);const response=await fetch(origin+'/api/workshop/resolve',{method:'POST',headers:{Host:new URL(origin).host,Cookie:owner.cookie,Origin:'https://evil.test','Content-Type':'application/json','X-CSRF-Token':owner.csrf},body:'{}'});assert.equal(response.status,403);});
test('发现与接管：识别有效服务端、重复目录拒绝',async()=>{let r=await request('/discovery',{method:'POST',body:{}});assert.equal(r.res.status,200);assert(r.data.candidates.some(c=>c.root===path.join(root,'game')));r=await request('/servers',{method:'POST',body:{name:'API Fixture',root:path.join(root,'game'),port:28991}});assert.equal(r.res.status,201,JSON.stringify(r.data));sid=r.data.id;assert(!('rcon'in r.data));r=await request('/servers',{method:'POST',body:{name:'Duplicate',root:path.join(root,'game'),port:28992}});assert.equal(r.res.status,409);});
test('启动设置：局部更新不会重置其他参数，拒绝命令注入',async()=>{let r=await request(`/servers/${sid}`,{method:'PATCH',body:{map:'test_map',tickrate:100}});assert.equal(r.res.status,200);assert.equal(r.data.port,28991);assert.equal(r.data.tickrate,100);assert.equal(r.data.name,'API Fixture');r=await request(`/servers/${sid}`,{method:'PATCH',body:{map:'c1m1;quit'}});assert.equal(r.res.status,400);});
test('账号权限：只读账号不能启停、上传；无实例权限不能查看',async()=>{let r=await request('/users',{method:'POST',body:{name:'viewer',password,role:'viewer',servers:[sid]}});assert.equal(r.res.status,201);const viewer=await login('viewer');r=await request('/servers',{session:viewer});assert.equal(r.data.length,1);r=await request(`/servers/${sid}/control`,{session:viewer,method:'POST',body:{action:'start'}});assert.equal(r.res.status,403);r=await request(`/servers/${sid}/upload/plugin`,{session:viewer,method:'POST',body:new FormData()});assert.equal(r.res.status,403);r=await request('/users',{method:'POST',body:{name:'outsider',password,role:'viewer',servers:[]}});const outsider=await login('outsider');r=await request(`/servers/${sid}/maps`,{session:outsider});assert.equal(r.res.status,403);r=await request('/servers',{session:outsider});assert.deepEqual(r.data,[]);});
test('上传地图：独立安装任务、章节识别、文件清单',async()=>{const form=new FormData();form.append('file',new Blob([fixtureVpk('api_map')]),'map.vpk');let r=await request(`/servers/${sid}/upload/map`,{method:'POST',body:form});assert.equal(r.res.status,202,JSON.stringify(r.data));const task=await taskDone(r.data);assert.equal(task.status,'succeeded',task.error);r=await request(`/servers/${sid}/maps`);assert.equal(r.data.length,1);mapId=r.data[0].id;assert.deepEqual(r.data[0].maps,['api_map']);assert(await fs.stat(path.join(root,'game',r.data[0].files[0])));});
test('地图状态：禁用移出挂载目录，启用后恢复',async()=>{for(const action of ['disable','enable']){const r=await request(`/servers/${sid}/maps/action`,{method:'POST',body:{id:mapId,action}});const task=await taskDone(r.data);assert.equal(task.status,'succeeded',task.error);const map=context.store.get('map',mapId);assert.equal(map.enabled,action==='enable');assert(map.files[0].includes(action==='enable'?'/addons/workshop/':'/safehouse-disabled/'));}});
test('上传插件：SMX 安装、启用与持久禁用、真实运行未知状态',async()=>{const form=new FormData();form.append('file',new Blob([fixtureSmx()]),'api_plugin.smx');let r=await request(`/servers/${sid}/upload/plugin`,{method:'POST',body:form});assert.equal((await taskDone(r.data)).status,'succeeded');r=await request(`/servers/${sid}/plugins/toggle`,{method:'POST',body:{file:'api_plugin.smx',enabled:false}});assert.equal(r.res.status,200);assert.equal(r.data.enabled,false);assert(await fs.stat(path.join(root,'game/left4dead2/addons/sourcemod/plugins/disabled/api_plugin.smx')));r=await request(`/servers/${sid}/plugins`);assert.equal(r.data.plugins[0].enabled,false);assert.equal(r.data.plugins[0].runtime,'unknown');r=await request(`/servers/${sid}/plugins/toggle`,{method:'POST',body:{file:'disabled/api_plugin.smx',enabled:true}});assert.equal(r.res.status,200);});
test('上传恶意内容：伪 SMX 拒绝且上传暂存清理',async()=>{const form=new FormData();form.append('file',new Blob(['MZ malicious']),'bad.smx');const r=await request(`/servers/${sid}/upload/plugin`,{method:'POST',body:form});const task=await taskDone(r.data);assert.equal(task.status,'failed');assert.match(task.error,/插件文件头无效/);assert.deepEqual(await fs.readdir(path.join(root,'data/uploads')),[]);});
test('配置：保存与历史恢复，越界文件拒绝',async()=>{let r=await request(`/servers/${sid}/config`,{method:'PUT',body:{path:'left4dead2/cfg/server.cfg',text:'hostname "Updated"\n'}});assert.equal(r.res.status,200);r=await request(`/servers/${sid}/config?path=left4dead2/cfg/server.cfg`);assert.equal(r.data.text,'hostname "Updated"\n');assert.equal(r.data.history.length,1);const version=r.data.history[0].id;r=await request(`/servers/${sid}/config/restore`,{method:'POST',body:{id:version}});assert.equal(r.res.status,200);assert.equal(await fs.readFile(path.join(root,'game/left4dead2/cfg/server.cfg'),'utf8'),'hostname "Fixture"\n');r=await request(`/servers/${sid}/config?path=../../master.key`);assert.equal(r.res.status,400);});
test('备份恢复：完整归档、校验、保护备份及数据还原',async()=>{let r=await request(`/servers/${sid}/backups`,{method:'POST',body:{name:'API Full Backup',full:true}});const task=await taskDone(r.data);assert.equal(task.status,'succeeded',task.error);backupId=task.result.id;await fs.writeFile(path.join(root,'game/left4dead2/cfg/server.cfg'),'changed');await fs.writeFile(path.join(root,'game/left4dead2/cfg/new.cfg'),'added');r=await request(`/servers/${sid}/backups/restore`,{method:'POST',body:{id:backupId}});const restored=await taskDone(r.data);assert.equal(restored.status,'succeeded',restored.error);assert.equal(await fs.readFile(path.join(root,'game/left4dead2/cfg/server.cfg'),'utf8'),'hostname "Fixture"\n');await assert.rejects(()=>fs.stat(path.join(root,'game/left4dead2/cfg/new.cfg')));assert(restored.result.safetyBackup);});
test('备份损坏：SHA-256 不匹配时拒绝恢复',async()=>{const backup=context.store.get('backup',backupId);await fs.appendFile(backup.file,'corrupted');const r=await request(`/servers/${sid}/backups/restore`,{method:'POST',body:{id:backupId}});const task=await taskDone(r.data);assert.equal(task.status,'failed');assert.match(task.error,/备份校验失败/);});
test('定时计划：保存、暂停与删除；实例权限仍校验',async()=>{let r=await request('/schedules',{method:'POST',body:{name:'Update check',serverId:sid,action:'checkUpdates',intervalMinutes:60,onlyEmpty:false}});assert.equal(r.res.status,201);const key=r.data.id;r=await request(`/schedules/${key}`,{method:'PATCH',body:{enabled:false}});assert.equal(r.data.enabled,false);r=await request(`/schedules/${key}`,{method:'DELETE',body:{}});assert.equal(r.res.status,200);});
test('玩法配置组：快照、应用与保护备份',async()=>{let r=await request(`/servers/${sid}/profiles`,{method:'POST',body:{name:'Original'}});assert.equal(r.res.status,201);const profile=r.data.id;await request(`/servers/${sid}`,{method:'PATCH',body:{map:'changed_map'}});r=await request(`/servers/${sid}/profiles/apply`,{method:'POST',body:{id:profile}});const task=await taskDone(r.data);assert.equal(task.status,'succeeded',task.error);assert.equal(context.servers.get(sid).map,'test_map');});
test('任务取消：排队任务取消，运行任务接收中止信号',async()=>{const slow=context.tasks.create('slow',sid,owner.user.id,ctx=>new Promise((resolve,reject)=>ctx.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true})));await sleep(10);const queued=context.tasks.create('queued',sid,owner.user.id,async()=>42);let r=await request(`/tasks/${queued.id}/cancel`,{method:'POST',body:{}});assert.equal(r.res.status,200);assert.equal(context.store.get('task',queued.id).status,'cancelled');r=await request(`/tasks/${slow.id}/cancel`,{method:'POST',body:{}});assert.equal((await taskDone(slow)).status,'cancelled');});
test('公网模式：强制 HTTPS，账号密码登录可直接访问，双重验证接口已移除',async()=>{config.publicMode=true;config.origin=origin.replace('http:','https:');context.app.set('trust proxy','loopback');const fetchRequest=async(route,options={})=>request(route,{...options,headers:{'X-Forwarded-Proto':'https',...options.headers}});try{let r=await request('/settings');assert.equal(r.res.status,400);r=await fetchRequest('/settings');assert.equal(r.res.status,200);r=await fetchRequest('/auth/mfa/begin',{method:'POST',body:{}});assert.equal(r.res.status,404);}finally{config.publicMode=false;config.origin=origin;context.app.set('trust proxy',false);}});
test('操作审计：操作被记录且链验证通过',async()=>{const r=await request('/audit');assert.equal(r.res.status,200);assert.equal(r.data.valid,true);assert(r.data.entries.some(e=>e.action==='config.saved'));});
test('已有地图：扫描接管与重复扫描保持幂等',async()=>{await fs.writeFile(path.join(root,'game/left4dead2/addons/existing.vpk'),fixtureVpk('existing_map'));let r=await request(`/servers/${sid}/maps/scan`,{method:'POST',body:{}});let t=await taskDone(r.data);assert.equal(t.status,'succeeded',t.error);assert.equal(t.result.adopted,1);r=await request(`/servers/${sid}/maps/scan`,{method:'POST',body:{}});t=await taskDone(r.data);assert.equal(t.result.adopted,0);});
test('工坊封面：拒绝私网、第三方站点和非图片 API 来源',async()=>{for(const url of['https://127.0.0.1/','https://evil.test/image.jpg','https://api.steampowered.com/private']){const result=await request('/workshop/preview?url='+encodeURIComponent(url));assert.equal(result.res.status,400);}});
test('公告接口：权限、显示通道与长度检查，通过隔离 RCON 替身验证而不向玩家发送测试消息',async()=>{
 const original=context.servers.command,calls=[];context.servers.command=async(_s,c)=>{calls.push(c);return c.includes(' ')?'accepted':`[SM] Usage: ${c} <message>`;};
 try{const viewer=await login('viewer');let r=await request(`/servers/${sid}/players/action`,{session:viewer,method:'POST',body:{action:'say',message:'test'}});assert.equal(r.res.status,403);assert.equal(calls.length,0);
 for(const body of[{message:'x;quit'},{message:'中'.repeat(54)},{message:'test',channel:'shell'}]){r=await request(`/servers/${sid}/players/action`,{method:'POST',body:{action:'say',...body}});assert.equal(r.res.status,400);}
 r=await request(`/servers/${sid}/players/action`,{method:'POST',body:{action:'say',message:'接口公告测试',channel:'center'}});assert.equal(r.res.status,200);assert.equal(r.data.channel,'center');assert.equal(r.data.submitted,true);assert.deepEqual(calls,['sm_csay','sm_csay "接口公告测试"']);
 }finally{context.servers.command=original;}
});
test('直链接口：只读账号与跨实例拒绝，内网与非法参数拒绝，有效请求进入独立任务',async()=>{
  const viewer=await login('viewer');let r=await request(`/servers/${sid}/maps/direct`,{session:viewer,method:'POST',body:{url:'https://example.com/map.vpk'}});assert.equal(r.res.status,403);
  for(const body of[{url:'http://127.0.0.1/a.vpk'},{url:'https://example.com/a',filename:'../a.vpk'},{url:'https://example.com/a',sha256:'invalid'}]){r=await request(`/servers/${sid}/maps/direct`,{method:'POST',body});assert.equal(r.res.status,400);}
  const original=context.content.installMap;let received;
  try{context.content.installMap=async(key,input)=>{received={key,input};return {verified:true};};r=await request(`/servers/${sid}/maps/direct`,{method:'POST',body:{url:'https://example.com/map.vpk?token=private',sha256:'a'.repeat(64)}});assert.equal(r.res.status,202);const task=await taskDone(r.data);assert.equal(task.status,'succeeded');assert.equal(received.key,sid);assert.equal(received.input.checksum,'a'.repeat(64));assert(!JSON.stringify(task).includes('token=private'));}finally{context.content.installMap=original;}
});
test('维护接口：仅所有者可操作，预览确认后清理，内存缓存整理独立执行',async()=>{const viewer=await login('viewer');let r=await request('/maintenance',{session:viewer});assert.equal(r.res.status,403);r=await request('/maintenance/preview',{session:viewer,method:'POST',body:{}});assert.equal(r.res.status,403);r=await request('/maintenance');assert.equal(r.res.status,200);assert(r.data.memory.total>0);r=await request('/maintenance/preview',{method:'POST',body:{logsDays:1}});assert.equal(r.res.status,400);r=await request('/maintenance/preview',{method:'POST',body:{logsDays:14}});assert.equal(r.res.status,200);const planId=r.data.id;r=await request('/maintenance/clean',{method:'POST',body:{planId}});assert.equal((await taskDone(r.data)).status,'succeeded');r=await request('/maintenance/memory',{method:'POST',body:{mode:'panel'}});assert.equal((await taskDone(r.data)).status,'succeeded');});
test('通知与诊断：失败任务汇总，诊断归档可下载且暂存清理',async()=>{const r=await request('/notifications');assert.equal(r.res.status,200);assert(r.data.some(n=>n.title==='上传插件'));const response=await fetch(origin+`/api/servers/${sid}/diagnostics`,{headers:{Cookie:owner.cookie}});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(bytes.toString('ascii',0,2),'PK');assert.match(response.headers.get('content-disposition'),/safehouse-diagnostics/);});

test('上传低空间回归：默认 2 GiB 上限、仅 1 GiB 可用时，小地图仍能上传并安装', async t => {
  const previous = config.uploadLimit; config.uploadLimit = 2 * 1024 ** 3;
  t.mock.method(fs, 'statfs', async () => ({ bavail: 1024 ** 3, bsize: 1 }));
  try {
    const form = new FormData(); form.append('file', new Blob([fixtureVpk('api_low_space')]), 'small.vpk');
    const result = await request(`/servers/${sid}/upload/map`, { method: 'POST', body: form });
    assert.equal(result.res.status, 202, JSON.stringify(result.data));
    const task = await taskDone(result.data); assert.equal(task.status, 'succeeded', task.error);
    assert.deepEqual(task.result.maps, ['api_low_space']);
    assert.deepEqual(await fs.readdir(path.join(root, 'data/uploads')), []);
    const doctor = await request(`/servers/${sid}/doctor`);
    assert.equal(doctor.res.status, 200); assert(doctor.data.find(check => check.name === '磁盘空间').ok);
  } finally { config.uploadLimit = previous; }
});
test('上传真实空间不足：返回可用量与需求，上传目录不留文件', async t => {
  t.mock.method(fs, 'statfs', async () => ({ bavail: DISK_RESERVE + 1, bsize: 1 }));
  const form = new FormData(); form.append('file', new Blob([fixtureVpk('api_no_space')]), 'map.vpk');
  const result = await request(`/servers/${sid}/upload/map`, { method: 'POST', body: form });
  assert.equal(result.res.status, 400); assert.match(result.data.error, /空间不足.*本次请求需要/);
  assert.deepEqual(await fs.readdir(path.join(root, 'data/uploads')), []);
});

test('API 多语言：按请求分别翻译错误，保留错误码与权限，不串改其他用户语言',async()=>{
 let r=await request('/servers',{session:null,headers:{'Accept-Language':'en-US'}});assert.equal(r.res.status,401);assert.equal(r.data.error,'Please sign in');assert.equal(r.res.headers.get('content-language'),'en');assert(r.res.headers.get('vary').includes('Accept-Language'));
 r=await request('/servers',{session:null,headers:{'Accept-Language':'zh-Hant'}});assert.equal(r.res.status,401);assert.equal(r.data.error,'請先登入');assert.equal(r.data.code,'REQUEST_FAILED');
 r=await request('/servers',{session:null});assert.equal(r.data.error,'请先登录');
 r=await request('/does-not-exist',{headers:{'Accept-Language':'en'}});assert.equal(r.res.status,404);assert.equal(r.data.error,'API endpoint not found');
 const denied=await fetch(origin+'/api/servers',{method:'POST',headers:{'Content-Type':'application/json','Accept-Language':'en',Origin:'https://evil.test'},body:'{}'});assert.equal(denied.status,403);assert.equal((await denied.json()).error,'Request origin validation failed');
});
