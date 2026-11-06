export const state = { user: null, csrf: '', publicMode: false, view: 'overview', servers: [], sid: localStorage.getItem('safehouse-server') || '', steamItems: new Map(), search: { q: '', sort: 'popular', page: 1, tag: 'Campaigns' }, tasks: [], configPath: 'left4dead2/cfg/server.cfg', configOriginal: '', selectedItems: [], viewToken: 0 };
export const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
export const bytes = value => { if (!value) return '0 B'; const i = Math.min(Math.floor(Math.log(value) / Math.log(1024)), 4); return `${(value / 1024 ** i).toFixed(i ? 1 : 0)} ${['B', 'KB', 'MB', 'GB', 'TB'][i]}`; };
export const previewURL=value=>'/api/workshop/preview?url='+encodeURIComponent(value);
export const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
export const shortDate = value => value ? new Date(value).toLocaleDateString('zh-CN') : '—';
export const time = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
export const age = value => { const diff = Math.floor((Date.now() - value) / 1000); return diff < 60 ? '刚刚' : diff < 3600 ? `${Math.floor(diff / 60)} 分钟前` : diff < 86400 ? `${Math.floor(diff / 3600)} 小时前` : `${Math.floor(diff / 86400)} 天前`; };
export const can = permission => state.user?.role === 'owner' || ({ viewer: ['read'], operator: ['read', 'control', 'players', 'console'], maintainer: ['read', 'control', 'players', 'console', 'maps', 'plugins', 'config', 'backup'] }[state.user?.role] || []).includes(permission);
export const current = () => state.servers.find(s => s.id === state.sid);
export const statusNames = { running: '运行中', stopped: '已停止', unresponsive: '进程存在 · 查询无响应', queued: '排队中', succeeded: '已完成', failed: '失败', interrupted: '已中断', cancelled: '已取消', loaded: '已加载', unloaded: '未加载', unknown: '未查询到', pending: '等待生效' };
export function toast(message, error = false) { const node = document.createElement('div'); node.className = `toast${error ? ' error' : ''}`; node.textContent = message; document.querySelector('#toasts').append(node); setTimeout(() => node.remove(), error ? 8500 : 5000); }
export async function api(url, { method = 'GET', body, timeout=0, ...options } = {}) {
  const headers = { ...options.headers };
  if (method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  if (body && !(body instanceof FormData)) { body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let response;
  try{response = await fetch(`/api${url}`, { ...options, ...(timeout?{signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout)}:{}), method, body, headers, credentials: 'same-origin' });}
  catch(error){if(error.name==='TimeoutError')throw new Error('读取详情超时，请重试或在 Steam 查看');throw error;}
  const data = await response.json().catch(error => {if(['AbortError','TimeoutError'].includes(error.name))throw new Error('读取详情超时，请重试或在 Steam 查看');return { error: '服务器返回了无法识别的响应' };});
  if (!response.ok) { if (response.status === 401 && state.user && url !== '/auth/reauth') window.dispatchEvent(new Event('session-expired')); throw new Error(data.error || `请求失败 ${response.status}`); }
  return data;
}
const paths = {
  house:'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-6v-7h-4v7H4a1 1 0 0 1-1-1Z',
  grid:'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  server:'M4 3h16v7H4zM4 14h16v7H4zM7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6',
  globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  map:'m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3ZM9 3v15M15 6v15',
  plugin:'M9 3v4H5v4H2v4h3v6h6v-3h4v3h6v-6h-3v-4h3V7h-6V3Z',
  users:'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM17 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87',
  settings:'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  terminal:'m4 5 6 7-6 7M13 19h7',
  tasks:'M9 5h12M9 12h12M9 19h12m-19-14 1 1 2-2m-3 8 1 1 2-2m-3 8 1 1 2-2',
  backup:'M3 12a9 9 0 1 0 3-6.7M3 3v5h5M12 7v5l3 2',
  shield:'m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Zm-4 9 3 3 5-6',
  file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Zm0 0v6h6M8 13h8M8 17h6',
  download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload:'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  play:'m7 3 14 9-14 9Z',
  stop:'M5 5h14v14H5z',
  restart:'M21 5v6h-6M3 19v-6h6M5 7a8 8 0 0 1 13-2l3 6M3 13l3 6a8 8 0 0 0 13-2',
  search:'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-2 4 7 7',
  chevron:'m9 5 7 7-7 7',
  down:'m5 9 7 7 7-7',
  external:'M14 3h7v7m0-7-11 11M10 3H4v17h17v-6',
  plus:'M12 4v16M4 12h16',
  close:'m5 5 14 14M19 5 5 19',
  check:'m4 12 5 5L20 6',
  alert:'m12 3 10 18H2Zm0 5v6m0 3v.1',
  cpu:'M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
  disk:'m5 3-3 12v5h20v-5L19 3ZM2 15h20M17 18h2',
  lock:'M5 10h14v11H5zM8 10V6a4 4 0 0 1 8 0v4',
  clock:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  logout:'M9 3H3v18h6M9 12h12m-5-5 5 5-5 5',
  menu:'M3 6h18M3 12h18M3 18h18',
  trash:'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  copy:'M8 8h13v13H8zM16 8V3H3v13h5',
  folder:'M3 5h7l2 3h9v12H3Z'
};
export const icon = (name, cls = '') => `<svg aria-hidden="true" class="${cls}" viewBox="0 0 24 24"><path d="${paths[name] || paths.grid}"/></svg>`;
export const button = (label, action, iconName, cls = '', attrs = '') => `<button type="button" class="button ${cls}" data-action="${action}" ${attrs}>${iconName ? icon(iconName) : ''}${label}</button>`;
export const badge = (status, text) => `<span class="chip ${['failed','interrupted'].includes(status) ? 'red' : ['stopped','cancelled','unloaded','unknown'].includes(status) ? 'neutral' : ['queued','pending','unresponsive'].includes(status) ? 'amber' : ''}">${status === 'running' || status === 'loaded' ? '<span class="dot"></span>' : ''}${esc(text || statusNames[status] || status)}</span>`;
export const loading = message => `<div class="loading"><span class="loader"></span>${esc(message || '正在读取服务器数据…')}</div>`;
export const empty = (title, text, action = '') => `<div class="empty">${icon('server')}<h3>${esc(title)}</h3><p>${esc(text)}</p>${action}</div>`;
export const panel = (title, body, action = '') => `<section class="panel"><div class="panel-head"><h2>${title}</h2>${action}</div>${body}</section>`;
export const selector = () => `<select class="select" id="server-select" aria-label="选择服务器">${state.servers.length ? state.servers.map(s => `<option value="${s.id}" ${s.id === state.sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('') : '<option value="">尚未接管服务器</option>'}</select>`;
export const pageHead = (eyebrow, title, subtitle, actions = '', select = true) => `<div class="pagehead"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="subtitle">${subtitle}</p></div><div class="head-actions">${select ? selector() : ''}${actions}</div></div>`;
export function modal(title, html) { document.querySelector('#dialog-body').innerHTML = `<div class="dialog-head"><h2>${title}</h2><button data-action="close-dialog" aria-label="关闭">${icon('close')}</button></div><div class="dialog-content">${html}</div>`; const d = document.querySelector('#dialog'); if (!d.open) d.showModal(); }
export const closeModal = () => document.querySelector('#dialog').close();
export function formFields(fields) { return fields.map(([name,label,type='text',value='',hint='']) => `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${type === 'password' ? 'autocomplete="new-password"' : ''} required>${hint ? `<small>${hint}</small>` : ''}</div>`).join(''); }
export const formEnd = label => `<div class="dialog-error" id="form-error"></div><div class="dialog-actions">${button('取消','close-dialog',null,'ghost')}<button class="button primary" type="submit">${label}</button></div>`;
export function requireServer() { return state.sid ? '' : empty('先接管一台服务器', '面板会自动检查 Steam 库、常见安装位置和正在运行的游戏进程。', can('*') ? button('查找服务器','discover','search','primary') : '请联系管理员分配服务器权限。'); }
