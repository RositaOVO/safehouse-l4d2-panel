import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogs,normalizeLocale,negotiateLocale,translate,localizeMessage,setLocale,getLocale} from '../public/i18n.js';

test('语言协商：英语、简繁体、地区别名和 q 权重，非法值安全回退',()=>{
 assert.equal(normalizeLocale('en-GB'),'en');assert.equal(normalizeLocale('zh-Hant-HK'),'zh-TW');assert.equal(normalizeLocale('zh-SG'),'zh-CN');
 assert.equal(negotiateLocale('fr-FR,en-US;q=0.7,zh-TW;q=0.9'),'zh-TW');assert.equal(negotiateLocale('en;q=0,zh-CN;q=0.8'),'zh-CN');
 assert.equal(negotiateLocale('en;q=NaN,zh-TW;q=2,*'),'zh-CN');assert.equal(normalizeLocale('<script>alert(1)</script>'),null);
});
test('语言目录：英文和繁体完整对应，插值参数不缺失、不引入 HTML',()=>{
 const keys=Object.keys(catalogs.en).sort();assert(keys.length>=894);assert.deepEqual(Object.keys(catalogs['zh-TW']).sort(),keys);
 const tokens=text=>[...text.matchAll(/\{\d+\}/g)].map(m=>m[0]).sort();
 for(const key of keys)for(const locale of ['en','zh-TW']){const message=catalogs[locale][key];assert.equal(typeof message,'string');assert(message.trim().length);assert.deepEqual(tokens(message),tokens(key),key);assert(!/<\/?[a-z]/i.test(message),key);}
});
test('翻译：未知文本、用户数据和原始游戏日志保持原文，参数不会当作模板再次展开',()=>{
 assert.equal(translate('服务器管理',{},'en'),'Servers');assert.equal(translate('服务器管理',{},'zh-TW'),'伺服器管理');
 const input='My 地图 <img src=x> {1}';assert.equal(translate('未知 '+input,{},'en'),'未知 '+input);
 assert.equal(translate('目标：{0}。{1}',{0:input,1:'Ready'},'en'),'Target: '+input+'. Ready');
 assert.equal(localizeMessage('L 11/06 - 游戏插件原始日志 <not markup>','en'),'L 11/06 - 游戏插件原始日志 <not markup>');
 assert.equal(translate('constructor',{},'en'),'constructor');
});
test('历史任务与服务端错误：动态路径、数字和嵌套错误翻译，不修改原始记录',()=>{
 const message='磁盘空间不足：/srv/l4d2 可用 1 GiB，本步需新增 2 GiB，另保留 256 MiB 安全余量（合计需 2.25 GiB）';
 assert.equal(localizeMessage(message,'en'),'Insufficient disk space: /srv/l4d2 has 1 GiB available; this step needs 2 GiB plus a 256 MiB safety reserve (2.25 GiB required in total)');
 assert.equal(localizeMessage('安装工坊地图','en'),'Install Workshop map');assert.equal(localizeMessage('参数错误：密码不正确','en'),'Invalid parameters: Incorrect password');
 assert.equal(localizeMessage(message,'zh-CN'),message);assert.equal(localizeMessage('下载 urban：2.5 MB','en'),'Downloading urban: 2.5 MB');
});
test('语言选择：仅接受声明的语言 ID，不接受任意 URL 或脚本，状态可恢复',()=>{
 const before=getLocale();try{assert.equal(setLocale('en'),'en');assert.equal(getLocale(),'en');assert.throws(()=>setLocale('javascript:alert(1)'));assert.equal(getLocale(),'en');}finally{setLocale(before);}
});
