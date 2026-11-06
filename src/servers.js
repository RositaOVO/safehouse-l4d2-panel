import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail, id, inside, safePath, walk, sleep, redact, atomicWrite, Locks } from './core.js';
import { rcon, queryInfo, keyValues, parseStatus, parseRconInfo } from './protocols.js';

const execute = promisify(execFile);
const executableName = process.platform === 'win32' ? 'srcds.exe' : 'srcds_run';
export const validMap = value => /^[a-zA-Z0-9_][a-zA-Z0-9_/-]{0,119}$/.test(value) && !value.includes('..') && !value.endsWith('/');
export const publicServer = server => { const { rcon, ...visible } = server; return { ...visible, hasRcon: !!rcon }; };

export async function processInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { [pscustomobject]@{pid=[int]$p.ProcessId;exe=$p.ExecutablePath;created=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress }`], { windowsHide: true, timeout: 10000, maxBuffer: 20000 });
      return stdout.trim() ? JSON.parse(stdout) : null;
    } catch { return null; }
  }
  try { const exe = await fs.readlink(`/proc/${pid}/exe`), stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8'); return { pid, exe, created: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }; } catch { return null; }
}
export async function gameProcesses() {
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "@(Get-CimInstance Win32_Process -Filter \"Name='srcds.exe' OR Name='srcds_win64.exe'\" | ForEach-Object { [pscustomobject]@{pid=[int]$_.ProcessId;exe=$_.ExecutablePath;created=$_.CreationDate.ToUniversalTime().ToString('o')} }) | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 15000 });
      const list = JSON.parse(stdout || '[]'); return Array.isArray(list) ? list : [list];
    } catch { return []; }
  }
  const pids = (await fs.readdir('/proc').catch(() => [])).filter(x => /^\d+$/.test(x));
  const found = [];
  for (const pid of pids) { const p = await processInfo(Number(pid)); if (p && /srcds_(linux|linux64)$/.test(p.exe)) found.push(p); }
  return found;
}
export async function steamRoots() {
  const roots = [];
  if (process.platform === 'win32') {
    for (const folder of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) if (folder) roots.push(path.join(folder, 'Steam'));
    try {
      const { stdout } = await execute('reg.exe', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 5000 });
      const match = stdout.match(/SteamPath\s+REG_SZ\s+(.+)/); if (match) roots.push(match[1].trim());
    } catch {}
  } else roots.push(path.join(process.env.HOME || '', '.steam/steam'), path.join(process.env.HOME || '', '.local/share/Steam'), '/opt/steam', '/home/steam');
  const result = new Set();
  for (const root of roots) {
    if (!fss.existsSync(root)) continue;
    result.add(path.resolve(root));
    try {
      const kv = keyValues(await fs.readFile(path.join(root, 'steamapps/libraryfolders.vdf'), 'utf8'));
      for (const value of Object.values(kv.libraryfolders || kv.LibraryFolders || {})) if (value?.path) result.add(path.resolve(value.path));
    } catch {}
  }
  return [...result];
}
export class Servers {
  constructor(config, store, tasks) { this.config = config; this.store = store; this.tasks = tasks; this.locks = new Locks(); this.children = new Map(); this.cache = new Map(); this.approved = new Set(config.allowedRoots); this.closing = false; }
  async initialize() {
    for (const root of this.config.allowedRoots) await fs.mkdir(root, { recursive: true });
    for (const root of await steamRoots()) this.approved.add(root);
    this.monitor = setInterval(() => this.watch().catch(() => {}), 15000); this.monitor.unref();
  }
  get(key) { const server = this.store.get('server', key); if (!server) fail(404, '服务器不存在'); return server; }
  async validateRoot(root, allowEmpty = false) {
    const absolute = path.resolve(root);
    if (![...this.approved].some(p => inside(p, absolute))) fail(403, '目录不在授权范围；请在本机 .env 的 ALLOWED_ROOTS 中添加父目录');
    let current = absolute;
    while (true) {
      const st = await fs.lstat(current).catch(() => null);
      if (st?.isSymbolicLink()) fail(400, '服务器路径不能包含符号链接或目录联接');
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
    if (!allowEmpty) {
      if (!fss.existsSync(path.join(absolute, executableName))) fail(400, `目录中缺少 ${executableName}`);
      const gameinfo = await fs.readFile(path.join(absolute, 'left4dead2/gameinfo.txt'), 'utf8').catch(() => '');
      if (!/left\s*4\s*dead\s*2|left4dead2/i.test(gameinfo)) fail(400, '该目录不是有效的 L4D2 专用服务器');
    }
    return absolute;
  }
  async discover() {
    const found = new Map();
    const running = await gameProcesses();
    for (const proc of running) {
      if (!proc.exe) continue;
      let root = path.dirname(proc.exe); if (process.platform !== 'win32' && path.basename(root) === 'bin') root = path.dirname(root);
      if (fss.existsSync(path.join(root, 'left4dead2/gameinfo.txt'))) { this.approved.add(root); found.set(root.toLowerCase(), { root, process: proc }); }
    }
    for (const root of this.approved) {
      const files = await walk(root, { depth: 6, limit: 50000, filter: f => path.basename(f).toLowerCase() === executableName });
      for (const file of files) { const root = path.dirname(file); if (fss.existsSync(path.join(root, 'left4dead2/gameinfo.txt')) && !found.has(root.toLowerCase())) found.set(root.toLowerCase(), { root }); }
    }
    const servers = this.store.list('server');
    return { roots: [...this.approved], candidates: [...found.values()].map(item => ({ ...item, registered: servers.find(s => s.root.toLowerCase() === item.root.toLowerCase())?.id || null })) };
  }
  async register(input) {
    const root = await this.validateRoot(input.root);
    if (this.store.list('server').some(s => s.root.toLowerCase() === root.toLowerCase())) fail(409, '此服务器目录已经接管');
    if (this.store.list('server').some(s => s.port === input.port)) fail(409, '此端口已被另一个实例使用');
    const server = { id: id(), root, name: input.name, port: input.port || 27015, bind: input.bind || '127.0.0.1', map: input.map || 'c1m1_hotel', mode: input.mode || 'coop', difficulty: input.difficulty || 'normal', maxPlayers: input.maxPlayers || 4, tickrate: input.tickrate || 30, autoRestart: false, created: Date.now(), desired: 'stopped' };
    const cfgPath = path.join(root, 'left4dead2/cfg/server.cfg');
    const config = await fs.readFile(cfgPath, 'utf8').catch(() => '');
    const existing = config.match(/^\s*rcon_password\s+"?([^"\r\n]+)"?/m)?.[1]?.trim();
    server.rcon = this.store.encrypt(input.rconPassword || existing || crypto.randomBytes(24).toString('base64url'));
    const processes = await gameProcesses();
    server.process = processes.find(p => p.exe && path.dirname(p.exe).toLowerCase() === root.toLowerCase()) || null;
    return this.store.put('server', server);
  }
  async update(key, input) {
    const server = this.get(key);
    if (input.port && this.store.list('server').some(s => s.id !== key && s.port === input.port)) fail(409, '端口被其他实例使用');
    const { rconPassword, ...fields } = input;
    Object.assign(server, fields);
    if (rconPassword) server.rcon = this.store.encrypt(rconPassword);
    this.store.put('server', server); this.cache.delete(key); return publicServer(server);
  }
  async command(server, command, timeout = 6000) { return rcon({ host: server.bind === '0.0.0.0' ? '127.0.0.1' : server.bind, port: server.port, password: this.store.decrypt(server.rcon), command, timeout }); }
  async status(server, refresh = false) {
    const cache = this.cache.get(server.id); if (!refresh && cache?.expires > Date.now()) return cache.value;
    let info = null, error = '';
    try { info = await queryInfo({ host: server.bind === '0.0.0.0' ? '127.0.0.1' : server.bind, port: server.port, timeout: 900 }); } catch (e) {
      error = e.message;
      try { info = parseRconInfo(await this.command(server, 'status', 1800)); } catch {}
    }
    const proc = server.process ? await processInfo(server.process.pid) : null;
    const processAlive = !!proc && proc.created === server.process.created && proc.exe?.toLowerCase() === server.process.exe?.toLowerCase();
    const value = { ...publicServer(server), state: info ? 'running' : processAlive ? 'unresponsive' : 'stopped', info, processAlive, queryError: error };
    this.cache.set(server.id, { expires: Date.now() + 5000, value }); return value;
  }
  async ensureStopped(server) {
    const status = await this.status(server, true);
    if (status.state !== 'stopped') fail(409, '请先停止服务器，再修改文件或执行安装');
    await this.validateRoot(server.root);
  }
  async control(key, action, context, options = {}) {
    return this.locks.run(key, async () => {
      if (action === 'start') return this.start(key, context);
      if (action === 'stop') return this.stop(key, context, options);
      if (action === 'restart') {
        if (options.countdown) {
          const server = this.get(key);
          await this.command(server, `say "Server restart in ${options.countdown} seconds"`).catch(() => {});
          for (let i = 0; i < options.countdown; i++) { context.signal?.throwIfAborted(); await sleep(1000); }
        }
        await this.stop(key, context, options); return this.start(key, context);
      }
      fail(400, '未知服务器操作');
    });
  }
  async syncRconConfig(server, password) {
    if(!/^[A-Za-z0-9_-]{16,128}$/.test(password))fail(400,'RCON 密码格式无效');
    const relative='left4dead2/cfg/server.cfg',file=await safePath(server.root,relative);
    const previous=await fs.readFile(file,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
    const pattern=/^[ \t]*rcon_password[ \t]+[^\r\n]*/gmi,line=`rcon_password "${password}"`,newline=previous.includes('\r\n')?'\r\n':'\n';
    const next=pattern.test(previous)?previous.replace(pattern,line):previous+(!previous||previous.endsWith('\n')?'':newline)+line+newline;
    if(next!==previous){this.store.put('configVersion',{id:id(),serverId:server.id,path:relative,text:previous,created:Date.now(),user:'system-rcon-sync'});atomicWrite(file,next);}
  }
  async start(key, { update = () => {}, signal } = {}) {
    let server = this.get(key); await this.validateRoot(server.root);
    const state = await this.status(server, true);
    if (state.state !== 'stopped') fail(409, '服务器已经运行或正在启动');
    if (!validMap(server.map)) fail(400, '地图名无效');
    signal?.throwIfAborted();
    const rconPassword = this.store.decrypt(server.rcon);
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(rconPassword)) fail(400, 'RCON 密码需要 16–128 位字母、数字、下划线或短横线，请在实例设置中更新');
    await this.syncRconConfig(server,rconPassword);
    const generated = `// Managed by Safehouse; regenerated on start\nrcon_password "${rconPassword}"\nhostname "${server.name.replace(/[";\r\n]/g, '')}"\nsv_gametypes "${server.mode}"\nz_difficulty "${server.difficulty}"\nsv_lan ${server.bind === '127.0.0.1' ? 1 : 0}\nlog on\n`;
    const cfg = await safePath(server.root, 'left4dead2/cfg/safehouse.cfg'); atomicWrite(cfg, generated);
    const args = ['-norestart','-console', '-game', 'left4dead2', '-condebug', '-nobreakpad', '-strictportbind', '-tickrate', String(server.tickrate || 30), '-ip', server.bind, '-port', String(server.port), '+sv_gametypes', server.mode, '+z_difficulty', server.difficulty, '+maxplayers', String(server.maxPlayers), '+map', server.map, server.mode, '+exec', 'safehouse.cfg'];
    update('正在启动游戏进程', 15);
    let child, pid, spawnError;
    if (process.platform === 'win32') {
      // SRCDS uses ReadConsoleInput; piping stdin causes a fatal CTextConsoleWin32 error.
      // Start-Process gives it a real, hidden console. All user values are data in JSON, never PowerShell source.
      const quote = text => '"' + String(text).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
      const spec = { exe: path.join(server.root, executableName), root: server.root, argumentLine: args.map(quote).join(' ') };
      const script = "$spec = $env:SAFEHOUSE_LAUNCH | ConvertFrom-Json; $p = Start-Process -FilePath $spec.exe -ArgumentList $spec.argumentLine -WorkingDirectory $spec.root -WindowStyle Hidden -PassThru; [pscustomobject]@{pid=[int]$p.Id} | ConvertTo-Json -Compress";
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, SAFEHOUSE_LAUNCH: JSON.stringify(spec) }, windowsHide: true, timeout: 15000 });
      pid = JSON.parse(stdout).pid;
    } else {
      const logFd=fss.openSync(path.join(this.store.dir,'logs',`${key}.log`),'a',0o600);
      try{child = spawn(path.join(server.root, executableName), args, { cwd: server.root, windowsHide: true, stdio: ['ignore',logFd,logFd], detached: true });}
      finally{fss.closeSync(logFd);}
      child.unref();
      pid = child.pid; this.children.set(key, child);
      child.once('error', error => { spawnError = error; });
      child.once('exit', () => { this.children.delete(key); this.cache.delete(key); });
    }
    await sleep(1000);
    if (spawnError) fail(500, `游戏进程启动失败：${spawnError.message}`);
    let identity = await processInfo(pid);
    if (process.platform !== 'win32') {
      for (let i = 0; i < 30; i++) {
        const game = (await gameProcesses()).find(p => p.exe && inside(server.root, p.exe));
        if (game) { identity = game; pid = game.pid; break; }
        if (child?.exitCode !== null) break;
        await sleep(300);
      }
    }
    if (!identity) fail(500, '游戏进程已退出，请查看控制台日志');
    server = this.get(key); server.process = identity; server.desired = 'running'; server.lastStart = Date.now(); this.store.put('server', server);
    for (let i = 0; i < 60; i++) {
      signal?.throwIfAborted();
      if (child && child.exitCode !== null) fail(500, '游戏进程提前退出，请查看控制台日志');
      if (i % 5 === 0 && !await processInfo(pid)) fail(500, '游戏进程提前退出，请查看控制台日志');
      let info = await queryInfo({ host: server.bind === '0.0.0.0' ? '127.0.0.1' : server.bind, port: server.port, timeout: 600 }).catch(() => null);
      if (!info) { try { info = parseRconInfo(await this.command(server, 'status', 1500)); } catch {} }
      if (info) {
        await this.command(server, `hostname "${server.name.replace(/[";\r\n]/g, '')}";sv_gametypes ${server.mode};z_difficulty ${server.difficulty}`, 2500).catch(() => {});
        try { info = parseRconInfo(await this.command(server, 'status', 1500)); } catch {}
      }
      if (info) { update(`游戏服务器已响应：${info.map}`, 100); this.cache.delete(key); return { pid, info }; }
      update('等待游戏加载并响应查询', 20 + i); await sleep(800);
    }
    fail(504, '游戏进程已启动，但未在限定时间内响应；请检查日志');
  }
  async stop(key, { update = () => {} } = {}, { force = false } = {}) {
    const server = this.get(key); server.desired = 'stopped'; this.store.put('server', server);
    const status = await this.status(server, true);
    if (status.state === 'stopped') return { stopped: true };
    update('正在发送正常关闭命令', 20);
    await this.command(server, 'quit', 2500).catch(() => {});
    for (let i = 0; i < 12; i++) {
      const proc = server.process && await processInfo(server.process.pid);
      if (!proc || proc.created !== server.process.created) { this.cache.delete(key); return { stopped: true }; }
      await sleep(750);
    }
    if (!force) fail(409, '服务器未正常退出，可勾选强制结束后重试');
    const actual = server.process && await processInfo(server.process.pid);
    if (!actual || actual.created !== server.process.created || actual.exe?.toLowerCase() !== server.process.exe?.toLowerCase() || !inside(server.root, actual.exe)) fail(409, '无法验证游戏进程身份，已拒绝强制结束');
    process.kill(actual.pid, 'SIGKILL'); update('已结束验证过身份的游戏进程', 90); await sleep(500); this.cache.delete(key);
    return { stopped: true, forced: true };
  }
  async watch() {
    if (this.closing) return;
    for (const server of this.store.list('server')) {
      if (!server.autoRestart || server.desired !== 'running' || this.locks.active.has(server.id) || this.tasks.queue.some(t => t.task.serverId === server.id)) continue;
      const status = await this.status(server, true); if (status.state !== 'stopped') continue;
      const crashes = (server.crashes || []).filter(t => Date.now() - t < 10 * 60000); crashes.push(Date.now()); server.crashes = crashes;
      if (crashes.length > 3) { server.autoRestart = false; this.store.audit('system', 'server.crash_loop_stopped', server.id); }
      this.store.put('server', server);
      if (server.autoRestart) this.tasks.create('自动恢复', server.id, 'system', ctx => this.control(server.id, 'start', ctx));
    }
  }
  async players(key) { return parseStatus(await this.command(this.get(key), 'status')); }
  async logs(key) {
    const server = this.get(key), candidates = [path.join(this.store.dir, 'logs', `${key}.log`), await safePath(server.root, 'left4dead2/console.log')];
    const result = [];
    for (const file of candidates) {
      const handle = await fs.open(file, 'r').catch(() => null); if (!handle) continue;
      try { const stat = await handle.stat(), buffer = Buffer.alloc(Math.min(stat.size, 200000)); await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length)); result.push(redact(buffer.toString())); } finally { await handle.close(); }
    }
    return result.join('\n').slice(-300000);
  }
  close() { this.closing = true; clearInterval(this.monitor); }
}
