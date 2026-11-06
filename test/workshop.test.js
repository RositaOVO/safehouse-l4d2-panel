import test from'node:test';import assert from'node:assert/strict';
import {Workshop,communityItem}from'../src/workshop.js';
const pid='121086524',raw={publishedfileid:pid,result:1,title:'Urban Flight',description:'full description',consumer_appid:550,file_type:0,file_size:'200430361',time_updated:123456,file_url:'https://cdn.steamusercontent.com/ugc/map.vpk'},store={get:()=>null};
const ssr=(items=[raw])=>`<script id="valve-ssr-data" type="application/json">${JSON.stringify({data:{results:items,total_count:items.length}})}</script>`;
const html=`<a data-appid="550"></a><meta property="og:image" content="https://images.steamusercontent.com/ugc/image?a=1&amp;b=2"><div class="workshopItemTitle">Urban &amp; Flight</div><div class="workshopItemDescription" id="highlightContent">first<br><div class="bb_h1">nested</div>last &lt;script&gt;</div><div class="detailsStatRight">200.430 MB</div>`;
test('工坊详情：搜索结果填充详情缓存，点击及下载解析无需再次请求不可达的 API',async()=>{
 let calls=0;const workshop=new Workshop({},store,{text:async()=>ssr(),json:async()=>{calls++;throw new Error('must not call API');}});
 await workshop.search({q:'urban',sort:'relevance',page:1,tag:''});const data=await workshop.resolve(pid);
 assert.equal(data.item.title,'Urban Flight');assert.equal(data.item.fileUrl,raw.file_url);assert.equal(calls,0);
});
test('工坊详情：API 失败后读取社区说明并匹配准确 ID 的真实下载元数据',async()=>{
 let calls=0;const workshop=new Workshop({},store,{json:async(_url,options)=>{calls++;assert.equal(options.timeout,5000);assert.equal(options.attempts,1);throw new Error('timeout');},text:async url=>String(url).includes('/filedetails/')?html:ssr()});
 const {item}=await workshop.resolve(pid);assert.equal(item.fileUrl,raw.file_url);assert.equal(item.updated,raw.time_updated);assert.equal(item.description,'first\nnested\nlast <script>');assert.equal(item.detailsSource,'community');assert.equal(calls,1);
 await workshop.resolve(pid);assert.equal(calls,1);
});
test('工坊详情：社区页面处理嵌套描述与实体，缺失标题和其他游戏不能伪装成地图',async()=>{
 const item=communityItem(html,pid);assert.equal(item.title,'Urban & Flight');assert.equal(item.size,200430000);assert.equal(item.preview,'https://images.steamusercontent.com/ugc/image?a=1&b=2');assert.equal(item.fileUrl,'');assert.throws(()=>communityItem('<html>not found</html>',pid));
 const workshop=new Workshop({},store,{json:async()=>{throw new Error('timeout');},text:async()=>html.replace('data-appid="550"','data-appid="570"')});await assert.rejects(()=>workshop.resolve(pid),/不属于/);
});
test('工坊详情：过期缓存重新获取，强制刷新失败明确抛错，不返回虚假的成功结果',async()=>{
 let calls=0;const workshop=new Workshop({},store,{json:async()=>{calls++;return{response:{publishedfiledetails:[raw]}};},text:async()=>{throw new Error('offline');}});
 workshop.detailsCache.set(pid,{item:{id:pid,title:'old'},expires:0});assert.equal((await workshop.resolve(pid)).item.title,'Urban Flight');assert.equal(calls,1);
 workshop.json=async()=>{throw new Error('offline');};await assert.rejects(()=>workshop.resolve(pid,{refresh:true}),/offline/);
});
test('工坊详情：合集必须展开子项目，不将合集本身当成可安装地图',async()=>{
 const workshop=new Workshop({},store,{json:async url=>{assert(String(url).includes('GetCollectionDetails'));return{response:{collectiondetails:[{children:[{publishedfileid:pid}]}]}};}});
 workshop.remember([{id:'99998888',title:'Collection',appId:550,type:2},{id:pid,title:'Map',appId:550,type:0}]);const data=await workshop.resolve('99998888');assert.equal(data.children.length,1);assert.equal(data.children[0].id,pid);
});
test('工坊详情：后备搜索失败仍显示可信社区详情，不伪造下载地址',async()=>{
 const workshop=new Workshop({},store,{json:async()=>{throw new Error('offline');},text:async url=>{if(String(url).includes('/filedetails/'))return html;throw new Error('offline');}});const {item}=await workshop.resolve(pid);assert.equal(item.detailsSource,'community');assert.equal(item.fileUrl,'');assert.equal(item.updated,0);
});
