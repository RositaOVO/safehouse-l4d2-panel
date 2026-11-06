import net from 'node:net';
import dgram from 'node:dgram';
import { AppError } from './core.js';

export function rconPacket(id, type, text = '') {
  const payload = Buffer.from(text), packet = Buffer.alloc(payload.length + 14);
  packet.writeInt32LE(payload.length + 10); packet.writeInt32LE(id, 4); packet.writeInt32LE(type, 8); payload.copy(packet, 12);
  return packet;
}
export function rcon({ host = '127.0.0.1', port = 27015, password, command, timeout = 5000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }); let buffer = Buffer.alloc(0), output = '', authorized = false, done = false;
    const timer = setTimeout(() => finish(new AppError(504, 'RCON 响应超时，请检查密码、端口和服务器状态')), timeout);
    function finish(error) { if (done) return; done = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(output.trim()); }
    socket.on('connect', () => socket.write(rconPacket(10, 3, password)));
    socket.on('error', () => finish(new AppError(502, '无法连接本机游戏 RCON 接口')));
    socket.on('close', () => { if (!done) finish(new AppError(502, 'RCON 连接提前关闭')); });
    socket.on('data', bytes => {
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > 4 * 1024 ** 2) return finish(new AppError(502, 'RCON 返回数据过大'));
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE();
        if (size < 10 || size > 4096 * 1024) return finish(new AppError(502, 'RCON 数据包无效'));
        if (buffer.length < size + 4) break;
        const packet = buffer.subarray(0, size + 4); buffer = buffer.subarray(size + 4);
        const id = packet.readInt32LE(4), type = packet.readInt32LE(8), text = packet.subarray(12, size + 2).toString();
        if (id === -1) return finish(new AppError(502, 'RCON 认证失败，请检查服务器连接设置'));
        if (!authorized && id === 10 && type === 2) {
          authorized = true;
          socket.write(rconPacket(20, 2, command));
          socket.write(rconPacket(21, 0, ''));
        } else if (authorized && id === 20) {
          output += text;
          if (output.length > 2 * 1024 ** 2) return finish(new AppError(502, 'RCON 输出超出限制'));
        } else if (authorized && id === 21) return finish();
      }
    });
  });
}
function cstring(buffer, state) {
  const end = buffer.indexOf(0, state.pos);
  if (end < 0 || end - state.pos > 4096) throw new Error('无效的服务器查询字符串');
  const value = buffer.subarray(state.pos, end).toString('utf8'); state.pos = end + 1; return value;
}
export function parseInfo(bytes) {
  if (bytes.length < 10 || bytes.readInt32LE() !== -1 || bytes[4] !== 0x49) throw new Error('不支持的服务器查询响应');
  const cursor = { pos: 6 };
  const name = cstring(bytes, cursor), map = cstring(bytes, cursor), folder = cstring(bytes, cursor), game = cstring(bytes, cursor);
  if (cursor.pos + 9 > bytes.length) throw new Error('查询数据不完整');
  const appId = bytes.readUInt16LE(cursor.pos); cursor.pos += 2;
  const players = bytes[cursor.pos++], maxPlayers = bytes[cursor.pos++], bots = bytes[cursor.pos++];
  const serverType = String.fromCharCode(bytes[cursor.pos++]), environment = String.fromCharCode(bytes[cursor.pos++]);
  const password = !!bytes[cursor.pos++], vac = !!bytes[cursor.pos++], version = cstring(bytes, cursor);
  return { name, map, folder, game, appId, players, maxPlayers, bots, serverType, environment, password, vac, version };
}
export function queryInfo({ host = '127.0.0.1', port = 27015, timeout = 1800 }) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4'), base = Buffer.concat([Buffer.from([255, 255, 255, 255, 0x54]), Buffer.from('Source Engine Query\0')]);
    let done = false, challengeSent = false;
    const finish = (err, result) => { if (done) return; done = true; clearTimeout(timer); socket.close(); err ? reject(err) : resolve(result); };
    const timer = setTimeout(() => finish(new AppError(504, '游戏查询超时')), timeout);
    socket.on('error', e => finish(e));
    socket.on('message', (data, remote) => {
      if (remote.port !== port || data.length < 5) return;
      if (data[4] === 0x41 && data.length === 9 && !challengeSent) { challengeSent = true; socket.send(Buffer.concat([base, data.subarray(5)]), port, host); return; }
      try { finish(null, parseInfo(data)); } catch (error) { finish(error); }
    });
    socket.send(base, port, host, err => { if (err) finish(err); });
  });
}
export function parsePlugins(text) {
  const plugins = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(?:(<[^>]+>)\s*)?"([^"]+)"(?:\s*\(([^)]+)\))?(?:\s+by\s+(.+))?/);
    if (match) plugins.push({ runtimeId: Number(match[1]), name: match[3], version: match[4] || '', author: match[5] || '', runtime: match[2] ? (/fail|error/i.test(match[2]) ? 'failed' : match[2].replace(/[<>]/g, '').toLowerCase()) : 'loaded' });
  }
  return plugins;
}
export function parseStatus(text) {
  const players = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^#\s*(\d+)\s+(?:\d+\s+)?"(.*)"\s+(STEAM_[0-5]:[01]:\d+|\[U:1:\d+\]|BOT)\s+(.*)$/);
    if (match) players.push({ userid: Number(match[1]), name: match[2], steamId: match[3], connection: match[4] });
  }
  return players;
}
export function parseRconInfo(text) {
  const name = text.match(/^hostname:[ \t]*(.*)$/m)?.[1]?.trim() || 'Left 4 Dead 2', map = text.match(/^map[ \t]*:[ \t]*([^\s]+)/m)?.[1];
  const counts = text.match(/^players\s*:\s*(\d+) humans,\s*(\d+) bots\s*\((\d+) max\)/m);
  if (!name || !map || !counts) throw new Error('RCON 未返回有效的 L4D2 状态');
  return { name, map, players: Number(counts[1]) + Number(counts[2]), bots: Number(counts[2]), maxPlayers: Number(counts[3]), version: text.match(/^version\s*:\s*(.+)$/m)?.[1]?.trim() || '', folder: 'left4dead2', game: 'Left 4 Dead 2', appId: 550, source: 'RCON' };
}
export function keyValues(input) {
  const tokens = (input.replace(/^\uFEFF/, '').match(/"(?:\\.|[^"\\])*"|\/\/[^\n\r]*|[{}]|[^\s{}"]+/g) || []).filter(token => !token.startsWith('//'));
  let i = 0;
  const atom = token => token?.startsWith('"') ? token.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\') : token;
  function parse(level = 0) {
    if (level > 32) throw new Error('配置嵌套过深');
    const out = {};
    while (i < tokens.length) {
      if (tokens[i] === '}') { i++; break; }
      const key = atom(tokens[i++]);
      const token = tokens[i++];
      if (!key || !token) break;
      const val = token === '{' ? parse(level + 1) : atom(token);
      if (Object.hasOwn(out, key)) out[key] = Array.isArray(out[key]) ? [...out[key], val] : [out[key], val]; else out[key] = val;
    }
    return out;
  }
  return parse();
}
