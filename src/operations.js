import fs from 'node:fs/promises';
import path from 'node:path';
import { id, fail, safePath, walk, hashFile, redact, diskFree } from './core.js';
import { inspectVpk } from './vpk.js';
import { createZip } from './archive.js';
import { publicServer } from './servers.js';
import { DISK_RESERVE } from './disk-space.js';

export async function scanExistingMaps(sid, store, servers, ctx) {
  return servers.locks.run(sid, async()=>{
    const server=servers.get(sid);await servers.ensureStopped(server);
    const roots=['left4dead2/addons','left4dead2/addons/workshop'];let adopted=0;const errors=[];
    const owned=new Set(store.list('map').filter(m=>m.serverId===sid).flatMap(m=>m.files.map(f=>f.toLowerCase())));
    for(const relativeRoot of roots){
      const root=await safePath(server.root,relativeRoot);
      const files=(await fs.readdir(root,{withFileTypes:true}).catch(()=>[])).filter(e=>e.isFile()&&/\.vpk$/i.test(e.name)&&!/_\d{3}\.vpk$/i.test(e.name));
      for(const entry of files){
        const relative=`${relativeRoot}/${entry.name}`;if(owned.has(relative.toLowerCase()))continue;
        try{
          const source=await safePath(server.root,relative,{allowMissing:false}),info=await inspectVpk(source);if(!info.maps.length)continue;
          const all=[relative,...info.archives.map(n=>`${relativeRoot}/${entry.name.replace(/_dir\.vpk$/i,'')}_${String(n).padStart(3,'0')}.vpk`)];
          if(all.some(f=>owned.has(f.toLowerCase())))fail(409,'部分分卷已被其他项目接管');
          const key=`${sid}:imported-${id()}`;
          store.put('map',{id:key,serverId:sid,title:entry.name,workshopId:null,url:'',preview:'',enabled:true,installed:Date.now(),updated:0,maps:info.maps,files:all,hashes:await Promise.all(all.map(async f=>hashFile(await safePath(server.root,f,{allowMissing:false})))),resources:info.resources,missions:info.missions,adopted:true});
          for(const f of all)owned.add(f.toLowerCase());adopted++;ctx.update?.(`已接管 ${entry.name}`);
        }catch(e){errors.push({file:entry.name,error:e.message});}
      }
    }
    return {adopted,errors};
  });
}
export async function diagnostics(sid,store,servers,content){
  const server=servers.get(sid),stage=path.join(store.dir,'staging',id());await fs.mkdir(stage,{recursive:true});
  try{
    const state=await servers.status(server,true),plugins=await content.plugins(sid);
    await fs.writeFile(path.join(stage,'server.json'),JSON.stringify({...publicServer(server),status:state.state,info:state.info,node:process.version,platform:process.platform},null,2));
    await fs.writeFile(path.join(stage,'plugins.json'),redact(JSON.stringify(plugins,null,2)));
    await fs.writeFile(path.join(stage,'console-redacted.log'),redact(await servers.logs(sid)));
    await fs.writeFile(path.join(stage,'tasks.json'),redact(JSON.stringify(store.list('task').filter(t=>t.serverId===sid).slice(-30),null,2)));
    const logsRoot=await safePath(server.root,'left4dead2/addons/sourcemod/logs');
    const logs=await walk(logsRoot,{depth:1,limit:1000,filter:f=>/errors_.*\.log$/.test(f)});
    for(const file of logs.sort().slice(-5)){
      const handle=await fs.open(file,'r');try{const stat=await handle.stat(),bytes=Buffer.alloc(Math.min(stat.size,200000));await handle.read(bytes,0,bytes.length,Math.max(0,stat.size-bytes.length));await fs.writeFile(path.join(stage,path.basename(file)),redact(bytes.toString()));}finally{await handle.close();}
    }
    const archive=path.join(stage,'diagnostics.zip');
    await createZip(stage,archive,{accept:n=>n!=='diagnostics.zip'});return {stage,archive};
  }catch(error){await fs.rm(stage,{recursive:true,force:true});throw error;}
}
export async function notifications(store,config,user){
  const visible=sid=>user.role==='owner'||JSON.parse(user.servers||'[]').includes(sid);
  const items=store.list('task').filter(t=>t.serverId?visible(t.serverId):user.role==='owner').filter(t=>['failed','interrupted'].includes(t.status)).map(t=>({id:t.id,type:'error',title:t.type,message:t.error||t.message,serverId:t.serverId,created:t.ended||t.created,taskId:t.id}));
  for(const map of store.list('map').filter(m=>visible(m.serverId)&&m.updateAvailable))items.push({id:map.id,type:'update',title:`地图可更新：${map.title}`,message:'在已安装地图页面查看并安排停服更新',serverId:map.serverId,created:map.checked});
  for(const server of store.list('server').filter(s=>visible(s.id))){if((server.crashes||[]).filter(t=>Date.now()-t<10*60000).length>3)items.push({id:server.id,type:'error',title:'连续崩溃，自动拉起已暂停',message:server.name,serverId:server.id,created:server.crashes.at(-1)});}
  for(const tx of store.list('transaction').filter(t=>visible(t.serverId)&&t.state==='applying'))items.push({id:tx.id,type:'error',title:'文件事务等待恢复',message:'先停服，再重启面板，自动恢复被中断的文件操作。',serverId:tx.serverId,created:tx.created});
  if(user.role==='owner'){const free=await diskFree(config.dataDir);if(free<5*1024**3){const critical=free<DISK_RESERVE;items.push({id:'disk',type:critical?'error':'warning',title:critical?'面板数据磁盘空间不足':'面板数据磁盘余量较低',message:critical?'可用空间低于 256 MiB 安全余量，请先检查下载、备份和暂存目录。':'可用空间低于 5 GiB 提醒线；是否能安装按文件实际大小、解压及回滚需求检查。',created:Date.now()});}}
  if(user.role==='owner'){const failures=store.audits(300).filter(e=>e.action==='auth.login_failed'&&Date.now()-e.time<15*60000);if(failures.length>=5)items.push({id:'login-failures',type:'error',title:'检测到连续登录失败',message:`最近 15 分钟记录 ${failures.length} 次登录失败；查看操作日志并检查访问来源。`,created:failures[0].time});}
  return items.sort((a,b)=>b.created-a.created).slice(0,100);
}
