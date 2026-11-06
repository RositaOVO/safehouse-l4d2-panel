import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import { ensureFileSpace, diskSpaceGuard } from './disk-space.js';
import fsp from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, fail } from './core.js';
import { publicAddress, steamAddressOverrides } from './network.js';

export function directURL(input) {
  let url; try { url = new URL(input); } catch { fail(400, '直链格式错误'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) || !host.includes('.') && !net.isIP(host) || host.endsWith('.local') || host === 'localhost' || net.isIP(host) && !publicAddress(host)) fail(400, '直链只允许公网 HTTP / HTTPS 标准端口，禁止内网、凭据和片段');
  return url;
}
export async function directAddresses(host, resolve = name => steamAddressOverrides(name) || dns.lookup(name, { all: true })) {
  const literal = host.replace(/^\[|\]$/g, '');
  let timer;
  let addresses;
  try { addresses = net.isIP(literal) ? [{ address: literal, family: net.isIP(literal) }] : await Promise.race([resolve(host),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new AppError(504,'直链 DNS 解析超时')),10000);timer.unref();})]); }
  finally { clearTimeout(timer); }
  if (!addresses.length || addresses.some(a => !publicAddress(a.address) || /^2002:/i.test(a.address))) fail(400, '直链 DNS 包含非公网地址，已阻止访问');
  return addresses;
}
export async function requestDirect(input, { signal, redirects = 0 } = {}) {
  const url = directURL(input);
  signal?.throwIfAborted();
  const addresses = await directAddresses(url.hostname);
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get(url, { agent: false, signal, lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family), headers: { 'User-Agent': 'SafehouseL4D2/1.0', 'Accept-Encoding': 'identity' } }, response => {
      clearTimeout(timer);
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 4) return reject(new AppError(502, '直链重定向超过 4 次'));
        try {
          const next = directURL(new URL(response.headers.location, url));
          if (url.protocol === 'https:' && next.protocol !== 'https:') return reject(new AppError(400, '禁止 HTTPS 直链降级到 HTTP'));
          resolve(requestDirect(next, { signal, redirects: redirects + 1 }));
        } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new AppError(502, `直链返回 HTTP ${response.statusCode}`)); return; }
      resolve(response);
    });
    const timer = setTimeout(() => request.destroy(new AppError(504, '直链连接或响应超时')), 45000); timer.unref();
    request.on('close', () => clearTimeout(timer));
    request.setTimeout(120000, () => request.destroy(new AppError(504, '直链下载无响应超时')));
    request.on('error', error => reject(error instanceof AppError ? error : new AppError(error.name === 'AbortError' ? 409 : 502, error.name === 'AbortError' ? '任务已取消' : '直链连接失败，请检查下载站点、证书或网络')));
  });
}
export async function downloadDirect(input, destination, { maxBytes, signal, onProgress = () => {}, request = requestDirect } = {}) {
  directURL(input);
  const response = await request(input, { signal });
  const total = Number(response.headers['content-length'] || 0);
  let received = 0, last = 0;
  if (total > maxBytes) { response.destroy(); fail(400, '直链文件超过安装大小限制'); }
  try { await ensureFileSpace(destination, total); } catch (error) { response.destroy(); throw error; }
  const guard = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    if (received > maxBytes) return callback(new AppError(400, '直链文件超过安装大小限制'));
    if (Date.now() - last > 400) { last = Date.now(); onProgress(received, total); }
    callback(null, chunk);
  } });
  const deadline = setTimeout(() => response.destroy(new AppError(504, '直链下载超过 2 小时')), 2 * 3600000); deadline.unref();
  try {
    await pipeline(response, guard, diskSpaceGuard(destination), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
    const file = await fsp.open(destination, 'r');
    const magic = Buffer.alloc(4); try { await file.read(magic, 0, 4, 0); } finally { await file.close(); }
    const extension = magic.equals(Buffer.from([0x34,0x12,0xaa,0x55])) ? 'vpk' : magic.equals(Buffer.from([0x50,0x4b,0x03,0x04])) ? 'zip' : null;
    if (!extension) fail(400, '直链返回的不是 VPK / ZIP，可能是网页、网盘分享页或登录页面');
    onProgress(received, total);
    return { received, extension };
  } catch (error) { await fsp.rm(destination, { force: true }); throw error; }
  finally { clearTimeout(deadline); }
}
