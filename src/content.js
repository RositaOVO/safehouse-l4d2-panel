import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { id, fail, safePath, safeRelative, walk, hashFile, diskFree, atomicWrite, redact } from './core.js';
import { inspectVpk, checkSmx } from './vpk.js';
import { extractZip, extractTar, createZip } from './archive.js';
import { downloadSteam } from './network.js';
import { directURL, downloadDirect } from './direct-download.js';
import { createHash } from 'node:crypto';
import { parsePlugins } from './protocols.js';
import { ensureDiskSpace, ensureFileSpace } from './disk-space.js';

export class Content {
  constructor(config, store, servers, workshop) { Object.assign(this, { config, store, servers, workshop }); }
  async recover() {
    for (const tx of this.store.list('transaction')) {
      if (tx.state === 'applying') {
        const state = await this.servers.status(this.servers.get(tx.serverId), true);
        if (state.state !== 'stopped') { this.store.audit('system', 'files.recovery_deferred', tx.serverId, { transaction: tx.id, reason: '服务器仍在运行，停服后重新启动面板完成恢复' }); continue; }
        await this.rollbackTransaction(tx); this.store.audit('system', 'files.recovered', tx.serverId, { transaction: tx.id });
      }
    }
  }
  async rollbackTransaction(tx) {
    const server = this.servers.get(tx.serverId); await this.servers.validateRoot(server.root);
    for (const item of [...tx.files].reverse()) {
      const destination = await safePath(server.root, item.relative);
      if (item.existed) { const backup = await safePath(tx.backup, item.relative, { allowMissing: false }); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(backup, destination); }
      else await fs.rm(destination, { force: true });
    }
    tx.state = 'rolled_back'; this.store.put('transaction', tx);
  }
  async transaction(server, staged, extra = [], finalize) {
    const tx = { id: id(), serverId: server.id, state: 'preparing', files: [], created: Date.now() };
    tx.backup = path.join(this.store.dir, 'backups', `tx-${tx.id}`); await fs.mkdir(tx.backup, { recursive: true });
    const all = [...new Set([...staged.map(f => f.relative), ...extra])];
    const writes = [];
    for (const file of staged) {
      const destination = await safePath(server.root, file.relative);
      writes.push({ dir: path.dirname(destination), bytes: (await fs.stat(file.source)).size });
    }
    for (const relative of all) {
      const destination = await safePath(server.root, relative), st = await fs.stat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (st && !st.isFile()) fail(400, '目标路径不是文件');
      if (st) writes.push({ dir: tx.backup, bytes: st.size });
    }
    try { await ensureDiskSpace(writes); }
    catch (error) { await fs.rm(tx.backup, { recursive: true, force: true }); throw error; }
    for (const relative of all) {
      safeRelative(relative);
      const destination = await safePath(server.root, relative), st = await fs.stat(destination).catch(() => null);
      if (st && !st.isFile()) fail(400, '目标路径不是文件');
      if (st) { const backup = await safePath(tx.backup, relative); await fs.mkdir(path.dirname(backup), { recursive: true }); await fs.copyFile(destination, backup); }
      tx.files.push({ relative, existed: !!st });
    }
    tx.state = 'applying'; this.store.put('transaction', tx);
    try {
      for (const file of staged) {
        const destination = await safePath(server.root, file.relative); await fs.mkdir(path.dirname(destination), { recursive: true });
        const temp = `${destination}.${tx.id}.tmp`;
        try { await fs.copyFile(file.source, temp, fss.constants.COPYFILE_EXCL); await fs.rename(temp, destination); }
        finally { await fs.rm(temp, { force: true }); }
      }
      for (const relative of extra) if (!staged.some(f => f.relative === relative)) await fs.rm(await safePath(server.root, relative), { force: true });
      this.store.db.exec('BEGIN IMMEDIATE');
      try { finalize?.(tx); tx.state = 'committed'; this.store.put('transaction', tx); this.store.db.exec('COMMIT'); }
      catch(error){this.store.db.exec('ROLLBACK');throw error;}
      return tx;
    } catch (error) { await this.rollbackTransaction(tx); throw error; }
  }
  async runSteam(args, ctx, attempt = 0) {
    if (!fss.existsSync(this.config.steamcmd)) fail(400, 'SteamCMD 尚未配置，请先在系统设置中安装或设置 STEAMCMD_PATH');
    ctx.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(this.config.steamcmd, args, { cwd: path.dirname(this.config.steamcmd), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', settled = false;
      const onAbort = () => { child.kill(); };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => child.kill(), 2 * 3600000);
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { const text = redact(bytes.toString()); output = (output + text).slice(-100000); const match = text.match(/progress:\s*([\d.]+)/i); ctx.update(text, match ? Number(match[1]) * 0.85 : undefined); });
      const finish = error => { if (settled) return; settled = true; clearTimeout(timer); ctx.signal?.removeEventListener('abort', onAbort); error ? reject(error) : resolve(output); };
      child.once('error', error => finish(error));
      child.once('close', code => {
        if (ctx.signal?.aborted) return finish(new Error('任务已取消'));
        if (code !== 0 && attempt < 3 && /Update complete|更新完成|updating steamcmd/i.test(output) && !/ERROR!|No subscription|Access Denied/i.test(output)) {
          clearTimeout(timer);ctx.signal?.removeEventListener('abort',onAbort);settled=true;ctx.update('SteamCMD 首次更新完成，继续执行安装');this.runSteam(args,ctx,attempt+1).then(resolve,reject);return;
        }
        if (code !== 0 || /ERROR!|Failure\. No subscription|Access Denied/i.test(output)) return finish(new Error(`SteamCMD 下载失败：${output.slice(-1500)}`));
        finish();
      });
    });
  }
  async installSteamcmd(ctx) {
    if (fss.existsSync(this.config.steamcmd)) return { path: this.config.steamcmd, exists: true };
    const stage = path.join(this.store.dir, 'staging', id()); await fs.mkdir(stage, { recursive: true });
    try {
      const windows = process.platform === 'win32', archive = path.join(stage, windows ? 'steamcmd.zip' : 'steamcmd.tar.gz');
      await downloadSteam(windows ? 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip' : 'https://media.steampowered.com/installer/steamcmd_linux.tar.gz', archive, { maxBytes: 30 * 1024 ** 2, signal: ctx.signal, onProgress: (a, b) => ctx.update('下载 SteamCMD', b ? a / b * 70 : 10) });
      const unpacked = path.join(stage, 'unpacked');
      if (windows) await extractZip(archive, unpacked, { maxBytes: 50 * 1024 ** 2, accept: name => name.toLowerCase() === 'steamcmd.exe' });
      else await extractTar(archive, unpacked, { maxBytes: 100 * 1024 ** 2, accept: name => /^(steamcmd\.sh|linux32\/[a-zA-Z0-9_.-]+)$/.test(name) });
      await fs.mkdir(path.dirname(this.config.steamcmd), { recursive: true });
      for (const source of await walk(unpacked, { depth: 3 })) { const rel = path.relative(unpacked, source), destination = path.join(path.dirname(this.config.steamcmd), rel); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.copyFile(source, destination, fss.constants.COPYFILE_EXCL); if (!windows && /(^steamcmd\.sh$|linux32[/\\](steamcmd|steamerrorreporter)$)/.test(rel)) await fs.chmod(destination, 0o750); }
      return { path: this.config.steamcmd };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
  }
  async installServer(input, ctx) {
    const root = await this.servers.validateRoot(input.root, true);
    await fs.mkdir(root, { recursive: true });
    const marker=path.join(root,'.safehouse-install.json'),entries=await fs.readdir(root);
    let installation;
    if(entries.length){
      const local=JSON.parse(await fs.readFile(marker,'utf8').catch(()=>'null'));
      installation=local?.id&&this.store.get('installation',local.id);
      if(!installation||installation.root!==root)fail(409,'新安装目录必须为空；面板创建的中断安装可在原目录继续，已有服务器请使用自动发现接管');
    }else{installation={id:id(),root,created:Date.now(),status:'pending'};this.store.put('installation',installation);atomicWrite(marker,JSON.stringify({id:installation.id}));}
    if (await diskFree(root) < 25 * 1024 ** 3) fail(400, '安装服务端至少需要 25 GB 可用空间');
    await this.steamServer(root,ctx);
    const server = await this.servers.register(input);await fs.rm(marker,{force:true});installation.status='complete';this.store.put('installation',installation);return { serverId: server.id };
  }
  async steamServer(root,ctx,platform=process.platform){
    if(this.config.depotDownloader)return this.runDepot(root,ctx,platform);
    const command=['+force_install_dir',root,'+login','anonymous','+app_update','222860','validate','+quit'];
    try{await this.runSteam(command,ctx);}catch(error){
      if(platform!=='linux'||!/Invalid platform/i.test(error.message))throw error;
      ctx.update('检测到 Valve Linux 平台识别问题，先验证共享内容，再覆盖 Linux 原生文件');
      await this.runSteam(['+@sSteamCmdForcePlatformType','windows',...command],ctx);
      await this.runSteam(['+@sSteamCmdForcePlatformType','linux',...command],ctx);
    }
  }
  async runDepot(root,ctx,platform=process.platform){
    const tool=this.config.depotDownloader;
    if(!tool||!fss.existsSync(tool))fail(400,'兼容下载器路径不存在，请检查 DEPOT_DOWNLOADER_PATH');
    const args=['-app','222860','-os',platform==='win32'?'windows':'linux','-dir',root,'-validate'];
    let executable=tool;if(/\.dll$/i.test(tool)){executable=this.config.dotnet;args.unshift(tool);}
    await new Promise((resolve,reject)=>{
      ctx.signal?.throwIfAborted();
      const child=spawn(executable,args,{cwd:path.dirname(tool),windowsHide:true,stdio:['ignore','pipe','pipe']});
      let output='',settled=false;const abort=()=>child.kill(),timer=setTimeout(abort,2*3600000);
      ctx.signal?.addEventListener('abort',abort,{once:true});
      for(const stream of[child.stdout,child.stderr])stream.on('data',bytes=>{const text=redact(bytes.toString());output=(output+text).slice(-10000);const match=text.match(/(\d+(?:\.\d+)?)%/);ctx.update(text,match?Number(match[1])*0.9:undefined);});
      const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);ctx.signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
      child.once('error',finish);child.once('close',code=>finish(ctx.signal?.aborted?new Error('任务已取消'):code!==0?new Error(`兼容下载器失败：${output.slice(-1500)}`):null));
    });
    if(platform==='linux')for(const name of['srcds_run','srcds_linux']){const file=await safePath(root,name,{allowMissing:false});await fs.chmod(file,0o750);}
    return {downloader:'DepotDownloader',platform};
  }
  async updateServer(key, ctx) {
    return this.servers.locks.run(key, async () => {
      const server = this.servers.get(key); await this.servers.ensureStopped(server);
      await this.backup(key, { name: '更新服务端前', full: false }, ctx, false);
      await this.steamServer(server.root,ctx);
      return { updated: true };
    });
  }
  async downloadWorkshop(pid, stage, ctx) {
    const { item } = await this.workshop.resolve(pid,{signal:ctx.signal});
    if (item.type === 2) fail(400, '请展开合集并选择其中的地图，不能直接安装合集');
    if (item.size > this.config.uploadLimit) fail(400, '项目体积超过当前安装限制，请使用本地分卷上传');
    if (item.fileUrl) {
      const destination = path.join(stage, `${item.id}.vpk`);
      await downloadSteam(item.fileUrl.replace(/^http:/, 'https:'), destination, { maxBytes: this.config.uploadLimit, signal: ctx.signal, onProgress: (a, b) => ctx.update(`下载 ${item.title}：${(a / 1024 ** 2).toFixed(1)} MB`, b ? a / b * 70 : 10) });
      return { item, files: [destination] };
    }
    ctx.update('该项目没有直接下载地址，尝试 SteamCMD 官方下载', 5);
    await this.runSteam(['+login', 'anonymous', '+workshop_download_item', '550', item.id, 'validate', '+quit'], ctx);
    const cache = path.join(path.dirname(this.config.steamcmd), 'steamapps', 'workshop', 'content', '550', item.id);
    const files = await walk(cache, { depth: 4, filter: f => /\.vpk$/i.test(f) });
    if (!files.length) fail(400, 'SteamCMD 未返回 VPK；该项目可能需要拥有游戏的 Steam 账号。可在 Steam 客户端订阅后上传 VPK');
    const staged = [];
    for (const file of files) { const target = path.join(stage, path.basename(file)); if (fss.existsSync(target)) fail(400, '下载内容包含同名 VPK'); await ensureFileSpace(target, (await fs.stat(file)).size); await fs.copyFile(file, target); staged.push(target); }
    return { item, files: staged };
  }
  async installMap(key, { workshopId, upload, filename, directUrl, checksum }, ctx) {
    return this.servers.locks.run(key, async () => {
      const server = this.servers.get(key); await this.servers.ensureStopped(server);
      await ensureDiskSpace([{ dir: this.store.dir, bytes: 0 }, { dir: server.root, bytes: 0 }]);
      const stage = path.join(this.store.dir, 'staging', id()); await fs.mkdir(stage, { recursive: true });
      try {
        let item, files;
        if (workshopId) ({ item, files } = await this.downloadWorkshop(workshopId, stage, ctx));
        else {
          if (directUrl) {
            const url = directURL(directUrl), downloaded = path.join(stage, 'download.tmp');
            const result = await downloadDirect(url, downloaded, { maxBytes: this.config.uploadLimit, signal: ctx.signal, onProgress: (a,b) => ctx.update(`直链下载：${(a/1024**2).toFixed(1)} MB${b?' / '+(b/1024**2).toFixed(1)+' MB':''}`, b ? a/b*70 : 10) });
            if (checksum && await hashFile(downloaded) !== checksum.toLowerCase()) fail(400, 'SHA256 校验不符，已拒绝安装');
            filename = filename || (() => { try { return decodeURIComponent(url.pathname.split('/').pop() || ''); } catch { return ''; } })();
            if (!/^[^<>:"/\\|?*\x00-\x1f]{1,160}\.(vpk|zip)$/i.test(filename)) filename = `download.${result.extension}`;
            if (!filename.toLowerCase().endsWith('.'+result.extension)) fail(400, '文件名扩展名与实际 VPK / ZIP 格式不符');
            upload = path.join(stage, 'source.'+result.extension); await fs.rename(downloaded, upload);
            item = { id: `direct-${createHash('sha256').update(url.href).digest('hex').slice(0,24)}`, title: filename, updated: 0, url: '', source: 'direct', sourceHost: url.hostname };
          } else item = { id: `local-${id()}`, title: path.basename(filename), updated: 0, url: '' };
          if (/\.zip$/i.test(filename)) {
            const unpacked = path.join(stage, 'unpacked'); await extractZip(upload, unpacked, { maxBytes: this.config.uploadLimit, accept: name => /\.vpk$/i.test(name) });
            files = await walk(unpacked, { filter: file => /\.vpk$/i.test(file) });
          } else if (/\.vpk$/i.test(filename)) { safeRelative(filename); const file = path.join(stage, filename); await ensureFileSpace(file, (await fs.stat(upload)).size); await fs.copyFile(upload, file); files = [file]; }
          else fail(400, '只支持 VPK 或包含 VPK 的 ZIP');
        }
        ctx.signal?.throwIfAborted(); ctx.update('校验地图资源、分卷和重名冲突', 75);
        const indexes = files.filter(file => !/_\d{3}\.vpk$/i.test(file));
        if (!indexes.length) fail(400, '没有找到 VPK 索引或单文件地图');
        const inspections = [];
        for (const file of indexes) inspections.push(await inspectVpk(file));
        const missionMaps = inspections.flatMap(x => x.missions).flatMap(m => Object.values(m.mission?.modes?.coop || m.Mission?.modes?.coop || {}).map(ch => ch.Map || ch.map).filter(Boolean));
        const maps = [...new Set([...missionMaps, ...inspections.flatMap(x => x.maps)])];
        if (!maps.length) fail(400, '该项目不包含 BSP 地图，不能作为地图安装');
        const mapId = `${key}:${item.id}`, old = this.store.get('map', mapId);
        const others = this.store.list('map').filter(x => x.serverId === key && x.id !== mapId);
        if (others.some(x => x.maps.some(m => maps.includes(m)))) fail(409, '已安装项目中存在相同 BSP 地图名，请先处理冲突');
        const names = new Set();
        const staged = [];
        for (const file of files) {
          const name = path.basename(file);
          if (names.has(name.toLowerCase())) fail(400, '地图包中存在同名文件'); names.add(name.toLowerCase());
          const relative = `left4dead2/addons/workshop/${item.id}-${name}`;
          const destination = await safePath(server.root, relative);
          if (fss.existsSync(destination) && !old?.files.includes(relative)) fail(409, '目标文件已经存在且不属于该项目');
          staged.push({ relative, source: file });
        }
        // Preserve index/volume naming; prefixing every VPK with the same project ID keeps volume references valid.
        const record = { id: mapId, workshopId: workshopId ? item.id : null, source: item.source || (workshopId?'workshop':'local'), sourceHost: item.sourceHost || '', serverId: key, title: item.title, url: item.url, preview: item.preview || '', updated: item.updated, installed: Date.now(), enabled: true, maps, files: staged.map(f => f.relative), hashes: await Promise.all(staged.map(f => hashFile(f.source))), resources: inspections.flatMap(x => x.resources), missions: inspections.flatMap(x => x.missions) };
        await this.transaction(server, staged, old?.files || [],tx=>{
          if(old)this.store.put('mapVersion',{...old,id:id(),mapId,transaction:tx.id,created:Date.now()});
          record.transaction=tx.id;this.store.put('map',record);
        });
        return { id: mapId, title: item.title, maps };
      } finally { await fs.rm(stage, { recursive: true, force: true }); if (upload) await fs.rm(upload, { force: true }); }
    });
  }
  async mapAction(key, mapId, action) {
    return this.servers.locks.run(key, async () => {
      const server = this.servers.get(key); await this.servers.ensureStopped(server);
      const record = this.store.get('map', mapId); if (!record || record.serverId !== key) fail(404, '地图不存在');
      if (action === 'uninstall') { await this.transaction(server, [], record.files,()=>this.store.remove('map',mapId)); return { removed: true }; }
      const enable = action === 'enable'; if (!enable && action !== 'disable') fail(400, '操作无效');
      if (record.enabled === enable) return { ok: true };
      const staged = [];
      for (const file of record.files) {
        const basename = path.posix.basename(file), relative = enable ? `left4dead2/addons/workshop/${basename}` : `left4dead2/safehouse-disabled/${basename}`;
        staged.push({ relative, source: await safePath(server.root, file, { allowMissing: false }) });
      }
      await this.transaction(server, staged, record.files,()=>{record.files=staged.map(f=>f.relative);record.enabled=enable;this.store.put('map',record);});return {ok:true};
    });
  }
  async checkMapUpdates(key) {
    const maps = this.store.list('map').filter(m => m.serverId === key && m.workshopId);
    const result = [];
    for (let i = 0; i < maps.length; i += 50) {
      const details = await this.workshop.details(maps.slice(i, i + 50).map(m => m.workshopId));
      for (const item of details) { const local = maps.find(m => m.workshopId === item.id); local.updateAvailable = !item.error && item.updated > local.updated; local.updateError = item.error || (!item.updated?'Steam 未提供更新时间，请稍后重新检查':''); local.checked = Date.now(); this.store.put('map', local); result.push(local); }
    }
    return result;
  }
  async rollbackMap(key, versionId, ctx) {
    return this.servers.locks.run(key, async () => {
      const server = this.servers.get(key); await this.servers.ensureStopped(server);
      const previous = this.store.get('mapVersion', versionId);
      if (!previous || previous.serverId !== key) fail(404, '地图版本不存在');
      const current = this.store.get('map', previous.mapId), tx = this.store.get('transaction', previous.transaction);
      if (!current || !tx || tx.state !== 'committed') fail(409, '该版本的回滚文件不可用');
      // Only roll back the immediately preceding version; older snapshots may reference an incompatible file layout.
      if (current.transaction !== tx.id) fail(409, '请依次回滚到上一个版本，不能跳过中间版本');
      await this.backup(key, { name: '地图回滚前', full: true }, ctx, false);
      await this.rollbackTransaction(tx);
      const { mapId, created, ...restored } = previous; restored.id = mapId;
      const older = this.store.list('mapVersion').filter(v => v.mapId === mapId && v.id !== previous.id && v.created < previous.created).sort((a,b) => b.created-a.created)[0];
      restored.transaction = older?.transaction || null;
      this.store.put('map', restored); this.store.remove('mapVersion', versionId);
      return { restored: true, title: restored.title };
    });
  }
  async plugins(key) {
    const server = this.servers.get(key), game = path.join(server.root, 'left4dead2');
    const smRoot = await safePath(game, 'addons/sourcemod');
    const files = await walk(path.join(smRoot, 'plugins'), { depth: 6, filter: f => /\.smx$/i.test(f) });
    let runtime = [], runtimeError = '', version = '', extensions = '', metamod = '';
    try {
      const text = await this.servers.command(server, 'sm plugins list');
      if (/Unknown command/i.test(text)) throw new Error('游戏中未加载 SourceMod');
      runtime = parsePlugins(text);
      version = await this.servers.command(server, 'sm version');
      extensions = await this.servers.command(server, 'sm exts list');
      metamod = await this.servers.command(server, 'meta list');
      for (let i = 0; i < runtime.length; i += 20) {
        const group = runtime.slice(i, i + 20);
        const info = await this.servers.command(server, group.map(p => `sm plugins info ${p.runtimeId}`).join(';'));
        const chunks = info.split(/(?=\s*Filename:)/);
        for (const chunk of chunks) {
          const filename = chunk.match(/Filename:\s*(.+\.smx)/i)?.[1]?.trim(), name = chunk.match(/^\s*Title:\s*(.+?)(?:\s*\(|$)/im)?.[1]?.trim() || chunk.match(/^\s*Title:\s*(.+)/im)?.[1]?.trim();
          const match = group.find(p => (filename && (p.name === filename || p.name === path.basename(filename, '.smx'))) || (name && (p.name === name || name.startsWith(p.name))));
          if (match) { match.filename = filename; match.detail = chunk.trim(); }
        }
      }
    } catch (e) { runtimeError = e.message; }
    const plugins = files.map(file => {
      const relative = path.relative(path.join(smRoot, 'plugins'), file).split(path.sep).join('/'), filename = path.basename(file);
      const found = runtime.find(p => p.filename?.replace(/\\/g, '/') === relative || p.filename === filename);
      return { file: relative, filename, name: found?.name || filename.replace(/\.smx$/i, ''), enabled: !relative.startsWith('disabled/'), runtime: found?.runtime || (runtimeError ? 'unknown' : 'unloaded'), runtimeId: found?.runtimeId, version: found?.version || '', author: found?.author || '', detail: found?.detail || '' };
    });
    const extension=process.platform==='win32'?'dll':'so';
    const framework=(base,name)=>['', 'linux64/','x64/'].some(prefix=>fss.existsSync(path.join(base,`${prefix}${name}.2.l4d2.${extension}`)));
    return { plugins, unassociated: runtime.filter(p => !plugins.some(f => f.runtimeId === p.runtimeId)), runtimeError, sourcemod: { installed: framework(path.join(smRoot,'bin'),'sourcemod'), version }, metamod: { installed: framework(path.join(game,'addons/metamod/bin'),'metamod'), status: metamod }, extensions };
  }
  async pluginToggle(key, relative, enabled,lock=true) {
    const run=async () => {
      const server = this.servers.get(key); await this.servers.validateRoot(server.root);
      safeRelative(relative); if (!/\.smx$/i.test(relative)) fail(400, '只能操作 SMX 插件');
      const root = path.join(server.root, 'left4dead2/addons/sourcemod/plugins');
      const source = await safePath(root, relative, { allowMissing: false });
      const normalized = relative.replace(/^disabled\//, ''), destinationRelative = enabled ? normalized : `disabled/${normalized}`;
      if (destinationRelative === relative) return { ok: true, runtime: 'unchanged' };
      const destination = await safePath(root, destinationRelative); if (fss.existsSync(destination)) fail(409, '目标插件文件已存在');
      await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.rename(source, destination);
      let runtime = 'pending', message = '';
      try {
        const commandName = enabled ? normalized : relative;
        if (!/^[a-zA-Z0-9_./-]+\.smx$/.test(commandName)) fail(400, '文件名不支持在线加载，请在重启后生效');
        const output = await this.servers.command(server, `sm plugins ${enabled ? 'load' : 'unload'} "${commandName}"`);
        if (/successfully|unloaded|loaded/i.test(output) && !/failed|error|unable/i.test(output)) runtime = 'applied';
        message = output;
      } catch (e) { message = e.message; }
      return { ok: true, enabled, runtime, message, file: destinationRelative };
    };return lock?this.servers.locks.run(key,run):run();
  }
  async installPlugin(key, upload, filename, ctx, framework = false) {
    return this.servers.locks.run(key, async () => {
      const server = this.servers.get(key); await this.servers.ensureStopped(server);
      const stage = path.join(this.store.dir, 'staging', id()); await fs.mkdir(stage, { recursive: true });
      try {
        let files;
        if (/\.smx$/i.test(filename) && !framework) { safeRelative(filename); const target = path.join(stage, filename); await ensureFileSpace(target, (await fs.stat(upload)).size); await fs.copyFile(upload, target); files = [target]; }
        else if (/\.(zip|tar\.gz|tgz)$/i.test(filename)) {
          const allowed = name => framework ? /^(addons\/(sourcemod\/|metamod\/|metamod(?:_x64)?\.vdf$)|cfg\/sourcemod\/)/i.test(name) && (/\.(smx|sp|inc|txt|cfg|ini|vdf|dll|so|dylib|autoload|games|geoip|mmdb|dat|version|sql|sq3|gitkeep)$/i.test(name) || /^addons\/sourcemod\/scripting\/((spcomp(?:64)?|compile)\.exe|spcomp(?:64)?|compile\.sh)$/i.test(name)) : /\.(smx|sp|inc|txt|cfg|ini|games)$/i.test(name) && !/\.(exe|dll|so|bat|cmd|ps1|js|html)(\.|$)/i.test(name);
          const extract = /\.zip$/i.test(filename) ? extractZip : extractTar;
          await extract(upload, stage, { maxBytes: 512 * 1024 ** 2, accept: allowed }); files = await walk(stage, { depth: 12 });
        } else fail(400, '插件支持 SMX/ZIP/TAR.GZ，框架支持官方 ZIP 或 TAR.GZ 包');
        const staged = [];
        for (const source of files) {
          const file = path.relative(stage, source).split(path.sep).join('/'); let relative;
          if (framework) relative = `left4dead2/${file}`;
          else if (files.length === 1 && /\.smx$/i.test(file)) relative = `left4dead2/addons/sourcemod/plugins/${path.basename(file)}`;
          else {
            const clean = file.replace(/^left4dead2\//, '');
            if (/^addons\/sourcemod\/(plugins|configs|translations|gamedata|scripting)\//i.test(clean) || /^cfg\/sourcemod\//i.test(clean)) relative = `left4dead2/${clean}`;
            else if (/^(plugins|configs|translations|gamedata|scripting)\//i.test(clean)) relative = `left4dead2/addons/sourcemod/${clean}`;
            else fail(400, `无法识别插件文件安装位置：${file}`);
          }
          if (/\.smx$/i.test(file)) await checkSmx(source);
          staged.push({ source, relative });
        }
        if (!staged.length) fail(400, '插件包中没有可安装文件');
        ctx.signal?.throwIfAborted(); ctx.update('备份原文件并安装插件', 75);
        const tx = await this.transaction(server, staged,[],tx=>this.store.put('package', { id: id(), serverId: key, filename, framework, files: staged.map(f => f.relative), transaction: tx.id, created: Date.now() }));
        return { files: staged.map(f => f.relative), transaction: tx.id, pending: '下次启动时加载' };
      } finally { await fs.rm(stage, { recursive: true, force: true }); await fs.rm(upload, { force: true }); }
    });
  }
  async backup(key, options, ctx, lock = true) {
    const run = async () => {
      const server = this.servers.get(key); await this.servers.ensureStopped(server);
      const backupId = id(), destination = path.join(this.store.dir, 'backups', `${backupId}.zip`);
      const full = !!options.full;
      const accept = name => /^(left4dead2\/(cfg|addons|safehouse-disabled)\/)/.test(name) && !/\/(logs|scripting)\//.test(name) && (full || !/\.vpk$/i.test(name));
      ctx.update?.('正在备份配置、插件和地图清单', 30);
      const maps = this.store.list('map').filter(m => m.serverId === key);
      const metadata = { version: 1, serverId: key, full, maps, created: Date.now(), scope: ['left4dead2/cfg/', 'left4dead2/addons/', 'left4dead2/safehouse-disabled/'] };
      const count = await createZip(server.root, destination, { accept, roots:metadata.scope.map(x=>x.replace(/\/$/,'')), extras: { 'safehouse-backup.json': JSON.stringify(metadata) } });
      const record = { id: backupId, serverId: key, name: options.name || '手动备份', full, file: destination, files: count, size: (await fs.stat(destination)).size, hash: await hashFile(destination), created: Date.now() };
      this.store.put('backup', record); return record;
    };
    return lock ? this.servers.locks.run(key, run) : run();
  }
  async restore(key, backupId, ctx) {
    return this.servers.locks.run(key, async () => {
      const server = this.servers.get(key); await this.servers.ensureStopped(server);
      const backup = this.store.get('backup', backupId); if (!backup || backup.serverId !== key) fail(404, '备份不存在');
      if (await hashFile(backup.file) !== backup.hash) fail(400, '备份校验失败，已拒绝恢复');
      const stage = path.join(this.store.dir, 'staging', id()); await fs.mkdir(stage, { recursive: true });
      try {
        const files = await extractZip(backup.file, stage, { maxBytes: 10 * 1024 ** 3, accept: name => name === 'safehouse-backup.json' || /^(left4dead2\/(cfg|addons|safehouse-disabled)\/)/.test(name) });
        const metadata = JSON.parse(await fs.readFile(path.join(stage, 'safehouse-backup.json'), 'utf8'));
        if (metadata.serverId !== key || metadata.version !== 1) fail(400, '备份元数据与实例不匹配');
        const safety = await this.backup(key, { name: '恢复前自动保护备份', full: backup.full }, ctx, false);
        const staged = files.filter(f => f !== 'safehouse-backup.json').map(relative => ({ relative, source: path.join(stage, relative) }));
        const existing = [];
        for(const relRoot of ['left4dead2/cfg','left4dead2/addons','left4dead2/safehouse-disabled'])existing.push(...await walk(await safePath(server.root,relRoot),{depth:20,limit:50000,filter:file=>{
          const rel=path.relative(server.root,file).split(path.sep).join('/');return !/\/(logs|scripting)\//.test(rel)&&(backup.full||!/\.vpk$/i.test(rel));
        }}));
        await this.transaction(server, staged, existing.map(f => path.relative(server.root, f).split(path.sep).join('/')));
        if (backup.full) {
          for (const map of this.store.list('map').filter(m => m.serverId === key)) this.store.remove('map', map.id);
          for (const map of metadata.maps) this.store.put('map', map);
        }
        return { restored: true, safetyBackup: safety.id, scope: backup.full ? '配置、插件和地图文件' : '配置和插件；地图文件保持当前版本' };
      } finally { await fs.rm(stage, { recursive: true, force: true }); }
    });
  }
}
