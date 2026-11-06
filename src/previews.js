import {requestSteam,steamURL}from'./network.js';
import {fail}from'./core.js';
export class Previews {
 constructor(){this.cache=new Map();this.pending=new Map();this.bytes=0;}
 async get(input){
  if(typeof input!=='string'||input.length>3000)fail(400,'封面地址无效');
  const url=steamURL(input);
  if(!['steamusercontent.com','steamstatic.com','steamuserimages-a.akamaihd.net'].some(host=>url.hostname===host||url.hostname.endsWith('.'+host)))fail(400,'封面仅允许 Steam 官方图片 CDN');
  const key=url.href,cached=this.cache.get(key);if(cached&&cached.expires>Date.now())return cached;
  if(this.pending.has(key))return this.pending.get(key);
  if(this.pending.size>=8)fail(429,'封面请求繁忙，请稍后重试');
  const pending=(async()=>{
   const response=await requestSteam(url,{timeout:15000});
   const chunks=[];let size=0;
   for await(const chunk of response){size+=chunk.length;if(size>4*1024**2){response.destroy();fail(413,'封面图片超过 4 MB');}chunks.push(chunk);}
   const body=Buffer.concat(chunks);let type;
   if(body.subarray(0,3).equals(Buffer.from([255,216,255])))type='image/jpeg';
   else if(body.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))type='image/png';
   else if(/^GIF8[79]a$/.test(body.subarray(0,6).toString('ascii')))type='image/gif';
   else if(body.subarray(0,4).toString()==='RIFF'&&body.subarray(8,12).toString()==='WEBP')type='image/webp';
   else if(body.subarray(4,8).toString()==='ftyp'&&/avif|avis/.test(body.subarray(8,24).toString()))type='image/avif';
   else fail(502,'Steam 未返回支持的封面图片');
   const item={body,type,expires:Date.now()+30*60000};
   const previous=this.cache.get(key);if(previous){this.cache.delete(key);this.bytes-=previous.body.length;}
   while(this.bytes+size>16*1024**2||this.cache.size>=64){const oldest=this.cache.keys().next().value;if(!oldest)break;this.bytes-=this.cache.get(oldest).body.length;this.cache.delete(oldest);}
   this.cache.set(key,item);this.bytes+=size;return item;
  })();this.pending.set(key,pending);
  try{return await pending;}finally{this.pending.delete(key);}
 }
}
