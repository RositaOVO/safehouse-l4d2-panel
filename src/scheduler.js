import { authorize } from './security.js';

export class Scheduler {
  constructor(store, tasks, servers, content) { Object.assign(this, { store, tasks, servers, content }); }
  start() { this.timer = setInterval(() => this.tick().catch(() => {}), 15000); this.timer.unref(); }
  async tick(now = Date.now()) {
    for (const job of this.store.list('schedule')) {
      if (!job.enabled || job.next > now) continue;
      const user = this.store.user(job.user);
      job.last = now; job.next = now + job.intervalMinutes * 60000;
      this.store.put('schedule', job);
      try {
        authorize(user, job.action === 'backup' ? 'backup' : job.action === 'checkUpdates' ? 'maps' : 'control', job.serverId);
        if (this.tasks.store.list('task').some(t => t.serverId === job.serverId && t.scheduleId === job.id && ['queued', 'running'].includes(t.status))) continue;
        const task = this.tasks.create(`计划：${job.name}`, job.serverId, user.id, async ctx => {
          const server = this.servers.get(job.serverId);
          if (job.onlyEmpty) { const state = await this.servers.status(server, true); if (state.state!=='stopped'&&(!state.info || state.info.players > state.info.bots))return {skipped:true,reason:'存在玩家或无法确认服务器为空，跳过本次维护'}; }
          if (job.action === 'restart') return this.servers.control(job.serverId, 'restart', ctx, { countdown: 30 });
          if (job.action === 'backup') return this.content.backup(job.serverId, { name: job.name, full: job.full }, ctx);
          return this.content.checkMapUpdates(job.serverId);
        });
        task.scheduleId = job.id; this.store.put('task', task);
      } catch (error) { job.error = error.message; job.enabled = false; this.store.put('schedule', job); this.store.audit('system', 'schedule.disabled', job.id, { error: error.message }); }
    }
  }
  close() { clearInterval(this.timer); }
}
