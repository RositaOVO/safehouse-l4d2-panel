import fs from'node:fs/promises';
import path from'node:path';
import os from'node:os';
import {id,fail,safePath,inside,diskFree}from'./core.js';

const DAY=86400000,UUID=/^[a-f0-9]{8}-[a-f0-9-]{27}$/i;
export async function memoryStatus(){
 const result={total:os.totalmem(),available:os.freemem(),free:os.freemem(),cached:null,panel:process.memoryUsage()};
 if(process.platform==='linux'){const text=await fs.readFile('/proc/meminfo','utf8'),values=Object.fromEntries([...text.matchAll(/^(\w+):\s+(\d+) kB/gm)].map(m=>[m[1],Number(m[2])*1024]));Object.assign(result,{total:values.MemTotal,available:values.MemAvailable,free:values.MemFree,cached:(values.Cached||0)+(values.SReclaimable||0)});}
 return result;
}
export class Maintenance{
 constructor(config,store,servers,{workshop,previews}={}){this.config=config;this.store=store;this.servers=servers;this.workshop=workshop;this.previews=previews;this.helper=config.kernelHelperState||'/var/lib/safehouse-maintenance';}
 assertIdle(taskId){if(this.store.list('task').some(t=>t.id!==taskId&&['queued','running'].includes(t.status)))fail(409,'请等待当前安装、上传或备份任务完成，再进行维护清理');}
 async status(){const helper=process.platform==='linux'&&!!await fs.stat(path.join(this.helper,'installed.json')).catch(()=>null),last=helper?await fs.readFile(path.join(this.helper,'result.json'),'utf8').then(JSON.parse).catch(()=>null):null;return{memory:await memoryStatus(),diskFree:await diskFree(this.config.dataDir),kernelCacheAvailable:helper,kernelCooldownSeconds:last?Math.max(0,Math.ceil((last.completed+300000-Date.now())/1000)):0,gcAvailable:typeof global.gc==='function',retention:{temporaryDays:1,logsDays:14,steamCacheDays:7}};}
 async preview(user,{logsDays=14,steamCache=false}={}){
  this.assertIdle();if(!Number.isInteger(logsDays)||logsDays<7||logsDays>365)fail(400,'旧日志保留天数必须为 7–365 天');
  const now=Date.now(),files=[],directories=[],warnings=[];let scanned=0;
  const scan=async(root,relative,category,cutoff,{recursive=true,nameFilter=()=>true}={})=>{
   const absolute=await safePath(root,relative).catch(()=>null);if(!absolute)return;
   const entries=await fs.readdir(absolute,{withFileTypes:true}).catch(()=>[]);
   for(const entry of entries){if(++scanned>20000)fail(413,'清理扫描超过 20000 项，请先缩小日志范围');const name=relative+'/'+entry.name;
    if(entry.isSymbolicLink()){warnings.push('已跳过符号链接：'+name);continue;}
    if(entry.isDirectory()&&recursive){await scan(root,name,category,cutoff,{recursive,nameFilter});const directoryStat=await fs.lstat(await safePath(root,name));if(directoryStat.mtimeMs<cutoff)directories.push({root,relative:name});}
    else if(entry.isFile()&&nameFilter(entry.name)){const file=await safePath(root,name,{allowMissing:false}),stat=await fs.lstat(file);if(stat.mtimeMs<cutoff&&stat.isFile())files.push({root,relative:name,category,size:stat.size,mtime:stat.mtimeMs,ino:String(stat.ino)});}
   }
  };
  await scan(this.config.dataDir,'uploads','uploads',now-DAY,{recursive:false,nameFilter:n=>/^[a-f0-9]{32}$/.test(n)});
  const staging=await safePath(this.config.dataDir,'staging');
  for(const entry of await fs.readdir(staging,{withFileTypes:true}).catch(()=>[]))if(entry.isDirectory()&&!entry.isSymbolicLink()&&UUID.test(entry.name)&&(await fs.lstat(await safePath(this.config.dataDir,'staging/'+entry.name))).mtimeMs<now-DAY){
   await scan(this.config.dataDir,'staging/'+entry.name,'temporary',now-DAY);directories.push({root:this.config.dataDir,relative:'staging/'+entry.name});
  }
  await scan(this.config.dataDir,'logs','logs',now-logsDays*DAY,{recursive:false,nameFilter:n=>/\.log(?:\.\d+|[-.]\d{8})(?:\.gz)?$/i.test(n)});
  for(const server of this.store.list('server')){try{await this.servers.validateRoot(server.root);for(const dir of['left4dead2/logs','left4dead2/addons/sourcemod/logs'])await scan(server.root,dir,'logs',now-logsDays*DAY,{recursive:false,nameFilter:n=>/^(?:L\d{6,10}|errors_\d{8})\.log$/i.test(n)});}catch{warnings.push('跳过不可访问的实例日志：'+server.name);}}
  if(steamCache&&inside(this.config.dataDir,this.config.steamcmd)){
   const tool=path.relative(this.config.dataDir,path.dirname(this.config.steamcmd)).split(path.sep).join('/');
   if(tool)for(const kind of['downloads','content'])await scan(this.config.dataDir,`${tool}/steamapps/workshop/${kind}/550`,'steamcache',now-7*DAY);
  }
  const plan={id:id(),user,created:now,expires:now+10*60000,files,directories,warnings:warnings.slice(0,50),bytes:files.reduce((a,f)=>a+f.size,0)};
  this.store.put('maintenancePlan',plan);for(const previous of this.store.list('maintenancePlan'))if(previous.expires<now)this.store.remove('maintenancePlan',previous.id);
  return{id:plan.id,expires:plan.expires,count:files.length,bytes:plan.bytes,files:files.slice(0,150).map(({root,relative,size,category})=>({path:path.join(root,relative),size,category})),warnings:plan.warnings,truncated:files.length>150};
 }
 async clean(planId,user,ctx={}){
  this.assertIdle(ctx.taskId);const plan=this.store.get('maintenancePlan',planId);if(!plan||plan.user!==user||plan.expires<Date.now())fail(409,'清理预览已失效，请重新扫描');
  this.store.remove('maintenancePlan',plan.id);const before=await diskFree(this.config.dataDir);let removed=0,bytes=0;const skipped=[];
  for(const item of plan.files){ctx.signal?.throwIfAborted();
   try{const file=await safePath(item.root,item.relative,{allowMissing:false}),stat=await fs.lstat(file);if(!stat.isFile()||stat.size!==item.size||stat.mtimeMs!==item.mtime||String(stat.ino)!==item.ino){skipped.push(item.relative);continue;}await fs.unlink(file);removed++;bytes+=item.size;}catch{skipped.push(item.relative);}
   ctx.update?.(`已清理 ${removed} 个文件，${(bytes/1024**2).toFixed(1)} MB`,plan.files.length?removed/plan.files.length*95:95);
  }
  for(const directory of plan.directories.sort((a,b)=>b.relative.length-a.relative.length))try{await fs.rmdir(await safePath(directory.root,directory.relative,{allowMissing:false}));}catch{}
  const result={removed,bytes,skipped:skipped.slice(0,100),diskFreeBefore:before,diskFreeAfter:await diskFree(this.config.dataDir)};
  this.store.audit(user,'maintenance.disk_cleaned','',result);return result;
 }
 async memory(mode,user,ctx={}){
  const before=await memoryStatus();
  if(mode==='panel'){
   const workshop=this.workshop?.cache.size||0,previews=this.previews?.cache.size||0;
   this.workshop?.cache.clear();this.workshop?.detailsCache?.clear();this.previews?.cache.clear();if(this.previews)this.previews.bytes=0;this.servers.cache.clear();
   if(typeof global.gc==='function')global.gc();await new Promise(r=>setImmediate(r));
   const result={mode,before,after:await memoryStatus(),cleared:{workshop,previews},garbageCollection:typeof global.gc==='function'};this.store.audit(user,'maintenance.memory_cleaned','',{mode,cleared:result.cleared});return result;
  }
  if(mode!=='kernel')fail(400,'内存维护模式无效');
  if(!(await this.status()).kernelCacheAvailable)fail(400,'该主机尚未安装 Linux 系统缓存维护助手');
  const last=await fs.readFile(path.join(this.helper,'result.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(last?.completed&&Date.now()-last.completed<300000)fail(429,'系统缓存回收每 5 分钟最多执行一次');
  const dir=path.join(this.config.dataDir,'maintenance');await fs.mkdir(dir,{recursive:true,mode:0o700});const request=path.join(dir,'kernel-cache.request'),started=Date.now();
  try{await fs.writeFile(request,'',{flag:'wx',mode:0o600});}catch(error){if(error.code==='EEXIST')fail(409,'系统缓存维护请求正在处理');throw error;}
  ctx.update?.('正在由受限维护助手回收 Linux 文件缓存',15);
  for(let i=0;i<120;i++){ctx.signal?.throwIfAborted();const result=await fs.readFile(path.join(this.helper,'result.json'),'utf8').then(JSON.parse).catch(()=>null);if(result&&result.completed>=started){if(!result.ok)fail(502,result.error||'系统缓存回收失败');const value={mode,before,after:await memoryStatus(),helper:result};this.store.audit(user,'maintenance.kernel_cache_reclaimed','',{completed:result.completed});return value;}await new Promise(r=>setTimeout(r,250));}
  fail(504,'系统维护助手未在限定时间内响应');
 }
}
