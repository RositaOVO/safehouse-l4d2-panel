import {fail} from './core.js';
const channels={chat:['sm_say'],hint:['sm_hsay'],center:['sm_csay'],both:['sm_say','sm_hsay']};
export function announcementCommands(message,channel='both'){
  if(typeof message!=='string'||!message.trim())fail(400,'请输入公告');
  message=message.trim();
  if(/["\\;\x00-\x1f\x7f\u2028\u2029]/.test(message))fail(400,'公告不能包含双引号、反斜杠、分号或控制字符');
  if(Buffer.byteLength(message,'utf8')>160)fail(400,'公告最多 160 字节，中文约 53 字，请缩短内容');
  if(!Object.hasOwn(channels,channel))fail(400,'公告显示位置无效');
  return channels[channel].map(name=>({name,command:`${name} "${message}"`}));
}
export async function sendAnnouncement(servers,server,message,channel='both'){
  const commands=announcementCommands(message,channel);
  // No-argument usage queries verify availability without broadcasting a message.
  for(const {name}of commands){const help=await servers.command(server,name);if(!help.includes(`[SM] Usage: ${name} `))fail(409,`公告命令 ${name} 不可用，请确认 SourceMod 的 Basic Chat 已启用并加载`);}
  const results=[];
  for(const {name,command}of commands){const output=await servers.command(server,command);if(/^\s*(?:Unknown command\b|\[SM\].*(?:Unknown command|not found|Usage:))/im.test(output))fail(409,`公告命令 ${name} 被服务器拒绝，请检查 Basic Chat`);results.push({command:name,output});}
  return {channel,submitted:true,results,note:'已向游戏提交公告；无法从 RCON 确认每位玩家实际看见。'};
}
