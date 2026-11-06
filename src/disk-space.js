import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { AppError, diskFree } from './core.js';

export const DISK_RESERVE = 256 * 1024 ** 2;
const sizeText = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GiB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`;
async function volume(dir) {
  let current = path.resolve(dir);
  while (true) {
    try { const stat = await fs.stat(current); return { dir: current, device: String(stat.dev) }; }
    catch (error) { if (error.code !== 'ENOENT' || path.dirname(current) === current) throw error; current = path.dirname(current); }
  }
}
// Count additional writes on each actual filesystem. Files already on disk are
// reflected in free space; shared staging/installation volumes must be summed.
export async function ensureDiskSpace(writes, { reserve = DISK_RESERVE } = {}) {
  const volumes = new Map();
  for (const { dir, bytes } of writes) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid disk space estimate');
    const target = await volume(dir), current = volumes.get(target.device);
    if (current) current.bytes += bytes;
    else volumes.set(target.device, { ...target, bytes });
  }
  const result = [];
  for (const target of volumes.values()) {
    const free = await diskFree(target.dir), required = target.bytes + reserve;
    if (free < required) throw new AppError(400, `磁盘空间不足：${target.dir} 可用 ${sizeText(free)}，本步需新增 ${sizeText(target.bytes)}，另保留 ${sizeText(reserve)} 安全余量（合计需 ${sizeText(required)}）`, 'DISK_SPACE');
    result.push({ ...target, free, required });
  }
  return result;
}
export const ensureFileSpace = (file, bytes = 0) => ensureDiskSpace([{ dir: path.dirname(file), bytes }]);

// Unknown Content-Length and concurrent activity still need checks during writes.
export function diskSpaceGuard(file) {
  let sinceCheck = 16 * 1024 ** 2;
  return new Transform({ transform(chunk, _encoding, callback) {
    sinceCheck += chunk.length;
    if (sinceCheck < 16 * 1024 ** 2) return callback(null, chunk);
    sinceCheck = 0;
    ensureFileSpace(file, chunk.length).then(() => callback(null, chunk), callback);
  } });
}

export class UploadReservations {
  constructor() { this.bytes = 0; }
  reserve(free, contentLength, uploadLimit) {
    const known = typeof contentLength === 'string' && /^\d+$/.test(contentLength);
    const requested = known ? Number(contentLength) : null;
    if (known && (!Number.isSafeInteger(requested) || requested > uploadLimit + 64 * 1024)) throw new AppError(413, '上传文件超过大小限制');
    const available = Math.max(0, free - DISK_RESERVE - this.bytes);
    if (available <= 0 || (known && requested > available)) throw new AppError(400, `上传暂存空间不足：当前可用于上传 ${sizeText(available)}${known ? `，本次请求需要 ${sizeText(requested)}` : ''}；保留 ${sizeText(DISK_RESERVE)} 安全余量`, 'DISK_SPACE');
    const reserved = known ? requested : Math.min(uploadLimit, available);
    this.bytes += reserved; let released = false;
    return { fileLimit: Math.min(uploadLimit, reserved), release: () => { if (!released) { released = true; this.bytes -= reserved; } } };
  }
}
