import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { crc32 } from 'node:zlib';
import * as tar from 'tar';
import { fail, safeRelative, safePath, walk } from './core.js';
import { ensureFileSpace, ensureDiskSpace, diskSpaceGuard } from './disk-space.js';

export async function extractZip(file, destination, { maxBytes = 2 * 1024 ** 3, maxEntries = 10000, accept = () => true,normalizeBackslashes=false } = {}) {
  await fsp.mkdir(destination, { recursive: true });
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: !normalizeBackslashes }, (err, value) => err ? reject(err) : resolve(value)));
  let total = 0, count = 0; const names = new Set(), files = [];
  try {
    await new Promise((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', entry => {
        (async () => {
          if (++count > maxEntries) fail(400, '压缩包文件数量超出限制');
          if ((entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) fail(400, '禁止压缩包中的符号链接');
          if (entry.generalPurposeBitFlag & 1) fail(400, '不支持加密压缩包');
          const name = entry.fileName.replace(/\/$/, ''); safeRelative(name);
          const folded = name.toLowerCase();
          if (names.has(folded)) fail(400, '压缩包包含重复或大小写冲突路径');
          names.add(folded);
          if (entry.fileName.endsWith('/')) { zip.readEntry(); return; }
          if (!accept(name)) fail(400, `压缩包包含未授权文件：${name}`);
          total += entry.uncompressedSize;
          if (total > maxBytes || entry.uncompressedSize / Math.max(entry.compressedSize, 1) > 1000) fail(400, '压缩包解压体积或压缩率超出限制');
          const target = await safePath(destination, name); await fsp.mkdir(path.dirname(target), { recursive: true });
          await ensureFileSpace(target, entry.uncompressedSize);
          const stream = await new Promise((resolve, reject) => zip.openReadStream(entry, (err, value) => err ? reject(err) : resolve(value)));
          let size = 0, crc = 0;
          const guard = new Transform({ transform(chunk, enc, cb) { size += chunk.length; crc = crc32(chunk, crc); cb(size > entry.uncompressedSize ? new Error('解压大小异常') : null, chunk); } });
          await pipeline(stream, guard, diskSpaceGuard(target), fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          if (size !== entry.uncompressedSize || crc !== entry.crc32) fail(400, '压缩包文件校验失败');
          files.push(name); zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    return files;
  } finally { zip.close(); }
}
export async function createZip(source, destination, { accept = () => true, extras = {}, roots = [''] } = {}) {
  const files = [];
  for(const relative of roots){const root=relative?await safePath(source,relative):source;files.push(...await walk(root,{depth:20,limit:50000,filter:file=>accept(path.relative(source,file).split(path.sep).join('/'))}));}
  const zip = new yazl.ZipFile();
  const output = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
  const finished = pipeline(zip.outputStream, output);
  for (const file of files) {
    const relative = path.relative(source, file).split(path.sep).join('/');
    await safePath(source, relative, { allowMissing: false });
    zip.addFile(file, relative);
  }
  for (const [name, text] of Object.entries(extras)) zip.addBuffer(Buffer.from(text), name);
  zip.end(); await finished; return files.length;
}
export async function extractTar(file, destination, { maxBytes = 2 * 1024 ** 3, maxEntries = 10000, accept = () => true } = {}) {
  let total = 0, count = 0, error; const seen = new Set(), files = [];
  const normalize = name => name.replace(/^(\.\/)+/, '').replace(/\/$/, '');
  await tar.t({ file, strict: true, onReadEntry(entry) {
    try {
      const name = normalize(entry.path); if (!name && entry.type === 'Directory') return;
      safeRelative(name);
      if (!['File', 'Directory'].includes(entry.type)) fail(400, 'TAR 中不允许符号链接、硬链接或设备文件');
      if (++count > maxEntries || (total += entry.size) > maxBytes) fail(400, 'TAR 文件数量或解压体积超出限制');
      if (seen.has(name.toLowerCase())) fail(400, 'TAR 包含重复路径'); seen.add(name.toLowerCase());
      if (entry.type === 'File') { if (!accept(name)) fail(400, `压缩包包含未授权文件：${name}`); files.push(name); }
    } catch (e) { error ||= e; }
  } });
  if (error) throw error;
  if (total / Math.max((await fsp.stat(file)).size, 1) > 1000) fail(400, 'TAR 压缩率超出限制');
  await ensureDiskSpace([{ dir: destination, bytes: total }]);
  await fsp.mkdir(destination, { recursive: true });
  await tar.x({ file, cwd: destination, strict: true, preservePaths: false, preserveOwner: false, noMtime: true, filter(name, entry) { entry.mode = entry.type === 'Directory' ? 0o700 : 0o600; return !!normalize(name); } });
  for (const name of files) await safePath(destination, name, { allowMissing: false });
  return files;
}
