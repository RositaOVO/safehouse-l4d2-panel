import { fail } from './core.js';
import { steamJSON, steamText } from './network.js';

export function workshopId(input) {
  const text = String(input).trim();
  if (/^[1-9]\d{3,19}$/.test(text)) return text;
  let url; try { url = new URL(text); } catch { fail(400, '请输入有效的 Steam 工坊链接或项目 ID'); }
  if (url.protocol !== 'https:' || !['steamcommunity.com', 'www.steamcommunity.com'].includes(url.hostname) || url.username || url.password || url.port || !/^\/(sharedfiles|workshop)\/filedetails\/?$/.test(url.pathname)) fail(400, '只接受 Steam 工坊项目或合集链接');
  const value = url.searchParams.get('id');
  if (!/^[1-9]\d{3,19}$/.test(value || '')) fail(400, '工坊项目 ID 无效');
  return value;
}
function normalize(item) {
  return {
    id: String(item.publishedfileid), title: item.title || '未命名项目', description: item.description || item.short_description || '',
    author: item.creator || '', appId: Number(item.consumer_app_id ?? item.consumer_appid), type: Number(item.file_type ?? 0),
    preview: /^https:\/\//.test(item.preview_url || '') ? item.preview_url : '', size: Number(item.file_size || 0),
    updated: Number(item.time_updated || 0), tags: (item.tags || []).map(t => typeof t === 'string' ? t : t.tag),
    fileUrl: item.file_url || '', filename: item.filename || '', url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.publishedfileid}`
  };
}
function decodeHtml(value){return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi,(_m,e)=>{if(e[0]==='#'){const n=parseInt(e.slice(e[1]?.toLowerCase()==='x'?2:1),e[1]?.toLowerCase()==='x'?16:10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):'';}return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[e.toLowerCase()];});}
function divContent(html,name){const start=new RegExp(`<div\\b[^>]*class="[^"]*\\b${name}\\b[^"]*"[^>]*>`,'i').exec(html);if(!start)return '';let depth=1;const tags=/<\/?div\b[^>]*>/gi;tags.lastIndex=start.index+start[0].length;let m;while((m=tags.exec(html))){depth+=/^<\//.test(m[0])?-1:1;if(!depth)return html.slice(start.index+start[0].length,m.index);}return '';}
export function communityItem(html,pid){
  const appId=Number(html.match(/data-(?:miniprofile-)?appid="(\d+)"/)?.[1]);
  const title=decodeHtml(divContent(html,'workshopItemTitle').replace(/<[^>]*>/g,'')).trim();
  if(!title||!appId)fail(502,'Steam 社区未返回可读取的项目详情');
  const description=decodeHtml(divContent(html,'workshopItemDescription').replace(/<br\s*\/?\s*>|<\/div>/gi,'\n').replace(/<[^>]*>/g,''));
  const sizeMatch=html.match(/class="detailsStatRight"[^>]*>\s*([\d.,]+)\s*(KB|MB|GB|B)/i);
  const size=sizeMatch?Number(sizeMatch[1].replaceAll(',',''))*({B:1,KB:1e3,MB:1e6,GB:1e9}[sizeMatch[2].toUpperCase()]):0;
  const preview=decodeHtml(html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1]||'');
  const children=[...new Set([...html.matchAll(/class="collectionItem"[\s\S]*?sharedfiles\/filedetails\/\?id=(\d+)/g)].map(m=>m[1]))];
  return {id:pid,title,description,appId,type:/class="collectionChildren"/.test(html)?2:0,preview:preview.startsWith('https:')?preview:'',size,updated:0,author:html.match(/PublishedFile_Public_(\d{17})_/)?.[1]||'',tags:[],fileUrl:'',filename:'',url:`https://steamcommunity.com/sharedfiles/filedetails/?id=${pid}`,detailsSource:'community',communityChildren:children};
}
export class Workshop {
  constructor(config, store,transport={}) { this.config = config; this.store = store; this.cache = new Map();this.detailsCache=new Map();this.json=transport.json||steamJSON;this.text=transport.text||steamText; }
  remember(items){for(const item of items)if(item.id&&item.appId===550&&!item.error)this.detailsCache.set(item.id,{item,expires:Date.now()+300000});while(this.detailsCache.size>500)this.detailsCache.delete(this.detailsCache.keys().next().value);}
  async communityDetails(pid,{signal}={}){
    const item=communityItem(await this.text(`https://steamcommunity.com/sharedfiles/filedetails/?id=${pid}&l=english`,{timeout:6000,attempts:1,signal}),pid);
    if(item.appId!==550)return item;
    try{const found=await this.communitySearch({q:item.title,sort:'relevance',page:1,tag:'',signal,noDetails:true});const exact=found.items.find(x=>x.id===pid);if(exact)return {...exact,description:item.description||exact.description,detailsSource:'community',communityChildren:item.communityChildren};}catch(error){if(signal?.aborted)throw error;}
    return item;
  }
  async details(ids,{signal,refresh=false}={}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50) fail(400, '每次查询 1–50 个项目');
    ids=ids.map(workshopId);const missing=ids.filter(value=>refresh||!this.detailsCache.has(value)||this.detailsCache.get(value).expires<Date.now());
    if(!missing.length)return ids.map(value=>this.detailsCache.get(value).item);
    const form = new URLSearchParams({ itemcount: String(missing.length) });
    missing.forEach((value, i) => form.set(`publishedfileids[${i}]`, value));
    let fetched;
    try{const response = await this.json('https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/', { method: 'POST', body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },timeout:5000,attempts:1,signal });
    fetched=(response.response?.publishedfiledetails || []).map(item => {
      if (item.result !== 1) return { id: String(item.publishedfileid), error: `项目不可访问，Steam 状态码 ${item.result}` };
      return normalize(item);
    });}catch(error){if(signal?.aborted)throw error;if(missing.length>4)fail(502,'Steam 批量详情暂不可用，请稍后重试');fetched=await Promise.all(missing.map(pid=>this.communityDetails(pid,{signal})));}
    for(const item of fetched)this.detailsCache.set(item.id,{item,expires:Date.now()+300000});
    while(this.detailsCache.size>500)this.detailsCache.delete(this.detailsCache.keys().next().value);
    return ids.map(value=>this.detailsCache.get(value)?.item||{id:value,error:'Steam 未返回该项目详情'});
  }
  async resolve(input,{refresh=false,signal:caller}={}) {
    const deadline=AbortSignal.timeout(20000),signal=caller?AbortSignal.any([caller,deadline]):deadline;
    try{return await this.resolveWithin(input,{refresh,signal});}catch(error){if(deadline.aborted&&!caller?.aborted)fail(504,'Steam 详情读取超时，请稍后重试');throw error;}
  }
  async resolveWithin(input,{refresh=false,signal}={}){
    const pid = workshopId(input), [item] = await this.details([pid],{refresh,signal});
    if (!item || item.error) fail(404, item?.error || '工坊项目不存在');
    if (item.appId !== 550) fail(400, '该项目不属于求生之路 2');
    if (item.type === 2) {
      const form = new URLSearchParams({ collectioncount: '1', 'publishedfileids[0]': pid });
      let children;
      if(item.communityChildren?.length)children=item.communityChildren.map(publishedfileid=>({publishedfileid}));
      else{try{const response = await this.json('https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/', { method: 'POST', body: form.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },timeout:5000,attempts:1,signal });children=response.response?.collectiondetails?.[0]?.children||[];}catch(error){if(signal.aborted)throw error;const detail=await this.communityDetails(pid,{signal});if(!detail.communityChildren?.length)fail(502,'Steam 合集暂时无法展开，请稍后重试');children=detail.communityChildren.map(publishedfileid=>({publishedfileid}));}}
      if (children.length > 500) fail(400, '合集超过 500 项，请分批导入');
      const items = [];
      for (let i = 0; i < children.length; i += 50) items.push(...await this.details(children.slice(i, i + 50).map(x => x.publishedfileid),{signal}));
      return { item, children: items };
    }
    return { item, children: [] };
  }
  async search({ q = '', sort = 'popular', page = 1, tag = '' }) {
    if (q.length > 120 || page < 1 || page > 100 || !['popular', 'recent', 'updated', 'relevance'].includes(sort)) fail(400, '搜索参数无效');
    const cacheKey = JSON.stringify([q, sort, page, tag]), cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) return cached.value;
    const keyRecord = this.store.get('setting', 'steam');
    const key = this.config.steamApiKey || (keyRecord?.key ? this.store.decrypt(keyRecord.key) : '');
    let result;
    if (key) {
      const input = { query_type: { popular: 0, recent: 1, updated: 3, relevance: 12 }[sort], page, numperpage: 18, appid: 550, search_text: q, return_tags: true, return_short_description: true, ...(tag ? { requiredtags: [tag] } : {}) };
      const url = new URL('https://api.steampowered.com/IPublishedFileService/QueryFiles/v1/');
      url.searchParams.set('key', key); url.searchParams.set('input_json', JSON.stringify(input));
      try {
        const data = await this.json(url);
        if (!data.response?.publishedfiledetails) throw new Error('Steam API 没有返回搜索结果');
        result = { items: data.response.publishedfiledetails.map(normalize), total: data.response.total || 0, page, source: 'Steam Web API' };
      } catch (error) { result = await this.communitySearch({ q, sort, page, tag }); result.notice = `Web API 不可用，已切换 Steam 社区公开搜索：${error.message}`; }
    } else result = await this.communitySearch({ q, sort, page, tag });
    if (this.cache.size > 100) this.cache.clear();
    this.remember(result.items);this.cache.set(cacheKey, { expires: Date.now() + 120000, value: result }); return result;
  }
  async communitySearch({ q, sort, page, tag,signal,noDetails=false }) {
    const url = new URL('https://steamcommunity.com/workshop/browse/');
    for (const [key, value] of Object.entries({ appid: '550', searchtext: q, browsesort: { popular: 'trend', recent: 'mostrecent', updated: 'lastupdated', relevance: 'textsearch' }[sort], section: 'readytouseitems', p: String(page), l: 'schinese' })) url.searchParams.set(key, value);
    if (tag) url.searchParams.set('requiredtags[]', tag);
    const html = await this.text(url,{...(signal?{signal,timeout:6000,attempts:1}:{})});
    const script = html.match(/<script[^>]*id="valve-ssr-data"[^>]*>([\s\S]*?)<\/script>/i);
    let found;
    function visit(value, depth = 0) {
      if (depth > 22 || found) return;
      if (typeof value === 'string' && /^[\[{]/.test(value)) { try { visit(JSON.parse(value), depth + 1); } catch {} return; }
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.results) && (value.results[0]?.publishedfileid || value.total_count === 0)) { found = value; return; }
      for (const child of Object.values(value)) visit(child, depth + 1);
    }
    if (script) { try { visit(JSON.parse(script[1])); } catch {} }
    if (found) return { items: found.results.map(normalize), total: found.total_count, page, source: 'Steam 社区公开搜索' };
    const ids = [...new Set([...html.matchAll(/https:\/\/steamcommunity\.com\/sharedfiles\/filedetails\/\?id=(\d+)/g)].map(m => m[1]))].slice(0, 18);
    if (!ids.length) fail(502, 'Steam 搜索暂不可用；可粘贴项目链接，或配置 Steam Web API Key');
    if(noDetails)fail(502,'Steam 社区搜索没有返回完整元数据');
    return { items: (await this.details(ids,{signal})).filter(x => !x.error), total: null, page, source: 'Steam 社区公开搜索' };
  }
}
