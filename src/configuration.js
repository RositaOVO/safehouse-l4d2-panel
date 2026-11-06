import fs from 'node:fs/promises';
import path from 'node:path';
import { id, fail, safePath, atomicWrite, walk } from './core.js';

export function editable(relative) {
  return /^(left4dead2\/cfg\/.+\.(cfg|txt)|left4dead2\/addons\/sourcemod\/(configs|gamedata|translations)\/.+\.(cfg|txt|ini|games)|left4dead2\/(mapcycle|motd|host)\.txt)$/.test(relative) && !/safehouse\.cfg$/.test(relative);
}
export class Configuration {
  constructor(store, servers, content) { Object.assign(this, { store, servers, content }); }
  async list(key) {
    const server = this.servers.get(key), files = [];
    for(const root of ['left4dead2/cfg','left4dead2/addons/sourcemod/configs','left4dead2/addons/sourcemod/gamedata','left4dead2/addons/sourcemod/translations']){
      files.push(...await walk(await safePath(server.root,root),{depth:8,filter:file=>editable(path.relative(server.root,file).split(path.sep).join('/'))}));
    }
    return [...new Set(['left4dead2/cfg/server.cfg', 'left4dead2/mapcycle.txt', ...files.map(f => path.relative(server.root, f).split(path.sep).join('/'))])].sort();
  }
  async read(key, relative) {
    if (!editable(relative)) fail(400, '该文件不允许通过配置编辑器访问');
    const server = this.servers.get(key), file = await safePath(server.root, relative);
    const stat = await fs.stat(file).catch(() => null); if (stat?.size > 1024 ** 2) fail(400, '配置文件超过 1 MB');
    return { path: relative, text: await fs.readFile(file, 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; }), history: this.store.list('configVersion').filter(v => v.serverId === key && v.path === relative).map(({ text, ...v }) => v).sort((a, b) => b.created - a.created).slice(0, 50) };
  }
  async save(key, relative, text, user,lock=true) {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 ** 2 || text.includes('\0')) fail(400, '配置内容无效或体积过大');
    const run=async () => {
      const previous = await this.read(key, relative), server = this.servers.get(key);
      // Engine exec files can reference other files; only trusted config maintainers receive this permission.
      this.store.put('configVersion', { id: id(), serverId: key, path: relative, text: previous.text, created: Date.now(), user });
      const file = await safePath(server.root, relative); atomicWrite(file, text);
      return { saved: true, application: '配置已保存；服务器启动或执行对应配置后生效' };
    };return lock?this.servers.locks.run(key,run):run();
  }
  async createProfile(key, name) {
    const server = this.servers.get(key); await this.servers.ensureStopped(server);
    const { plugins } = await this.content.plugins(key), config = await this.read(key, 'left4dead2/cfg/server.cfg');
    return this.store.put('profile', { id: id(), serverId: key, name, plugins: plugins.map(p => ({ file: p.file, enabled: p.enabled })), config: config.text, settings: { map: server.map, mode: server.mode, difficulty: server.difficulty, maxPlayers: server.maxPlayers, tickrate: server.tickrate || 30 }, created: Date.now() });
  }
  async applyProfile(key, pid, ctx) {
    return this.servers.locks.run(key,async()=>{
    const profile = this.store.get('profile', pid); if (!profile || profile.serverId !== key) fail(404, '玩法配置组不存在');
    const server = this.servers.get(key); await this.servers.ensureStopped(server);
    const safety = await this.content.backup(key, { name: '应用玩法配置组前', full: false }, ctx,false);
    const { plugins } = await this.content.plugins(key);
    const desired = new Map(profile.plugins.map(p => [p.file.replace(/^disabled\//, ''), p.enabled]));
    for (const plugin of plugins) {
      const enabled = desired.get(plugin.file.replace(/^disabled\//, '')) ?? false;
      if (enabled !== plugin.enabled) await this.content.pluginToggle(key, plugin.file, enabled,false);
    }
    await this.save(key, 'left4dead2/cfg/server.cfg', profile.config, 'profile',false);
    await this.servers.update(key, profile.settings);
    return { applied: true, safetyBackup: safety.id };
    });
  }
}
