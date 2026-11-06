import fs from 'node:fs/promises';
import path from 'node:path';
import { fail, safeRelative, safePath } from './core.js';
import { keyValues } from './protocols.js';

export async function inspectVpk(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(), head = Buffer.alloc(28);
    await handle.read(head, 0, 28, 0);
    if (stat.size < 12 || head.readUInt32LE() !== 0x55aa1234) fail(400, '不是有效的 VPK 文件');
    const version = head.readUInt32LE(4), treeSize = head.readUInt32LE(8), headerSize = version === 1 ? 12 : 28;
    if (![1, 2].includes(version) || treeSize > 32 * 1024 ** 2 || treeSize + headerSize > stat.size) fail(400, 'VPK 头部或目录树无效');
    const tree = Buffer.alloc(treeSize); await handle.read(tree, 0, treeSize, headerSize);
    let cursor = 0; const entries = [], paths = new Set();
    function text() { const end = tree.indexOf(0, cursor); if (end < 0 || end - cursor > 1024) fail(400, 'VPK 字符串无效'); const value = tree.subarray(cursor, end).toString('utf8'); cursor = end + 1; return value; }
    for (let ext = text(); ext; ext = text()) {
      for (let dir = text(); dir; dir = text()) {
        for (let name = text(); name; name = text()) {
          if (entries.length > 200000 || cursor + 18 > tree.length) fail(400, 'VPK 条目过多或损坏');
          const preloadSize = tree.readUInt16LE(cursor + 4), archive = tree.readUInt16LE(cursor + 6), offset = tree.readUInt32LE(cursor + 8), length = tree.readUInt32LE(cursor + 12), terminator = tree.readUInt16LE(cursor + 16);
          cursor += 18;
          if (terminator !== 65535 || cursor + preloadSize > tree.length) fail(400, 'VPK 条目结构损坏');
          const relative = `${dir === ' ' ? '' : dir + '/'}${name}${ext === ' ' ? '' : '.' + ext}`;
          safeRelative(relative);
          if (paths.has(relative.toLowerCase())) fail(400, 'VPK 包含重复资源路径'); paths.add(relative.toLowerCase());
          if (archive === 0x7fff && headerSize + treeSize + offset + length > stat.size) fail(400, 'VPK 数据范围无效');
          entries.push({ path: relative, archive, offset, length, preload: tree.subarray(cursor, cursor + preloadSize) });
          cursor += preloadSize;
        }
      }
    }
    const maps = entries.filter(e => /^maps\/[^/]+\.bsp$/i.test(e.path)).map(e => path.basename(e.path).replace(/\.bsp$/i,''));
    const archives = [...new Set(entries.filter(e => e.archive !== 0x7fff).map(e => e.archive))];
    const base = path.basename(file).replace(/_dir\.vpk$/i, '');
    if (archives.length && !/_dir\.vpk$/i.test(file)) fail(400, '分卷 VPK 的索引文件必须以 _dir.vpk 结尾');
    for (const index of archives) {
      const partName = `${base}_${String(index).padStart(3, '0')}.vpk`;
      const part = await safePath(path.dirname(file), partName, { allowMissing: false }).catch(() => fail(400, `缺少 VPK 分卷 ${partName}`));
      const size = (await fs.stat(part)).size;
      if (entries.some(e => e.archive === index && e.offset + e.length > size)) fail(400, `VPK 分卷数据不完整：${partName}`);
    }
    const missions = [];
    for (const entry of entries.filter(e => /^missions\/[^/]+\.txt$/i.test(e.path)).slice(0, 20)) {
      if (entry.length + entry.preload.length > 1024 ** 2) continue;
      let content;
      if (entry.archive === 0x7fff) {
        const buffer = Buffer.alloc(entry.length); await handle.read(buffer, 0, buffer.length, headerSize + treeSize + entry.offset); content = Buffer.concat([entry.preload, buffer]);
      } else {
        const part = await fs.open(path.join(path.dirname(file), `${base}_${String(entry.archive).padStart(3, '0')}.vpk`), 'r');
        try { const buffer = Buffer.alloc(entry.length); await part.read(buffer, 0, buffer.length, entry.offset); content = Buffer.concat([entry.preload, buffer]); } finally { await part.close(); }
      }
      try { missions.push(keyValues(content.toString('utf8'))); } catch {}
    }
    return { version, size: stat.size, maps, archives, resources: entries.map(e => e.path), missions };
  } finally { await handle.close(); }
}
export async function checkSmx(file) {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat(), head = Buffer.alloc(24); await handle.read(head, 0, 24, 0);
    if (stat.size < 24 || head.toString('ascii', 0, 4) !== 'FFPS' || head.readUInt32LE(7) !== stat.size || head.readUInt32LE(11) > 128 * 1024 ** 2 || head[6] > 1) fail(400, 'SourceMod 插件文件头无效或体积异常');
    return true;
  } finally { await handle.close(); }
}
