import { createApp } from './app.js';
import { loadConfig } from './core.js';
import fs from 'node:fs';
import path from 'node:path';
import { processInfo } from './servers.js';

const config = loadConfig();
fs.mkdirSync(config.dataDir,{recursive:true,mode:0o700});
const lockPath=path.join(config.dataDir,'panel.lock');
if(fs.existsSync(lockPath)){
  const old=JSON.parse(fs.readFileSync(lockPath,'utf8'));
  const live=await processInfo(old.pid);
  if(live&&live.created===old.created)throw new Error('该数据目录已有面板进程运行，不能同时启动第二个实例');
  fs.unlinkSync(lockPath);
}
const identity=await processInfo(process.pid);
fs.writeFileSync(lockPath,JSON.stringify(identity),{flag:'wx',mode:0o600});
const context = await createApp(config);
if (!context.store.users().length) { console.error('请先运行 npm run init 创建管理员账号。'); await context.close(); process.exit(1); }
const server = context.app.listen(config.port, config.host, () => { fs.writeFileSync(path.join(config.dataDir, 'panel.pid'), String(process.pid)); console.log(`Safehouse 管理面板：${config.origin}\n监听 ${config.host}:${config.port}；数据目录 ${config.dataDir}；PID ${process.pid}`); });
server.requestTimeout = 10 * 60000; server.headersTimeout = 15000; server.keepAliveTimeout = 5000; server.maxRequestsPerSocket = 100;
let closing = false;
async function shutdown() { if (closing) return; closing = true; server.close(); await context.close(); try{const lock=JSON.parse(fs.readFileSync(lockPath,'utf8'));if(lock.pid===process.pid)fs.unlinkSync(lockPath);}catch{} process.exit(0); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
