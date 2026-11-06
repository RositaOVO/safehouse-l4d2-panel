import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite, id, redact } from './core.js';

export class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    for (const dir of ['', 'uploads', 'backups', 'logs', 'servers', 'tools', 'staging']) fs.mkdirSync(path.join(dataDir, dir), { recursive: true, mode: 0o700 });
    const keyFile = path.join(dataDir, 'master.key');
    if (!fs.existsSync(keyFile)) atomicWrite(keyFile, crypto.randomBytes(32));
    this.key = fs.readFileSync(keyFile);
    this.db = new DatabaseSync(path.join(dataDir, 'panel.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL, servers TEXT NOT NULL DEFAULT '[]', created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,time INTEGER NOT NULL,user TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL,detail TEXT NOT NULL,previous TEXT NOT NULL,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS login_attempts(key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset INTEGER NOT NULL);
    `);
    this.removeLegacyMfa();
  }
  removeLegacyMfa() {
    const columns=this.db.prepare('PRAGMA table_info(users)').all().map(c=>c.name);
    for(const name of ['totp','last_totp'])if(columns.includes(name))this.db.exec('ALTER TABLE users DROP COLUMN '+name);
    this.db.prepare('DELETE FROM records WHERE kind=?').run('mfaPending');
  }
  recoverTasks() { for (const task of this.list('task')) if (['queued', 'running'].includes(task.status)) this.put('task', { ...task, status: 'interrupted', error: '管理服务重启，任务已中断；检查文件状态后可重试', ended: Date.now() }); }
  encrypt(value) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const bytes = Buffer.concat([cipher.update(String(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString('base64');
  }
  decrypt(value) {
    if (!value) return '';
    const bytes = Buffer.from(value, 'base64'), cipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
  }
  put(kind, obj) { this.db.prepare('INSERT OR REPLACE INTO records(kind,id,data) VALUES(?,?,?)').run(kind, obj.id, JSON.stringify(obj)); return obj; }
  get(kind, key) { const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, key); return row ? JSON.parse(row.data) : null; }
  list(kind) { return this.db.prepare('SELECT data FROM records WHERE kind=?').all(kind).map(r => JSON.parse(r.data)); }
  remove(kind, key) { this.db.prepare('DELETE FROM records WHERE kind=? AND id=?').run(kind, key); }
  user(key) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(key); }
  userByName(name) { return this.db.prepare('SELECT * FROM users WHERE name=? COLLATE NOCASE').get(name); }
  users() { return this.db.prepare('SELECT id,name,role,servers,created FROM users ORDER BY created').all().map(u => ({ ...u, servers: JSON.parse(u.servers) })); }
  addUser({ name, password, role = 'owner', servers = [] }) {
    const uid = id();
    this.db.prepare('INSERT INTO users(id,name,password,role,servers,created) VALUES(?,?,?,?,?,?)').run(uid, name, password, role, JSON.stringify(servers), Date.now());
    return this.user(uid);
  }
  audit(user, action, target = '', detail = {}) {
    const prev = this.db.prepare('SELECT hash FROM audit ORDER BY seq DESC LIMIT 1').get()?.hash || 'GENESIS';
    const time = Date.now(), text = redact(JSON.stringify(detail));
    const hash = crypto.createHmac('sha256', this.key).update(JSON.stringify([time, user, action, target, text, prev])).digest('hex');
    this.db.prepare('INSERT INTO audit(time,user,action,target,detail,previous,hash) VALUES(?,?,?,?,?,?,?)').run(time, user, action, target, text, prev, hash);
  }
  verifyAudit() {
    let previous = 'GENESIS';
    for (const row of this.db.prepare('SELECT * FROM audit ORDER BY seq').all()) {
      const hash = crypto.createHmac('sha256', this.key).update(JSON.stringify([row.time, row.user, row.action, row.target, row.detail, previous])).digest('hex');
      if (row.previous !== previous || hash !== row.hash) return false;
      previous = row.hash;
    }
    return true;
  }
  audits(limit = 200) { return this.db.prepare('SELECT * FROM audit ORDER BY seq DESC LIMIT ?').all(limit); }
  close() { this.db.close(); }
}
