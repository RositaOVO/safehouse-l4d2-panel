import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { AppError, fail, sha256 } from './core.js';

const scrypt = promisify(crypto.scrypt);
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 14 || password.length > 256) fail(400, '密码必须为 14–256 个字符');
  const salt = crypto.randomBytes(16).toString('hex');
  const result = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
  return `scrypt$${salt}$${result.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 256 || !encoded) return false;
  const [, salt, hash] = encoded.split('$');
  if (!salt || !hash) return false;
  const result = await scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 ** 2 });
  const expected = Buffer.from(hash, 'hex');
  return expected.length === result.length && crypto.timingSafeEqual(result, expected);
}
export const roles = {
  viewer: ['read'],
  operator: ['read', 'control', 'players', 'console'],
  maintainer: ['read', 'control', 'players', 'console', 'maps', 'plugins', 'config', 'backup'],
  owner: ['*']
};
export function authorize(user, permission, serverId) {
  if (!user) fail(401, '请先登录');
  if (!roles[user.role]?.includes('*') && !roles[user.role]?.includes(permission)) fail(403, '此账号没有该操作权限');
  if (serverId && user.role !== 'owner' && !JSON.parse(user.servers || '[]').includes(serverId)) fail(403, '此账号没有该服务器权限');
}
export function parseCookies(value = '') {
  return Object.fromEntries(value.split(';').map(s => s.trim().split('=')).filter(p => p.length === 2));
}
export function sessionAuth(store) {
  return (req, res, next) => {
    const raw = parseCookies(req.headers.cookie).safehouse;
    if (raw && /^[a-f0-9]{64}$/.test(raw)) {
      const session = store.db.prepare('SELECT * FROM sessions WHERE id=? AND expires>?').get(sha256(raw), Date.now());
      if (session) { req.session = session; req.user = store.user(session.user_id); }
    }
    next();
  };
}
export function csrfGuard(config) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (req.headers.origin !== config.origin) return next(new AppError(403, '请求来源验证失败'));
    if (req.path === '/auth/login') return next();
    if (!req.session || req.headers['x-csrf-token'] !== req.session.csrf) return next(new AppError(403, '请求验证令牌无效，请刷新后重试'));
    next();
  };
}
export function rateLimit(store, key, limit = 8, windowMs = 15 * 60000) {
  if(key==='global-login')store.db.prepare('DELETE FROM login_attempts WHERE reset<?').run(Date.now()-24*3600000);
  const row = store.db.prepare('SELECT * FROM login_attempts WHERE key=?').get(key), now = Date.now();
  if (row && row.reset > now && row.count >= limit) fail(429, '尝试次数过多，请稍后再试');
  store.db.prepare('INSERT OR REPLACE INTO login_attempts(key,count,reset) VALUES(?,?,?)').run(key, row?.reset > now ? row.count + 1 : 1, row?.reset > now ? row.reset : now + windowMs);
}
export function newSession(store, user, ms) {
  const raw = crypto.randomBytes(32).toString('hex'), csrf = crypto.randomBytes(32).toString('hex');
  store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  store.db.prepare('INSERT INTO sessions(id,user_id,csrf,expires,created) VALUES(?,?,?,?,?)').run(sha256(raw), user.id, csrf, Date.now() + ms, Date.now());
  return { raw, csrf };
}
