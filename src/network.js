import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AppError, fail } from './core.js';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { ensureFileSpace, diskSpaceGuard } from './disk-space.js';

const domains = ['api.steampowered.com', 'media.steampowered.com', 'steamcommunity.com', 'steamcdn-a.akamaihd.net', 'steamusercontent.com', 'steamstatic.com','steamuserimages-a.akamaihd.net'];
export function publicAddress(ip) {
  if (net.isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  return net.isIP(ip) === 6 && /^[23]/.test(ip) && !/^2001:(?:db8|0:)/i.test(ip);
}
export function steamURL(input) {
  let url; try { url = new URL(input); } catch { fail(400, '下载地址格式错误'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !domains.some(d => url.hostname === d || url.hostname.endsWith(`.${d}`))) fail(400, '只允许 Steam 官方 HTTPS 下载来源');
  return url;
}
export function steamAddressOverrides(host, raw=process.env.STEAM_DNS_OVERRIDES||'') {
  if(!raw)return null;
  let config;try{config=JSON.parse(raw);}catch{fail(500,'STEAM_DNS_OVERRIDES 必须是有效 JSON');}
  const entries=config[host];if(entries===undefined)return null;
  steamURL(`https://${host}/`);
  if(!Array.isArray(entries)||!entries.length||entries.length>8||entries.some(ip=>typeof ip!=='string'||!publicAddress(ip)))fail(500,'Steam DNS 覆盖只能包含公网 IP 地址');
  return entries.map(address=>({address,family:net.isIP(address)}));
}
const routeOffsets=new Map();
function lookup(host, options, cb) {
  try{const overrides=steamAddressOverrides(host);if(overrides){const offset=(routeOffsets.get(host)||0)%overrides.length;routeOffsets.set(host,offset+1);const ordered=[...overrides.slice(offset),...overrides.slice(0,offset)];if(options.all)cb(null,ordered);else cb(null,ordered[0].address,ordered[0].family);return;}}catch(error){cb(error);return;}
  dns.lookup(host, { all: true }, (err, addresses) => {
    if (err) return cb(err);
    const allowed = ip => publicAddress(ip) || (process.env.STEAM_FAKE_DNS === '1' && /^198\.(18|19)\./.test(ip));
    if (!addresses.length || addresses.some(a => !allowed(a.address))) return cb(new Error('阻止访问非公网下载地址（如使用 TUN Fake-IP 代理，请在本机显式配置 STEAM_FAKE_DNS=1）'));
    if (options.all) cb(null, addresses); else cb(null, addresses[0].address, addresses[0].family);
  });
}
export function requestSteam(input, { method = 'GET', body, signal, headers = {}, redirects = 0, timeout = 30000 } = {}) {
  const url = steamURL(input);
  const agent=process.env.STEAM_PROXY_URL?new HttpsProxyAgent(process.env.STEAM_PROXY_URL):false;
  return new Promise((resolve, reject) => {
    const omitSni=(process.env.STEAM_TLS_NO_SNI_HOSTS||'').split(',').map(s=>s.trim()).includes(url.hostname);
    const req = https.request(url, { method, lookup:agent?undefined:lookup,agent, signal, ...(omitSni?{servername:''}:{}),checkServerIdentity:(_,certificate)=>tls.checkServerIdentity(url.hostname,certificate), headers: { 'User-Agent': 'SafehouseL4D2/1.0 (+server-administration)', 'Accept-Encoding': 'identity', ...(body!==undefined?{'Content-Length':Buffer.byteLength(body)}:{}),...headers } }, res => {
      clearTimeout(headerTimer);
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        res.resume();
        if (redirects >= 4) return reject(new AppError(502, '下载重定向过多'));
        try { resolve(requestSteam(new URL(res.headers.location, url), { method: res.statusCode === 303 ? 'GET' : method, body: res.statusCode === 303 ? undefined : body, signal, headers, redirects: redirects + 1, timeout })); } catch (e) { reject(e); }
        return;
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new AppError(502, `Steam 返回 HTTP ${res.statusCode}`)); }
      resolve(res);
    });
    const headerTimer=setTimeout(()=>req.destroy(new AppError(504,'Steam 连接或响应超时，请检查服务器到 Steam 的网络')),timeout);headerTimer.unref();
    req.once('close',()=>clearTimeout(headerTimer));
    req.setTimeout(timeout, () => req.destroy(new AppError(504, 'Steam 网络请求超时')));
    req.on('error', error => {clearTimeout(headerTimer);reject(error instanceof AppError?error:error.name === 'AbortError' ? new AppError(409, '任务已取消') : new AppError(502, `Steam 网络请求失败：${error.message||error.code||'连接失败'}`));});
    req.end(body);
  });
}
export async function steamText(url, options = {}) {
  const {attempts=2,timeout=12000,signal:caller,...requestOptions}=options;
  for(let attempt=0;attempt<attempts;attempt++){
    const deadline=AbortSignal.timeout(timeout),signal=caller?AbortSignal.any([caller,deadline]):deadline;
    try{
      const response=await requestSteam(url,{...requestOptions,timeout,signal});
      const chunks=[];let size=0;
      for await(const chunk of response){size+=chunk.length;if(size>8*1024**2){response.destroy();fail(502,'Steam 响应超过限制');}chunks.push(chunk);}
      signal.throwIfAborted();return Buffer.concat(chunks).toString('utf8');
    }catch(error){
      if(deadline.aborted&&!caller?.aborted)error=new AppError(504,'Steam 详情读取超时，请稍后重试');
      if(attempt===attempts-1||caller?.aborted||![502,504].includes(error.status)||/HTTP \d+/.test(error.message))throw error;
      await new Promise(r=>setTimeout(r,400));
    }
  }
}
export async function steamJSON(url, options = {}) {
  const text = await steamText(url, options);
  try { return JSON.parse(text); } catch { fail(502, 'Steam 返回了无法解析的数据'); }
}
export async function downloadSteam(url, destination, { maxBytes = 2 * 1024 ** 3, signal, onProgress = () => {} } = {}) {
  const response = await requestSteam(url, { signal, timeout: 120000 });
  const total = Number(response.headers['content-length'] || 0); let received = 0, last = 0;
  if (total > maxBytes) { response.destroy(); fail(400, '文件大小超出安装限制'); }
  try { await ensureFileSpace(destination, total); } catch (error) { response.destroy(); throw error; }
  const guard = new Transform({ transform(chunk, encoding, callback) { received += chunk.length; if (received > maxBytes) return callback(new AppError(400, '文件大小超出安装限制')); if (Date.now() - last > 400) { last = Date.now(); onProgress(received, total); } callback(null, chunk); } });
  await pipeline(response, guard, diskSpaceGuard(destination), fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal });
  onProgress(received, total); return { received, total };
}
