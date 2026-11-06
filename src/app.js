import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Store } from './store.js';
import { Tasks } from './tasks.js';
import { Servers, publicServer, validMap } from './servers.js';
import { Workshop, workshopId } from './workshop.js';
import { Content } from './content.js';
import { Configuration } from './configuration.js';
import { Scheduler } from './scheduler.js';
import { scanExistingMaps,diagnostics,notifications } from './operations.js';
import {Previews}from'./previews.js';
import {Maintenance}from'./maintenance.js';
import {directURL}from'./direct-download.js';
import {sendAnnouncement}from'./announcements.js';
import { UploadReservations, DISK_RESERVE } from './disk-space.js';
import { AppError, fail, id, sha256, projectRoot, hostMetrics, diskFree, redact } from './core.js';
import { authorize, sessionAuth, csrfGuard, rateLimit, hashPassword, verifyPassword, newSession, roles } from './security.js';

const nameSchema = z.string().trim().min(1).max(80).regex(/^[^";\\\r\n\x00-\x1f]+$/);
const serverSchema = z.object({ name: nameSchema, root: z.string().min(3).max(500), port: z.number().int().min(1024).max(65535).default(27015), bind: z.enum(['127.0.0.1', '0.0.0.0']).default('127.0.0.1'), map: z.string().refine(validMap).default('c1m1_hotel'), mode: z.enum(['coop', 'versus', 'survival', 'realism', 'scavenge']).default('coop'), difficulty: z.enum(['easy', 'normal', 'hard', 'impossible']).default('normal'), maxPlayers: z.number().int().min(1).max(32).default(4), tickrate: z.number().int().min(10).max(128).default(30), rconPassword: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional() });
const editServerSchema = z.object({ name: nameSchema.optional(), port: z.number().int().min(1024).max(65535).optional(), bind: z.enum(['127.0.0.1','0.0.0.0']).optional(), map: z.string().refine(validMap).optional(), mode: z.enum(['coop','versus','survival','realism','scavenge']).optional(), difficulty: z.enum(['easy','normal','hard','impossible']).optional(), maxPlayers: z.number().int().min(1).max(32).optional(), tickrate: z.number().int().min(10).max(128).optional(), rconPassword: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/).optional(), autoRestart: z.boolean().optional() });
const username = z.string().min(3).max(40).regex(/^[a-zA-Z0-9_.-]+$/);
const parse = (schema, value) => { const result = schema.safeParse(value); if (!result.success) fail(400, `参数错误：${result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('；')}`); return result.data; };

export async function createApp(config) {
  const previews=new Previews();
  const store = new Store(config.dataDir), tasks = new Tasks(store), servers = new Servers(config, store, tasks), workshop = new Workshop(config, store), content = new Content(config, store, servers, workshop), configuration = new Configuration(store, servers, content), scheduler = new Scheduler(store, tasks, servers, content);
  const maintenance=new Maintenance(config,store,servers,{workshop,previews});
  store.recoverTasks();
  for(const file of await fs.readdir(path.join(config.dataDir,'uploads'),{withFileTypes:true}))if(file.isFile()&&/^[a-f0-9]{32}$/.test(file.name))await fs.rm(path.join(config.dataDir,'uploads',file.name),{force:true});
  await servers.initialize(); await content.recover(); scheduler.start();
  const app = express(); app.disable('x-powered-by');
  if (config.trustProxy) { if (config.trustProxy !== 'loopback') throw new Error('TRUST_PROXY 只允许 loopback；请让本机反向代理终止 TLS'); app.set('trust proxy', 'loopback'); }
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https://*.steamusercontent.com', 'https://*.steamstatic.com', 'https://steamuserimages-a.akamaihd.net'], connectSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"], formAction: ["'self'"], upgradeInsecureRequests: config.publicMode ? [] : null } }, strictTransportSecurity: config.publicMode ? { maxAge: 31536000, includeSubDomains: true } : false, crossOriginEmbedderPolicy: false }));
  app.use((req, res, next) => {
    const allowedHost = new URL(config.origin).host;
    if (req.get('host') !== allowedHost && !config.testMode) return next(new AppError(403, 'Host 验证失败'));
    if (config.publicMode && !req.secure) return next(new AppError(400, '公网模式仅接受 HTTPS，请检查本机反向代理'));
    res.setHeader('Cache-Control', 'no-store'); next();
  });
  app.get('/healthz', (req, res) => res.json({ status: 'ok', version: '1.0.0' }));
  app.use('/api', express.json({ limit: '1200kb', type: 'application/json' }), sessionAuth(store), csrfGuard(config));
  const api = express.Router();
  const secureCookie = raw => ({ httpOnly: true, sameSite: 'strict', secure: config.publicMode, path: '/', maxAge: config.sessionMs });
  function audit(req, action, target = '', detail = {}) { store.audit(req.user?.id || 'anonymous', action, target, detail); }
  function permitted(permission, server = false) { return (req, res, next) => { try { authorize(req.user, permission, server ? req.params.sid : undefined); next(); } catch (e) { next(e); } }; }
  function recentAuth(req, res, next) { if (!req.session || Date.now() - req.session.created > 10 * 60000) return next(new AppError(403, '此敏感操作需要重新验证密码，请在安全中心完成验证')); next(); }
  function safeTask(task) { return task; }
  const visible = (user, sid) => user.role === 'owner' || JSON.parse(user.servers || '[]').includes(sid);
  function queued(req, res, type, sid, run,onCancel) { const task = tasks.create(type, sid, req.user.id, run,onCancel); audit(req, `task.queued`, sid, { type, taskId: task.id }); res.status(202).json(safeTask(task)); }

  api.post('/auth/login', async (req, res) => {
    rateLimit(store,'global-login',60,60000);
    const input = parse(z.object({ username, password: z.string().max(256), code: z.string().max(8).optional() }), req.body);
    rateLimit(store, `ip:${sha256(req.ip)}`, 30); rateLimit(store, `name:${input.username.toLowerCase()}`, 10);
    const user = store.userByName(input.username);
    const valid = user && await verifyPassword(input.password, user.password);
    if (!valid) { store.audit('anonymous', 'auth.login_failed', '', { ip: req.ip }); fail(401, '用户名或密码不正确'); }
    store.db.prepare('DELETE FROM login_attempts WHERE key=?').run(`name:${input.username.toLowerCase()}`);
    const session = newSession(store, user, config.sessionMs);
    res.cookie('safehouse', session.raw, secureCookie(session.raw));
    store.audit(user.id, 'auth.login', '', { ip: req.ip });
    res.json({ csrf: session.csrf, user: { id: user.id, name: user.name, role: user.role } });
  });
  api.get('/auth/me', (req, res) => {
    if (!req.user) return res.status(401).json({ error: '请先登录', code: 'UNAUTHENTICATED' });
    res.json({ user: { id: req.user.id, name: req.user.name, role: req.user.role, servers: JSON.parse(req.user.servers) }, csrf: req.session.csrf, publicMode: config.publicMode });
  });
  api.use((req, res, next) => { if (!req.user) return next(new AppError(401, '请先登录')); next(); });
  api.post('/auth/logout', (req, res) => { store.db.prepare('DELETE FROM sessions WHERE id=?').run(req.session.id); res.clearCookie('safehouse', { path: '/' }); res.json({ ok: true }); });
  api.post('/auth/reauth', async (req, res) => {
    rateLimit(store, `reauth:${req.user.id}`, 10);
    if (!await verifyPassword(req.body.password, req.user.password)) fail(401, '密码不正确');
    store.db.prepare('UPDATE sessions SET created=? WHERE id=?').run(Date.now(), req.session.id); res.json({ ok: true });
  });
  api.post('/auth/password', async (req, res) => {
    rateLimit(store, `password:${req.user.id}`, 8);
    if (!await verifyPassword(req.body.current, req.user.password)) fail(401, '原密码不正确');
    const hash = await hashPassword(req.body.password);
    store.db.prepare('UPDATE users SET password=? WHERE id=?').run(hash, req.user.id);
    store.db.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').run(req.user.id, req.session.id);
    audit(req, 'auth.password_changed'); res.json({ ok: true });
  });
  api.get('/auth/sessions', (req, res) => res.json(store.db.prepare('SELECT id,created,expires FROM sessions WHERE user_id=?').all(req.user.id).map(s => ({ ...s, current: s.id === req.session.id }))));
  api.delete('/auth/sessions/:id', (req, res) => { store.db.prepare('DELETE FROM sessions WHERE id=? AND user_id=?').run(req.params.id, req.user.id); res.json({ ok: true }); });

  api.get('/maintenance',permitted('*'),async(req,res)=>res.json(await maintenance.status()));
  api.post('/maintenance/preview',permitted('*'),async(req,res)=>{const input=parse(z.object({logsDays:z.number().int().min(7).max(365).default(14),steamCache:z.boolean().default(false)}),req.body);res.json(await maintenance.preview(req.user.id,input));});
  api.post('/maintenance/clean',permitted('*'),recentAuth,(req,res)=>{const input=parse(z.object({planId:z.string().uuid()}),req.body);maintenance.assertIdle();queued(req,res,'磁盘清理','',ctx=>maintenance.clean(input.planId,req.user.id,ctx));});
  api.post('/maintenance/memory',permitted('*'),recentAuth,(req,res)=>{const input=parse(z.object({mode:z.enum(['panel','kernel'])}),req.body);queued(req,res,'内存清理','',ctx=>maintenance.memory(input.mode,req.user.id,ctx));});
  api.get('/overview', permitted('read'), async (req, res) => {
    const list = store.list('server').filter(s => visible(req.user, s.id));
    const states = await Promise.all(list.map(s => servers.status(s)));
    const taskList = store.list('task').filter(t => !t.serverId ? req.user.role === 'owner' : visible(req.user, t.serverId)).sort((a, b) => b.created - a.created);
    res.json({ servers: states, metrics: await hostMetrics(config.dataDir), tasks: taskList.slice(0, 8), maps: store.list('map').filter(m => visible(req.user, m.serverId)).length, mode: config.publicMode ? 'public' : 'local', version: '1.0.0' });
  });
  api.get('/servers', permitted('read'), async (req, res) => res.json(await Promise.all(store.list('server').filter(s => visible(req.user, s.id)).map(s => servers.status(s)))));
  api.post('/discovery', permitted('*'), async (req, res) => { rateLimit(store, 'discovery', 10, 60000); res.json(await servers.discover()); });
  api.post('/servers', permitted('*'), async (req, res) => { const server = await servers.register(parse(serverSchema, req.body)); audit(req, 'server.registered', server.id); res.status(201).json(publicServer(server)); });
  api.post('/server-install', permitted('*'), (req, res) => { const input = parse(serverSchema, req.body); queued(req, res, '安装 L4D2 服务端', '', ctx => content.installServer(input, ctx)); });
  api.patch('/servers/:sid', permitted('*', true), async (req, res) => { const input = parse(editServerSchema, req.body); const result = await servers.locks.run(req.params.sid, () => servers.update(req.params.sid, input)); audit(req, 'server.settings', req.params.sid, { fields: Object.keys(input).filter(k => !/password/i.test(k)) }); res.json(result); });
  api.post('/servers/:sid/control', permitted('control', true), (req, res) => {
    const input = parse(z.object({ action: z.enum(['start', 'stop', 'restart']), countdown: z.number().int().min(0).max(300).default(0), force: z.boolean().default(false) }), req.body);
    if (input.force) authorize(req.user, '*', req.params.sid);
    queued(req, res, `服务器 ${input.action}`, req.params.sid, ctx => servers.control(req.params.sid, input.action, ctx, input));
  });
  api.post('/servers/:sid/update', permitted('*', true), (req, res) => queued(req, res, '更新服务端', req.params.sid, ctx => content.updateServer(req.params.sid, ctx)));
  api.get('/servers/:sid/logs', permitted('console', true), async (req, res) => res.json({ text: await servers.logs(req.params.sid) }));
  api.post('/servers/:sid/console', permitted('console', true), async (req, res) => {
    const { command } = parse(z.object({ command: z.string().min(1).max(1000).regex(/^[^\r\n\0]+$/) }), req.body);
    if (req.user.role !== 'owner' && !/^(status|stats|version|sm version|sm plugins list|sm exts list|meta list)$/.test(command)) fail(403, '此账号只能执行状态查询命令；其他操作请使用对应功能页');
    const output = await servers.command(servers.get(req.params.sid), command); audit(req, 'console.command', req.params.sid, { command: redact(command) }); res.json({ output: redact(output) });
  });
  api.post('/servers/:sid/map-change', permitted('control', true), async (req, res) => {
    const { map } = parse(z.object({ map: z.string().refine(validMap) }), req.body);
    const output = await servers.command(servers.get(req.params.sid), `changelevel ${map}`); audit(req, 'server.changelevel', req.params.sid, { map }); res.json({ output });
  });
  api.get('/servers/:sid/players', permitted('players', true), async (req, res) => res.json(await servers.players(req.params.sid)));
  api.post('/servers/:sid/players/action', permitted('players', true), async (req, res) => {
    const input = parse(z.object({ action: z.enum(['kick', 'ban', 'unban', 'say']), userid: z.number().int().min(1).max(1000000).optional(), steamId: z.string().regex(/^STEAM_[0-5]:[01]:\d{1,14}$/).optional(), minutes: z.number().int().min(0).max(525600).default(30), message: z.string().max(200).optional(),channel:z.enum(['chat','hint','center','both']).default('both') }), req.body);
    let command;
    if (input.action === 'say') {const result=await sendAnnouncement(servers,servers.get(req.params.sid),input.message,input.channel);audit(req,'player.say',req.params.sid,{message:input.message,channel:input.channel,commands:result.results.map(x=>x.command)});return res.json(result);}
    else if (input.action === 'kick') { if (!input.userid) fail(400, '缺少玩家编号'); command = `kickid ${input.userid}`; }
    else { if (!input.steamId) fail(400, '缺少合法 SteamID'); command = input.action === 'ban' ? `banid ${input.minutes} ${input.steamId} kick;writeid` : `removeid ${input.steamId};writeid`; }
    const output = await servers.command(servers.get(req.params.sid), command); audit(req, `player.${input.action}`, req.params.sid, input); res.json({ output });
  });

  api.get('/workshop/preview',permitted('read'),async(req,res)=>{rateLimit(store,`preview:${req.ip}`,180,60000);const item=await previews.get(req.query.url);res.set('Cache-Control','private, max-age=1800').type(item.type).send(item.body);});
  api.get('/workshop/search', permitted('read'), async (req, res) => {
    rateLimit(store, `search:${req.user.id}`, 40, 60000);
    const input = parse(z.object({ q: z.string().max(120).default(''), sort: z.enum(['popular', 'recent', 'updated', 'relevance']).default('popular'), page: z.coerce.number().int().min(1).max(100).default(1), tag: z.string().max(50).default('') }), req.query);
    res.json(await workshop.search(input));
  });
  api.post('/workshop/resolve', permitted('read'), async (req, res) => { rateLimit(store, `resolve:${req.user.id}`, 30, 60000); const { input,refresh } = parse(z.object({ input: z.string().max(2000),refresh:z.boolean().default(false) }), req.body); res.json(await workshop.resolve(input,{refresh})); });
  api.get('/servers/:sid/maps', permitted('read', true), (req, res) => res.json(store.list('map').filter(m => m.serverId === req.params.sid).map(({ resources, ...m }) => m)));
  api.post('/servers/:sid/maps/install', permitted('maps', true), (req, res) => { const pid = workshopId(req.body.id); queued(req, res, '安装工坊地图', req.params.sid, ctx => content.installMap(req.params.sid, { workshopId: pid }, ctx)); });
  api.post('/servers/:sid/maps/direct', permitted('maps', true), (req,res)=>{
    rateLimit(store, `direct:${req.user.id}`, 10, 60000);
    const input=parse(z.object({url:z.string().min(8).max(4000),filename:z.string().trim().max(160).refine(s=>!s||/^[^<>:"/\\|?*\x00-\x1f]+\.(vpk|zip)$/i.test(s),'文件名必须是安全的 VPK / ZIP 文件名').optional(),sha256:z.string().trim().regex(/^([a-fA-F0-9]{64})?$/).optional()}),req.body);
    directURL(input.url);
    queued(req,res,'直链下载地图',req.params.sid,ctx=>content.installMap(req.params.sid,{directUrl:input.url,filename:input.filename,checksum:input.sha256},ctx));
  });
  api.post('/servers/:sid/maps/check-updates', permitted('maps', true), (req, res) => queued(req, res, '检查地图更新', req.params.sid, () => content.checkMapUpdates(req.params.sid)));
  api.post('/servers/:sid/maps/scan', permitted('maps', true), (req,res)=>queued(req,res,'扫描并接管已有地图',req.params.sid,ctx=>scanExistingMaps(req.params.sid,store,servers,ctx)));
  api.get('/servers/:sid/maps/versions', permitted('read', true), (req, res) => res.json(store.list('mapVersion').filter(v => v.serverId === req.params.sid && v.mapId === req.query.id).map(({ resources, ...v }) => v).sort((a,b) => b.created-a.created)));
  api.post('/servers/:sid/maps/rollback', permitted('maps', true), (req, res) => queued(req, res, '回滚地图版本', req.params.sid, ctx => content.rollbackMap(req.params.sid, String(req.body.id), ctx)));
  api.post('/servers/:sid/maps/action', permitted('maps', true), (req, res) => { const input = parse(z.object({ id: z.string().max(120), action: z.enum(['enable', 'disable', 'uninstall']) }), req.body); queued(req, res, `地图 ${input.action}`, req.params.sid, () => content.mapAction(req.params.sid, input.id, input.action)); });
  api.get('/servers/:sid/plugins', permitted('read', true), async (req, res) => res.json(await content.plugins(req.params.sid)));
  api.post('/servers/:sid/plugins/toggle', permitted('plugins', true), async (req, res) => { const input = parse(z.object({ file: z.string().max(300), enabled: z.boolean() }), req.body); const result = await content.pluginToggle(req.params.sid, input.file, input.enabled); audit(req, 'plugin.toggle', req.params.sid, input); res.json(result); });
  api.get('/servers/:sid/packages', permitted('plugins', true), (req, res) => res.json(store.list('package').filter(p => p.serverId === req.params.sid)));
  api.post('/servers/:sid/packages/rollback', permitted('plugins', true), async (req, res) => {
    const pkg = store.get('package', req.body.id); if (!pkg || pkg.serverId !== req.params.sid) fail(404, '安装记录不存在');
    const tx = store.get('transaction', pkg.transaction); if (!tx || tx.state !== 'committed') fail(409, '此安装记录无法回滚');
    queued(req, res, '回滚插件安装', req.params.sid, ctx => servers.locks.run(req.params.sid, async () => { await servers.ensureStopped(servers.get(req.params.sid)); await content.backup(req.params.sid, { name: '回滚插件前', full: false }, ctx, false); await content.rollbackTransaction(tx); return { rolledBack: true }; }));
  });

  const uploadReservations = new UploadReservations();
  let activeUploads = 0;
  function uploadRoute(kind, permission) {
    api.post(`/servers/:sid/upload/${kind}`, permitted(permission, true), async (req, res, next) => {
      if (activeUploads >= 2) return next(new AppError(429, '上传任务繁忙，请稍后重试'));
      if (kind === 'framework' && Date.now() - req.session.created > 10 * 60000) return next(new AppError(403, '安装原生框架前请在安全中心重新验证密码'));
      let reservation;
      try {
        rateLimit(store, `upload:${req.user.id}`, 10, 60000);
        const free = await diskFree(config.dataDir);
        if (activeUploads >= 2) fail(429, '上传任务繁忙，请稍后重试');
        reservation = uploadReservations.reserve(free, req.get('content-length'), config.uploadLimit);
      }
      catch (e) { return next(e); }
      activeUploads++;
      const upload = multer({ dest: path.join(config.dataDir, 'uploads'), limits: { fileSize: reservation.fileLimit, files: 1, fields: 0, parts: 1, fieldNameSize: 50 }, preservePath: true });
      upload.single('file')(req, res, error => {
        activeUploads--; reservation.release();
        if (error?.code === 'LIMIT_FILE_SIZE' && reservation.fileLimit < config.uploadLimit) return next(new AppError(400, '上传暂存空间不足：实际文件超过当前磁盘可用额度，已清理本次暂存文件', 'DISK_SPACE'));
        if (error) return next(error); if (!req.file) return next(new AppError(400, '请选择上传文件'));
        const file = req.file;
        if(![...file.originalname].some(c=>c.charCodeAt(0)>255)){const bytes=Buffer.from(file.originalname,'latin1'),decoded=bytes.toString('utf8');if(!decoded.includes('\uFFFD')&&Buffer.from(decoded).equals(bytes))file.originalname=decoded;}
        try{queued(req, res, kind === 'map' ? '上传地图' : kind === 'framework' ? '安装原生框架' : '上传插件', req.params.sid, async ctx => {
          try { return kind === 'map' ? await content.installMap(req.params.sid, { upload: file.path, filename: file.originalname }, ctx) : await content.installPlugin(req.params.sid, file.path, file.originalname, ctx, kind === 'framework'); }
          finally { await fs.rm(file.path, { force: true }); }
        },()=>fs.rm(file.path,{force:true}));}catch(error){fs.rm(file.path,{force:true}).catch(()=>{});next(error);}
      });
    });
  }
  uploadRoute('map', 'maps'); uploadRoute('plugin', 'plugins'); uploadRoute('framework', '*');

  api.get('/servers/:sid/configs', permitted('config', true), async (req, res) => res.json(await configuration.list(req.params.sid)));
  api.get('/servers/:sid/config', permitted('config', true), async (req, res) => res.json(await configuration.read(req.params.sid, String(req.query.path || 'left4dead2/cfg/server.cfg'))));
  api.put('/servers/:sid/config', permitted('config', true), async (req, res) => { const input = parse(z.object({ path: z.string().max(300), text: z.string().max(1024 ** 2) }), req.body); const result = await configuration.save(req.params.sid, input.path, input.text, req.user.id); audit(req, 'config.saved', req.params.sid, { path: input.path }); res.json(result); });
  api.post('/servers/:sid/config/restore', permitted('config', true), async (req, res) => { const version = store.get('configVersion', req.body.id); if (!version || version.serverId !== req.params.sid) fail(404, '配置版本不存在'); res.json(await configuration.save(req.params.sid, version.path, version.text, req.user.id)); });
  api.get('/servers/:sid/profiles', permitted('config', true), (req, res) => res.json(store.list('profile').filter(p => p.serverId === req.params.sid).map(({ config, ...p }) => p)));
  api.post('/servers/:sid/profiles', permitted('*', true), async (req, res) => { const { name } = parse(z.object({ name: nameSchema }), req.body); res.status(201).json(await configuration.createProfile(req.params.sid, name)); });
  api.post('/servers/:sid/profiles/apply', permitted('*', true), (req, res) => queued(req, res, '切换玩法配置组', req.params.sid, ctx => configuration.applyProfile(req.params.sid, req.body.id, ctx)));
  api.delete('/servers/:sid/profiles/:pid', permitted('*', true), (req, res) => { const p = store.get('profile', req.params.pid); if (p?.serverId !== req.params.sid) fail(404, '配置组不存在'); store.remove('profile', p.id); res.json({ ok: true }); });

  api.get('/servers/:sid/backups', permitted('backup', true), (req, res) => res.json(store.list('backup').filter(b => b.serverId === req.params.sid).map(({ file, ...b }) => b)));
  api.post('/servers/:sid/backups', permitted('backup', true), (req, res) => { const input = parse(z.object({ name: nameSchema.default('手动备份'), full: z.boolean().default(false) }), req.body); queued(req, res, '创建备份', req.params.sid, ctx => content.backup(req.params.sid, input, ctx)); });
  api.post('/servers/:sid/backups/restore', permitted('backup', true), recentAuth, (req, res) => queued(req, res, '恢复备份', req.params.sid, ctx => content.restore(req.params.sid, String(req.body.id), ctx)));
  api.get('/servers/:sid/backups/:bid/download', permitted('backup', true), (req, res) => { const backup = store.get('backup', req.params.bid); if (!backup || backup.serverId !== req.params.sid) fail(404, '备份不存在'); audit(req, 'backup.download', req.params.sid, { id: backup.id }); res.download(backup.file, `safehouse-${backup.id}.zip`); });
  api.get('/tasks', permitted('read'), (req, res) => res.json(store.list('task').filter(t => !t.serverId ? req.user.role === 'owner' : visible(req.user, t.serverId)).sort((a, b) => b.created - a.created).slice(0, 200)));
  api.get('/notifications',permitted('read'),async(req,res)=>res.json(await notifications(store,config,req.user)));
  api.get('/servers/:sid/diagnostics',permitted('console',true),async(req,res,next)=>{
    rateLimit(store,`diagnostics:${req.user.id}`,4,60000);
    const result=await diagnostics(req.params.sid,store,servers,content);audit(req,'diagnostics.download',req.params.sid);
    res.download(result.archive,`safehouse-diagnostics-${req.params.sid}.zip`,error=>{fs.rm(result.stage,{recursive:true,force:true}).catch(()=>{});if(error&&!res.headersSent)next(error);});
  });
  api.get('/tasks/:tid', permitted('read'), (req, res) => { const t = store.get('task', req.params.tid); if (!t) fail(404, '任务不存在'); if (t.serverId) authorize(req.user, 'read', t.serverId); else authorize(req.user, '*'); res.json(t); });
  api.post('/tasks/:tid/cancel', permitted('read'), async(req, res) => { const task = store.get('task', req.params.tid); if (!task) fail(404, '任务不存在'); if (req.user.role !== 'owner' && task.user !== req.user.id) fail(403, '只能取消自己的任务'); if (task.serverId) authorize(req.user, 'read', task.serverId); res.json(await tasks.cancel(task.id)); });

  api.get('/schedules', permitted('read'), (req, res) => res.json(store.list('schedule').filter(j => visible(req.user, j.serverId))));
  api.post('/schedules', permitted('control'), (req, res) => {
    const input = parse(z.object({ name: nameSchema, serverId: z.string().uuid(), action: z.enum(['restart', 'backup', 'checkUpdates']), intervalMinutes: z.number().int().min(5).max(525600), onlyEmpty: z.boolean().default(true), full: z.boolean().default(false) }), req.body);
    servers.get(input.serverId); authorize(req.user, input.action === 'backup' ? 'backup' : input.action === 'checkUpdates' ? 'maps' : 'control', input.serverId);
    const job = { ...input, id: id(), user: req.user.id, enabled: true, next: Date.now() + input.intervalMinutes * 60000 }; store.put('schedule', job); audit(req, 'schedule.created', input.serverId); res.status(201).json(job);
  });
  api.patch('/schedules/:jid', permitted('control'), (req, res) => { const job = store.get('schedule', req.params.jid); if (!job) fail(404, '计划不存在'); authorize(req.user, job.action === 'backup' ? 'backup' : job.action === 'checkUpdates' ? 'maps' : 'control', job.serverId); const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body); job.enabled = enabled; job.next = Date.now() + job.intervalMinutes * 60000; store.put('schedule', job); res.json(job); });
  api.delete('/schedules/:jid', permitted('control'), (req, res) => { const job = store.get('schedule', req.params.jid); if (!job) fail(404, '计划不存在'); authorize(req.user, job.action === 'backup' ? 'backup' : job.action === 'checkUpdates' ? 'maps' : 'control', job.serverId); store.remove('schedule', job.id); res.json({ ok: true }); });

  api.get('/users', permitted('*'), (req, res) => res.json(store.users()));
  api.post('/users', permitted('*'), recentAuth, async (req, res) => {
    const input = parse(z.object({ name: username, password: z.string(), role: z.enum(['viewer', 'operator', 'maintainer', 'owner']), servers: z.array(z.string().uuid()).max(100).default([]) }), req.body);
    if (store.userByName(input.name)) fail(409, '用户名已存在'); for (const key of input.servers) servers.get(key);
    const user = store.addUser({ ...input, password: await hashPassword(input.password) }); audit(req, 'user.created', user.id, { role: user.role }); res.status(201).json({ id: user.id, name: user.name });
  });
  api.patch('/users/:uid', permitted('*'), recentAuth, (req, res) => {
    const target = store.user(req.params.uid); if (!target) fail(404, '账号不存在');
    const input = parse(z.object({ role: z.enum(['viewer', 'operator', 'maintainer', 'owner']), servers: z.array(z.string().uuid()).max(100) }), req.body);
    if (target.id === req.user.id || (target.role === 'owner' && input.role !== 'owner' && store.users().filter(u => u.role === 'owner').length < 2)) fail(400, '不能降低当前账号或最后一个所有者的权限');
    for (const sid of input.servers) servers.get(sid);
    store.db.prepare('UPDATE users SET role=?,servers=? WHERE id=?').run(input.role, JSON.stringify(input.servers), target.id); store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id); audit(req, 'user.permissions_changed', target.id); res.json({ ok: true });
  });
  api.delete('/users/:uid', permitted('*'), recentAuth, (req, res) => { const user = store.user(req.params.uid); if (!user) fail(404, '账号不存在'); if (user.id === req.user.id || (user.role === 'owner' && store.users().filter(u => u.role === 'owner').length < 2)) fail(400, '不能删除当前账号或最后一个所有者'); store.db.prepare('DELETE FROM users WHERE id=?').run(user.id); audit(req, 'user.deleted', user.id); res.json({ ok: true }); });
  api.get('/audit', permitted('*'), (req, res) => res.json({ valid: store.verifyAudit(), entries: store.audits(300) }));
  api.get('/settings', permitted('*'), (req, res) => res.json({ version: '1.0.0', platform: process.platform, node: process.version, origin: config.origin, publicMode: config.publicMode, host: config.host, allowedRoots: [...servers.approved], steamcmd: config.steamcmd, steamcmdInstalled: fss.existsSync(config.steamcmd), hasSteamKey: !!config.steamApiKey || !!store.get('setting', 'steam')?.key, dataDir: config.dataDir, uploadLimit: config.uploadLimit }));
  api.put('/settings/steam-key', permitted('*'), recentAuth, (req, res) => { const { key } = parse(z.object({ key: z.string().regex(/^$|^[a-fA-F0-9]{32}$/) }), req.body); store.put('setting', { id: 'steam', key: key ? store.encrypt(key) : '' }); audit(req, 'settings.steam_key_changed'); res.json({ ok: true }); });
  api.post('/settings/install-steamcmd', permitted('*'), (req, res) => queued(req, res, '安装 SteamCMD', '', ctx => content.installSteamcmd(ctx)));
  api.get('/security', permitted('*'), (req, res) => {
    res.json({ publicMode: config.publicMode, checks: [
      { name: '访问边界', ok: config.publicMode || ['127.0.0.1', '::1'].includes(config.host), detail: config.publicMode ? '公网 HTTPS 模式，账号密码登录' : '仅本机监听，未开放公网' },
      { name: 'HTTPS 配置', ok: config.publicMode, detail: config.publicMode ? config.origin : '公网部署前需配置 TLS 反向代理和 PUBLIC_ORIGIN' },
      { name: '登录保护', ok: true, detail: '账号密码登录、尝试次数限制、会话过期和敏感操作重新验证' },
      { name: '操作审计完整性', ok: store.verifyAudit(), detail: 'HMAC 链校验；需独立远端备份以防主机完全失陷后的删除' },
      { name: '备份', ok: store.list('backup').length > 0, detail: `${store.list('backup').length} 个本机备份；请定期导出到独立位置` },
      { name: '文件边界', ok: true, detail: '授权根目录、符号链接阻断、上传隔离、ZIP 解压限额、事务回滚' },
      { name: '进程权限', ok: process.platform==='linux'&&process.getuid?.()!==0, detail: process.platform==='linux'?`管理进程 UID ${process.getuid?.()}；RCON 端口来源由主机防火墙约束`:'请检查 Windows 运行账号权限及 RCON 防火墙规则' }
    ] });
  });
  api.get('/servers/:sid/doctor', permitted('read', true), async (req, res) => {
    const server = servers.get(req.params.sid), state = await servers.status(server, true);
    const free = await diskFree(server.root);
    const checks = [{ name: '安装目录', ok: true, detail: server.root }, { name: '游戏进程与查询', ok: state.state === 'running', detail: state.state }, { name: '磁盘空间', ok: free >= DISK_RESERVE, detail: `${(free / 1024 ** 3).toFixed(2)} GiB 可用；安全余量 256 MiB，具体安装另按实际文件大小检查` }];
    try { await servers.validateRoot(server.root); } catch (e) { checks[0].ok = false; checks[0].detail = e.message; }
    try { const output = await servers.command(server, 'sm version'); checks.push({ name: 'SourceMod 运行状态', ok: !/Unknown command/i.test(output), detail: output }); } catch (e) { checks.push({ name: 'RCON 连接', ok: false, detail: e.message }); }
    res.json(checks);
  });
  app.use('/api', api);
  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(express.static(path.join(projectRoot, 'public'), { dotfiles: 'deny', index: 'index.html', etag: false }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || (error instanceof multer.MulterError ? 400 : error.type === 'entity.parse.failed' ? 400 : error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 500);
    const message = status >= 500 && !(error instanceof AppError) ? '操作失败，请查看服务端日志' : error instanceof multer.MulterError ? `上传失败：${error.code}` : error.message;
    if (status >= 500) console.error(redact(error.stack || error.message));
    if (req.user && status === 403) audit(req, 'access.denied', req.path);
    res.status(status).json({ error: message, code: error.code || 'REQUEST_FAILED' });
  });
  async function close() { scheduler.close(); servers.close(); await tasks.close(); store.close(); }
  return { app, config, store, servers, tasks, workshop, content, configuration, scheduler,maintenance, close };
}
