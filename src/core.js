import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export class AppError extends Error {
  constructor(status, message, code = 'REQUEST_FAILED') { super(message); this.status = status; this.code = code; }
}
export const fail = (status, message, code) => { throw new AppError(status, message, code); };
export const id = () => crypto.randomUUID();
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${id()}.tmp`;
  try { fs.writeFileSync(temp, content, { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function redact(text) {
  return String(text).replace(/\b(rcon_password|sv_password|password|api[_-]?key|token|secret)("?\s*[=:]?\s*)("[^"]*"|[^\s,}]+)/gi, (all,key,separator,value) => `${key}${separator}${value.startsWith('"')?'"[REDACTED]"':'[REDACTED]'}`).slice(-300000);
}
export function inside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
export function safeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 500 || /[\x00-\x1f:\\]/.test(relative)) fail(400, '不安全的文件路径');
  const parts = relative.split('/');
  if (relative.startsWith('/') || parts.some(x => !x || x === '.' || x === '..' || /[. ]$/.test(x) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(x))) fail(400, '不安全的文件路径');
  return parts.join(path.sep);
}
export async function safePath(root, relative, { allowMissing = true } = {}) {
  const target = path.resolve(root, safeRelative(relative));
  if (!inside(root, target)) fail(400, '路径超出授权目录');
  const realRoot = await fsp.realpath(root).catch(() => fail(400, '授权目录不存在'));
  let current = path.resolve(root);
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    const st = await fsp.lstat(current).catch(e => { if (e.code === 'ENOENT' && allowMissing) return null; throw e; });
    if (!st) continue;
    if (st.isSymbolicLink()) fail(400, '禁止符号链接或目录联接');
    const real = await fsp.realpath(current);
    if (!inside(realRoot, real)) fail(400, '文件路径逃逸');
  }
  return target;
}
export async function walk(root, { depth = 5, limit = 10000, filter = () => true } = {}) {
  const out = []; let seen = 0;
  async function visit(dir, d) {
    if (d < 0) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (++seen > limit) fail(413, '扫描条目超过安全限制，请缩小目录范围');
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !/^(node_modules|\.git|Windows|System Volume Information|\$Recycle\.Bin)$/i.test(entry.name)) await visit(full, d - 1);
      else if (entry.isFile() && filter(full)) out.push(full);
    }
  }
  await visit(root, depth); return out;
}
export async function diskFree(dir) { const v = await fsp.statfs(dir); return Number(v.bavail) * Number(v.bsize); }
export async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export class Locks {
  constructor() { this.active = new Set(); }
  async run(key, fn) {
    if (this.active.has(key)) fail(409, '该服务器有任务正在执行，请等待完成');
    this.active.add(key); try { return await fn(); } finally { this.active.delete(key); }
  }
}
export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(process.env.PANEL_DATA || path.join(projectRoot, 'data'));
  const origin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.PORT || 8787}`;
  const host = process.env.HOST || '127.0.0.1';
  const publicMode = !!process.env.PUBLIC_ORIGIN;
  if (!['127.0.0.1', '::1', 'localhost'].includes(host) && !publicMode) throw new Error('非回环监听必须配置 PUBLIC_ORIGIN=https://你的域名');
  if (publicMode && new URL(origin).protocol !== 'https:') throw new Error('公网模式必须使用 HTTPS');
  if (new URL(origin).origin !== origin) throw new Error('PUBLIC_ORIGIN 只能包含协议、域名及端口');
  return {
    host, port: Number(process.env.PORT || 8787), origin, publicMode, dataDir,
    trustProxy: process.env.TRUST_PROXY || false,
    steamcmd: process.env.STEAMCMD_PATH || path.join(dataDir, 'tools', process.platform === 'win32' ? 'steamcmd.exe' : 'steamcmd.sh'),
    steamApiKey: process.env.STEAM_API_KEY || '',
    depotDownloader:process.env.DEPOT_DOWNLOADER_PATH?path.resolve(process.env.DEPOT_DOWNLOADER_PATH):'',dotnet:process.env.DOTNET_PATH||(process.platform==='win32'?'dotnet.exe':'dotnet'),
    allowedRoots: (process.env.ALLOWED_ROOTS || path.join(dataDir, 'servers')).split(';').filter(Boolean).map(p => path.resolve(p)),
    uploadLimit: 2 * 1024 ** 3, sessionMs: 8 * 3600000, ...overrides
  };
}
export const hostMetrics = async dataDir => ({ cpuCount: os.cpus().length, cpuModel: os.cpus()[0]?.model, load: os.loadavg(), memoryTotal: os.totalmem(), memoryUsed: os.totalmem() - os.freemem(), diskFree: await diskFree(dataDir), uptime: os.uptime(), platform: process.platform });
