import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import https from 'node:https';
import dns from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { directURL, directAddresses, requestDirect, downloadDirect } from '../src/direct-download.js';
import { Content } from '../src/content.js';
import { Store } from '../src/store.js';
import { Servers } from '../src/servers.js';
import { tempDir, fixtureServer, fixtureVpk, zipBuffer } from './helpers.js';

function network(t, route) {
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  const calls = [];
  t.mock.method(https, 'get', (url, options, callback) => {
    calls.push(url.href);
    const req = new EventEmitter(); req.setTimeout = () => req;
    req.destroy = error => { req.emit('error', error); req.emit('close'); };
    queueMicrotask(() => {
      const answer = route(url), response = Readable.from(answer.body ? [answer.body] : []);
      response.statusCode = answer.status || 200; response.headers = answer.headers || {};
      callback(response); req.emit('close');
    });
    return req;
  });
  return calls;
}
test('直链地址：拒绝私网、凭据、自定义端口及非 HTTP，DNS 混合地址也拒绝', async () => {
  for (const url of ['file:///etc/passwd','http://127.0.0.1/x','http://2130706433/x','http://[::1]/x','http://[::ffff:127.0.0.1]/x','http://169.254.169.254/x','https://10.0.0.1/a','https://user:pass@example.com/a','https://example.com:22/a','http://localhost/x','http://a.local/x','https://example.com/x#fragment']) assert.throws(() => directURL(url));
  assert.equal(directURL('http://example.com/map.vpk').protocol, 'http:');
  await assert.rejects(() => directAddresses('example.com', async () => [{ address:'8.8.8.8', family:4 }, { address:'192.168.1.1', family:4 }]));
  assert.equal((await directAddresses('example.com', async () => [{ address:'8.8.8.8', family:4 }]))[0].address, '8.8.8.8');
});
test('直链重定向：逐跳拦截内网、禁止 TLS 降级、限制跳转次数', async t => {
  let destination = 'https://127.0.0.1/private';
  const calls = network(t, () => ({ status:302, headers:{ location:destination } }));
  await assert.rejects(() => requestDirect('https://example.com/map'), /公网/); assert.equal(calls.length, 1);
  destination = 'http://example.com/map'; await assert.rejects(() => requestDirect('https://example.com/map'), /降级/);
  destination = 'https://example.com/loop'; await assert.rejects(() => requestDirect(destination), /4 次/);
});
test('直链下载：真实魔数识别、拒绝 HTML、超限及取消，失败不保留暂存文件', async () => {
  const root=await tempDir(), file=path.join(root,'file');
  const stream = (body, headers={}) => { const response=Readable.from([body]); response.headers=headers; return response; };
  try {
    const result=await downloadDirect('https://example.com/map',file,{maxBytes:1000,request:async()=>stream(fixtureVpk())}); assert.equal(result.extension,'vpk'); await fs.rm(file);
    await assert.rejects(()=>downloadDirect('https://example.com/map',file,{maxBytes:1000,request:async()=>stream(Buffer.from('<html>login</html>'))}),/不是 VPK/); await assert.rejects(()=>fs.stat(file));
    await assert.rejects(()=>downloadDirect('https://example.com/map',file,{maxBytes:5,request:async()=>stream(fixtureVpk())}),/大小/); await assert.rejects(()=>fs.stat(file));
    await assert.rejects(()=>downloadDirect('https://example.com/map',file,{maxBytes:5,request:async()=>stream(Buffer.alloc(1),{'content-length':'6'})}),/大小/);
    const controller=new AbortController(); controller.abort(); await assert.rejects(()=>downloadDirect('https://example.com/map',file,{maxBytes:1000,signal:controller.signal,request:async()=>stream(fixtureVpk())})); await assert.rejects(()=>fs.stat(file));
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
test('直链安装：VPK 与 ZIP 完整事务，校验值失败不写入、重名冲突拒绝、运行中拒绝', async t => {
  const root=await tempDir(), store=new Store(path.join(root,'data'));
  t.mock.method(fs, 'statfs', async () => ({ bavail: 1024 ** 3, bsize: 1 }));
  let body=fixtureVpk('direct_map'); network(t,()=>({body}));
  try {
    const game=await fixtureServer(path.join(root,'game')), config={allowedRoots:[root],uploadLimit:2*1024**3}, servers=new Servers(config,store,null);
    store.put('server',{id:'s',name:'Fixture',root:game});
    const content=new Content(config,store,servers,{}),ctx={signal:new AbortController().signal,update:()=>{}};
    await assert.rejects(()=>content.installMap('s',{directUrl:'https://example.com/map.vpk',checksum:'0'.repeat(64)},ctx),/SHA256/); assert.equal(store.list('map').length,0);
    const hash=createHash('sha256').update(body).digest('hex');
    const result=await content.installMap('s',{directUrl:'https://example.com/map.vpk?secret=not-persisted',checksum:hash},ctx);
    assert.deepEqual(result.maps,['direct_map']); assert.equal(store.list('map')[0].source,'direct'); assert(!JSON.stringify(store.list('map')).includes('not-persisted'));
    await assert.rejects(()=>content.installMap('s',{directUrl:'https://example.com/conflict.vpk'},ctx),/相同 BSP/);
    const archive=path.join(root,'map.zip'); await zipBuffer(archive,[['other.vpk',fixtureVpk('zip_direct_map')]]); body=await fs.readFile(archive);
    const zip=await content.installMap('s',{directUrl:'https://example.com/no-extension',filename:'地图.zip'},ctx); assert.deepEqual(zip.maps,['zip_direct_map']);
    servers.ensureStopped=async()=>{throw new Error('服务器仍在运行');}; await assert.rejects(()=>content.installMap('s',{directUrl:'https://example.com/other'},ctx),/仍在运行/);
    assert.deepEqual(await fs.readdir(path.join(store.dir,'staging')),[]);
  } finally { store.close(); await fs.rm(root,{recursive:true,force:true}); }
});
