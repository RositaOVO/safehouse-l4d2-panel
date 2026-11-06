import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { hashPassword } from './security.js';
import { loadConfig, atomicWrite } from './core.js';
import { execFileSync } from 'node:child_process';

const config = loadConfig(), store = new Store(config.dataDir);
try {
  const command = process.argv[2] || 'init';
  if (command === 'init') {
    if (store.users().length) { console.log('管理员已创建。'); }
    else {
      const password = crypto.randomBytes(24).toString('base64url');
      store.addUser({ name: 'admin', password: await hashPassword(password) });
      const file = path.join(config.dataDir, 'initial-access.txt');
      atomicWrite(file, `Safehouse 本机初始登录信息\n地址：${config.origin}\n账号：admin\n密码：${password}\n\n登录后请修改初始密码。请勿分享此文件。\n`);
      if (process.platform === 'win32') {
        try { execFileSync('icacls.exe', [config.dataDir, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F'], { windowsHide: true, stdio: 'ignore' }); } catch { console.warn('未能自动设置 ACL；请确认数据目录只允许当前账号和 SYSTEM 访问。'); }
      }
      store.audit('local-cli', 'admin.initialized'); console.log(`管理员已创建，登录信息保存在：${file}`);
    }
  } else if (command === 'reset-password') {
    const name = process.argv[3] || 'admin', user = store.userByName(name);
    if (!user) throw new Error('账号不存在');
    const password = crypto.randomBytes(24).toString('base64url');
    store.db.prepare('UPDATE users SET password=? WHERE id=?').run(await hashPassword(password), user.id);
    store.db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    atomicWrite(path.join(config.dataDir, 'initial-access.txt'), `账号：${user.name}\n密码：${password}\n原有会话已退出。\n`);
    store.audit('local-cli', 'admin.password_reset', user.id); console.log('已重置，请查看数据目录的 initial-access.txt。');
  } else throw new Error('支持命令：init、reset-password [用户名]');
} finally { store.close(); }
