import { id, redact, fail } from './core.js';

export class Tasks {
  constructor(store) { this.store = store; this.queue = []; this.running = false; this.controllers = new Map(); this.closed = false; }
  create(type, serverId, user, run, onCancel = async()=>{}) {
    if (this.closed) fail(503, '管理服务正在关闭');
    if (this.queue.length > 100) fail(429, '任务队列已满');
    const task = { id: id(), type, serverId: serverId || '', user, status: 'queued', progress: 0, message: '等待执行', log: [], created: Date.now() };
    this.store.put('task', task); this.queue.push({ task, run,onCancel }); queueMicrotask(() => this.drain()); return task;
  }
  async drain() {
    if (this.running || this.closed) return;
    this.running = true;
    try {
      while (this.queue.length && !this.closed) {
        const { task, run } = this.queue.shift();
        if (this.store.get('task', task.id)?.status === 'cancelled') continue;
        const controller = new AbortController(); this.controllers.set(task.id, controller);
        const update = (message, progress) => {
          task.message = redact(message).slice(-2000);
          if (Number.isFinite(progress)) task.progress = Math.max(0, Math.min(100, progress));
          if (message) { task.log.push({ time: Date.now(), message: task.message }); task.log = task.log.slice(-300); }
          this.store.put('task', task);
        };
        task.status = 'running'; task.started = Date.now(); update('开始执行', 0);
        try {
          task.result = await run({ signal: controller.signal, update, taskId: task.id });
          task.status = 'succeeded'; update('执行完成', 100);
        } catch (error) {
          task.status = controller.signal.aborted ? 'cancelled' : 'failed'; task.error = redact(error.message); update(task.error);
        } finally {
          task.ended = Date.now(); this.store.put('task', task); this.controllers.delete(task.id);
          this.store.audit(task.user, `task.${task.status}`, task.serverId, { taskId: task.id, type: task.type, error: task.error });
        }
      }
    } finally { this.running = false; }
  }
  async cancel(key) {
    const task = this.store.get('task', key); if (!task) fail(404, '任务不存在');
    if (task.status === 'queued') { const item=this.queue.find(q=>q.task.id===key);task.status = 'cancelled'; task.ended = Date.now(); this.store.put('task', task);await item?.onCancel(); }
    else if (task.status === 'running') this.controllers.get(key)?.abort();
    else fail(409, '该任务已经结束');
    return { ok: true };
  }
  async close() { this.closed = true; for (const c of this.controllers.values()) c.abort(); while (this.running) await new Promise(r => setTimeout(r, 100)); }
}
