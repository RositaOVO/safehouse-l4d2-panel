import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { createApp } from '../src/app.js';
import { loadConfig, projectRoot, AppError } from '../src/core.js';
import { hashPassword } from '../src/security.js';
import { tempDir, fixtureServer } from './helpers.js';
import { translate } from '../public/i18n.js';

// An isolated UI fixture: never reads the caller's data/ or starts a game.
const root = await tempDir(), password = crypto.randomBytes(24).toString('base64url');
let context, httpServer, browser;
try {
  const game = await fixtureServer(path.join(root, 'game'));
  const config = loadConfig({dataDir:path.join(root,'data'),allowedRoots:[root],origin:'http://127.0.0.1',host:'127.0.0.1',port:0,publicMode:false,trustProxy:false});
  context = await createApp(config);
  context.store.addUser({name:'admin',password:await hashPassword(password)});
  await context.servers.register({name:'地图 <img src=x onerror=alert(1)>',root:game,port:29998,bind:'127.0.0.1'});
  const workshopItem={id:'123456789',appId:550,type:0,title:'作者地图名称保留',description:'作者描述保持原文',size:1024,updated:1700000000,url:'https://steamcommunity.com/sharedfiles/filedetails/?id=123456789',preview:'',tags:['Campaigns']};
  context.workshop.search=async input=>({items:[workshopItem],total:1,page:input.page,source:'Steam 社区公开搜索'});
  context.workshop.resolve=async()=>({item:workshopItem,children:[]});
  context.store.put('task',{id:'demo-task',type:'安装工坊地图',status:'succeeded',message:'执行完成',progress:100,created:Date.now(),log:[{time:Date.now(),message:'原始游戏日志：保持中文，不翻译'}]});
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
  const checked=[],out=path.join(projectRoot,'test-results');await fs.mkdir(out,{recursive:true});
  for(const language of ['zh-CN','zh-TW','en']){
    const tr=key=>translate(key,{},language);
    if(language!=='zh-CN'){await page.locator('[data-language-select]').selectOption(language);await page.waitForFunction(lang=>document.documentElement.lang===lang,language);await page.locator('.nav [data-view=overview]').waitFor();await page.locator('.nav [data-view=overview]').click();await page.getByRole('heading',{name:tr('服务器总览'),exact:true}).waitFor();}
    assert.equal(await page.locator('html').getAttribute('lang'),language);
    assert.equal(await page.locator('img[src=x]').count(),0);
    assert((await page.locator('#server-select').innerText()).includes('地图 <img src=x onerror=alert(1)>'));
    for(const [view,title] of [['servers','服务器管理'],['workshop','发现下一场战役'],['maps','已安装地图'],['plugins','插件与扩展'],['players','玩家管理'],['configs','配置管理'],['console','实时控制台'],['tasks','任务与计划'],['backups','备份与恢复'],['notifications','通知中心'],['maintenance','维护清理'],['security','安全中心'],['accounts','账号与权限'],['audit','操作日志'],['settings','系统设置']]){
      await page.locator(`.nav [data-view="${view}"]`).click();await page.getByRole('heading',{name:tr(title),exact:true}).waitFor({timeout:15000});
      assert.equal(await page.locator('#content .notice.red').filter({hasText:tr('操作失败，请查看服务端日志')}).count(),0,title);checked.push({language,view});
      if(view==='workshop'){assert.equal(await page.locator('.map-card h3').innerText(),workshopItem.title);await page.getByRole('button',{name:tr('查看详情'),exact:true}).click();await page.getByRole('button',{name:tr('一键安装地图'),exact:true}).waitFor();assert((await page.locator('#dialog .description').innerText()).includes(workshopItem.description));await page.getByRole('button',{name:tr('关闭'),exact:true}).first().click();}
      if(view==='maps'){await page.getByRole('button',{name:tr('上传地图'),exact:true}).click();await page.locator('#upload-file').waitFor();await page.getByRole('button',{name:tr('关闭'),exact:true}).first().click();await page.getByRole('button',{name:tr('直链下载安装'),exact:true}).click();await page.locator('#direct-map-form').waitFor();await page.getByRole('button',{name:tr('关闭'),exact:true}).first().click();}
      if(view==='tasks'){assert((await page.locator('#content').innerText()).includes(tr('安装工坊地图')));await page.locator('[data-action=task-detail][data-id=demo-task]').click();await page.locator('#task-live').waitFor();assert((await page.locator('#task-live pre').first().innerText()).includes('原始游戏日志：保持中文，不翻译'));await page.getByRole('button',{name:tr('关闭'),exact:true}).first().click();}
      if(language==='en'){
        const leftovers=await page.locator('#content').evaluate(root=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT),found=[];let node;while(node=walker.nextNode()){if(!/\p{Script=Han}/u.test(node.textContent)||node.parentElement.closest('textarea,pre,.path,option'))continue;if(node.textContent.includes('地图 <img')||node.textContent.includes('作者地图')||node.textContent.includes('作者描述'))continue;found.push(node.textContent.trim());}return found.filter(Boolean);});
        assert.deepEqual(leftovers,[],`Untranslated UI in ${view}`);
      }
    }
    await page.screenshot({path:path.join(out,`i18n-${language}-desktop.png`),fullPage:true});
    await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:tr('打开菜单')}).click();await page.locator('.sidebar.open').waitFor();await page.locator('.nav [data-view=overview]').click();await page.getByRole('heading',{name:tr('服务器总览'),exact:true}).waitFor();
    await page.waitForFunction(()=>{const sidebar=document.querySelector('.sidebar');return !sidebar.classList.contains('open')&&sidebar.getBoundingClientRect().right<=1;});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),language+' mobile overflow');const bounds=await page.evaluate(()=>['.topbar','.content','.stats','.pagehead','.head-actions'].map(selector=>({selector,right:document.querySelector(selector).getBoundingClientRect().right,width:innerWidth})));assert(bounds.every(rect=>rect.right<=rect.width+1),JSON.stringify(bounds));await page.screenshot({path:path.join(out,`i18n-${language}-mobile.png`),fullPage:true});await page.screenshot({path:path.join(out,`i18n-${language}-mobile-viewport.png`)});await page.setViewportSize({width:1440,height:1000});
  }
  await page.reload();await page.getByRole('heading',{name:'Server overview',exact:true}).waitFor();assert.equal(await page.locator('[data-language-select]').inputValue(),'en');assert.equal(await page.evaluate(()=>localStorage.getItem('safehouse-language')),'en');
  await page.locator('.nav [data-view=configs]').click();await page.getByRole('heading',{name:'Configuration',exact:true}).waitFor();const editor=page.locator('#config-editor'),original=await editor.inputValue();await editor.fill(original+'\n// 未保存的草稿');page.once('dialog',dialog=>dialog.dismiss());await page.locator('[data-language-select]').selectOption('zh-TW');assert.equal(await page.locator('[data-language-select]').inputValue(),'en');assert((await editor.inputValue()).includes('未保存的草稿'));await editor.fill(original);
  const fresh=await browser.newContext({locale:'en-US'}),loginPage=await fresh.newPage();await loginPage.goto(config.origin);await loginPage.getByRole('heading',{name:'Welcome to Safehouse'}).waitFor();await loginPage.locator('[data-language-select]').selectOption('zh-TW');await loginPage.getByRole('heading',{name:translate('欢迎回到安全屋',{},'zh-TW')}).waitFor();await fresh.close();
  assert.deepEqual(errors,[]);await fs.writeFile(path.join(out,'smoke.json'),JSON.stringify({fixture:true,realGameStarted:false,workshopNetworkTested:false,views:checked,mobileLanguages:3,rememberedLanguage:true,userContentPreserved:true,rawLogsPreserved:true,unsavedChangesProtected:true,errors},null,2));
  console.log(`PASS isolated browser smoke: ${checked.length} localized pages, 3 mobile layouts, persisted language, unchanged user data and logs; no real game started.`);
} finally {
  await browser?.close();await context?.close();
  if(httpServer)await new Promise(resolve=>httpServer.close(resolve));
  await fs.rm(root,{recursive:true,force:true});
}
