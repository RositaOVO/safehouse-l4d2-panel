import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createApp } from '../src/app.js';
import { loadConfig, projectRoot, AppError } from '../src/core.js';
import { hashPassword } from '../src/security.js';
import { tempDir, fixtureServer } from './helpers.js';

// An isolated UI fixture: never reads the caller's data/ or starts a game.
const root = await tempDir(), password = crypto.randomBytes(24).toString('base64url');
let context, httpServer, browser;
try {
  const game = await fixtureServer(path.join(root, 'game'));
  const config = loadConfig({dataDir:path.join(root,'data'),allowedRoots:[root],origin:'http://127.0.0.1',host:'127.0.0.1',port:0,publicMode:false,trustProxy:false});
  context = await createApp(config);
  context.store.addUser({name:'admin',password:await hashPassword(password)});
  await context.servers.register({name:'Demo L4D2 Server',root:game,port:29998,bind:'127.0.0.1'});
  // Explicit stopped-server double. No real A2S/RCON traffic is needed.
  context.servers.status = async server => ({...server,rcon:undefined,state:'stopped',info:null,processAlive:false});
  context.servers.command = async () => {throw new AppError(409,'Browser fixture has no running game server');};
  httpServer = context.app.listen(0,'127.0.0.1');
  await new Promise(resolve=>httpServer.once('listening',resolve));
  config.origin = `http://127.0.0.1:${httpServer.address().port}`;
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage({viewport:{width:1440,height:1000},locale:'zh-CN'}), errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(config.origin);
  await page.locator('#login-username').fill('admin');await page.locator('#login-password').fill(password);
  await page.locator('#login-form button[type=submit]').click();
  await page.getByRole('heading',{name:'服务器总览',exact:true}).waitFor();
  const checked=['overview'];
  for(const [view,title] of [['servers','服务器管理'],['maps','已安装地图'],['plugins','插件与扩展'],['players','玩家管理'],['configs','配置管理'],['console','实时控制台'],['tasks','任务与计划'],['backups','备份与恢复'],['notifications','通知中心'],['maintenance','维护清理'],['security','安全中心'],['accounts','账号与权限'],['audit','操作日志'],['settings','系统设置']]){
    await page.locator(`.nav [data-view="${view}"]`).click();
    await page.getByRole('heading',{name:title,exact:true}).waitFor({timeout:15000});
    assert.equal(await page.locator('#content .notice.red').filter({hasText:'操作失败'}).count(),0,title);checked.push(view);
  }
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'打开菜单'}).click();
  await page.locator('.sidebar.open').waitFor();await page.locator('.nav [data-view=overview]').click();
  await page.getByRole('heading',{name:'服务器总览',exact:true}).waitFor();
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.deepEqual(errors,[]);
  const out=path.join(projectRoot,'test-results');await fs.mkdir(out,{recursive:true});
  await fs.writeFile(path.join(out,'smoke.json'),JSON.stringify({fixture:true,realGameStarted:false,workshopNetworkTested:false,views:checked,mobile:true,errors},null,2));
  console.log(`PASS isolated browser smoke: ${checked.length} pages, password login, mobile layout; no real game started.`);
} finally {
  await browser?.close();await context?.close();
  if(httpServer)await new Promise(resolve=>httpServer.close(resolve));
  await fs.rm(root,{recursive:true,force:true});
}
