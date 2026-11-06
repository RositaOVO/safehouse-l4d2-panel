import test from'node:test';import assert from'node:assert/strict';import https from'node:https';import{EventEmitter}from'node:events';import{Readable}from'node:stream';import{steamText}from'../src/network.js';
test('Steam 超时：已收到响应头但正文持续不结束，也会被总时限终止',async t=>{
 let interval;
 t.mock.method(https,'request',(_url,options,callback)=>{
   const req=new EventEmitter(),res=new Readable({read(){}});res.headers={};res.statusCode=200;
   req.setTimeout=()=>req;req.destroy=error=>{clearInterval(interval);res.destroy(error);req.emit('error',error);req.emit('close');};
   const abort=()=>req.destroy(new DOMException('aborted','AbortError'));options.signal.addEventListener('abort',abort,{once:true});
   req.end=()=>queueMicrotask(()=>{callback(res);res.push('data');interval=setInterval(()=>res.push('.'),5);});return req;
 });
 const start=Date.now();await assert.rejects(()=>steamText('https://api.steampowered.com/test',{timeout:60,attempts:1}),error=>error.status===504&&/超时/.test(error.message));assert(Date.now()-start<1000);clearInterval(interval);
});
