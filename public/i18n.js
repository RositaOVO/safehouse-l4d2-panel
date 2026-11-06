import en from './locales/en.js';
import traditional from './locales/zh-TW.js';

export const languages=Object.freeze([{id:'zh-CN',name:'简体中文'},{id:'zh-TW',name:'繁體中文'},{id:'en',name:'English'}]);
export const catalogs=Object.freeze({en,'zh-TW':traditional});
export function normalizeLocale(value){
 const tag=String(value||'').trim().replaceAll('_','-').toLowerCase();
 if(/^en(?:-|$)/.test(tag))return'en';
 if(/^zh(?:-|$)/.test(tag)){if(tag.split('-').includes('hans'))return'zh-CN';return /(?:^|-)(?:hant|tw|hk|mo)(?:-|$)/.test(tag)?'zh-TW':'zh-CN';}
 return null;
}
export function negotiateLocale(header,fallback='zh-CN'){
 const entries=String(header||'').split(',').map((part,index)=>{const[tag,...options]=part.trim().split(';');const quality=options.find(p=>/^\s*q=/i.test(p));const q=quality?Number(quality.split('=')[1]):1;return{locale:normalizeLocale(tag),q,index};}).filter(e=>e.locale&&e.q>0&&e.q<=1).sort((a,b)=>b.q-a.q||a.index-b.index);
 return entries[0]?.locale||fallback;
}
function initialLocale(){
 if(typeof window==='undefined')return'zh-CN';
 let saved;try{saved=window.localStorage.getItem('safehouse-language');}catch{}
 const explicit=normalizeLocale(new URL(window.location.href).searchParams.get('lang'))||normalizeLocale(saved);
 return explicit||negotiateLocale((window.navigator.languages||[window.navigator.language]).join(','),'en');
}
let locale=initialLocale();
export const getLocale=()=>locale;
export function setLocale(value){const next=normalizeLocale(value);if(!languages.some(item=>item.id===value)||!next)throw new Error('Unsupported language');locale=next;try{globalThis.localStorage?.setItem('safehouse-language',next);}catch{}return next;}
const escapePattern=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const patterns=Object.keys(en).filter(key=>/\{\d+\}/.test(key)).sort((a,b)=>b.replace(/\{\d+\}/g,'').length-a.replace(/\{\d+\}/g,'').length).map(key=>{const names=[],parts=[];let cursor=0;for(const match of key.matchAll(/\{(\d+)\}/g)){parts.push(escapePattern(key.slice(cursor,match.index)),'([\\s\\S]*?)');names.push(match[1]);cursor=match.index+match[0].length;}parts.push(escapePattern(key.slice(cursor)));return{key,names,regex:new RegExp('^'+parts.join('')+'$')};});
function format(text,params){return text.replace(/\{(\d+)\}/g,(whole,key)=>Object.hasOwn(params,key)?String(params[key]):whole);}
// Only explicit application-owned strings use this function. Names, config
// contents and raw game logs never pass through an automatic DOM translator.
export function translate(key,params={},target=locale){
 const text=String(key??''),normalized=normalizeLocale(target)||'zh-CN',messages=catalogs[normalized];
 return format(messages&&Object.hasOwn(messages,text)?messages[text]:text,params);
}
export function localizeMessage(value,target=locale,depth=0){
 const text=String(value??''),normalized=normalizeLocale(target)||'zh-CN';
 if(normalized==='zh-CN'||depth>3||text.length>10000)return text;
 if(Object.hasOwn(en,text))return translate(text,{},normalized);
 if(!/\p{Script=Han}/u.test(text))return text;
 for(const entry of patterns){const match=entry.regex.exec(text);if(!match)continue;const params=Object.fromEntries(entry.names.map((name,index)=>[name,localizeMessage(match[index+1],normalized,depth+1)]));return translate(entry.key,params,normalized);}
 return text;
}
export function applyDocumentLocale(){if(typeof document==='undefined')return;document.documentElement.lang=locale;document.title=translate('SAFEHOUSE · 求生之路 2 控制中心');}
export function languageControl(){return `<label class="language-switcher"><span class="sr-only">${translate('语言')}</span><select data-language-select class="select language-select" aria-label="${translate('语言')}">${languages.map(item=>`<option value="${item.id}"${item.id===locale?' selected':''}>${item.name}</option>`).join('')}</select></label>`;}
