import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Content } from '../src/content.js';
import { Store } from '../src/store.js';
import { Servers } from '../src/servers.js';
import { extractZip } from '../src/archive.js';
import { downloadDirect } from '../src/direct-download.js';
import { downloadSteam } from '../src/network.js';
import { notifications } from '../src/operations.js';
import { DISK_RESERVE, ensureDiskSpace, UploadReservations } from '../src/disk-space.js';
import { tempDir, fixtureServer, fixtureVpk, zipBuffer } from './helpers.js';

const GiB = 1024 ** 3;
const fakeFree = (t, bytes) => t.mock.method(fs, 'statfs', async () => ({ bavail: bytes, bsize: 1 }));
async function fixture() {
  const root = await tempDir(), store = new Store(path.join(root, 'data'));
  const game = await fixtureServer(path.join(root, 'game')), config = { allowedRoots: [root], uploadLimit: 2 * GiB };
  store.put('server', { id: 's', root: game });
  const servers = new Servers(config, store, null), content = new Content(config, store, servers, {});
  return { root, store, game, content, ctx: { signal: new AbortController().signal, update() {} }, async close() { store.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('地图空间回归：仅 1 GiB 可用仍可安装小 VPK，保留默认 2 GiB 文件上限', async t => {
  const f = await fixture(); fakeFree(t, GiB);
  try {
    const upload = path.join(f.root, 'map.vpk'); await fs.writeFile(upload, fixtureVpk('space_vpk'));
    const result = await f.content.installMap('s', { upload, filename: 'map.vpk' }, f.ctx);
    assert.deepEqual(result.maps, ['space_vpk']); assert.equal(f.store.list('transaction')[0].state, 'committed');
    assert(await fs.stat(path.join(f.game, f.store.list('map')[0].files[0])));
  } finally { await f.close(); }
});
test('ZIP 空间回归：按真实解压大小安装小地图，不预留整个上传额度', async t => {
  const f = await fixture(); fakeFree(t, GiB);
  try {
    const upload = path.join(f.root, 'map.zip'); await zipBuffer(upload, [['part/map.vpk', fixtureVpk('space_zip')]]);
    const result = await f.content.installMap('s', { upload, filename: 'map.zip' }, f.ctx);
    assert.deepEqual(result.maps, ['space_zip']); assert.deepEqual(await fs.readdir(path.join(f.store.dir, 'staging')), []);
  } finally { await f.close(); }
});
test('工坊空间回归：1 GiB 可用时下载后的地图仍可事务安装', async t => {
  const f = await fixture(); fakeFree(t, GiB);
  try {
    f.content.downloadWorkshop = async (pid, stage) => { const file = path.join(stage, 'workshop.vpk'); await fs.writeFile(file, fixtureVpk('space_workshop')); return { item: { id: pid, title: 'Workshop fixture' }, files: [file] }; };
    const result = await f.content.installMap('s', { workshopId: '123456789' }, f.ctx);
    assert.deepEqual(result.maps, ['space_workshop']);
  } finally { await f.close(); }
});
test('空间计算：同一磁盘的多个写入相加，刚好满足余量可通过，少 1 字节则拒绝', async t => {
  const root = await tempDir(); const mock = fakeFree(t, DISK_RESERVE + 100);
  try {
    await fs.mkdir(path.join(root, 'other'));
    const writes = [{ dir: root, bytes: 60 }, { dir: path.join(root, 'other/missing'), bytes: 40 }];
    const result = await ensureDiskSpace(writes); assert.equal(result.length, 1); assert.equal(result[0].bytes, 100);
    mock.mock.mockImplementation(async () => ({ bavail: DISK_RESERVE + 99, bsize: 1 }));
    await assert.rejects(() => ensureDiskSpace(writes), error => error.code === 'DISK_SPACE' && /可用.*合计需/.test(error.message));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('空间计算：暂存与游戏位于不同磁盘时分别检查，数据盘不足也会拒绝', async t => {
  const root = await tempDir(); await fs.mkdir(path.join(root, 'data')); await fs.mkdir(path.join(root, 'game'));
  const originalStat = fs.stat;
  t.mock.method(fs, 'stat', async (dir, ...args) => { const stat = await originalStat(dir, ...args); if (path.resolve(dir) === path.join(root, 'data')) stat.dev = 123; else if (path.resolve(dir) === path.join(root, 'game')) stat.dev = 456; return stat; });
  t.mock.method(fs, 'statfs', async dir => ({ bavail: path.resolve(dir) === path.join(root, 'data') ? DISK_RESERVE + 20 : 4 * GiB, bsize: 1 }));
  try {
    assert.equal((await ensureDiskSpace([{ dir: path.join(root, 'data'), bytes: 20 }, { dir: path.join(root, 'game'), bytes: 100 }])).length, 2);
    await assert.rejects(() => ensureDiskSpace([{ dir: path.join(root, 'data'), bytes: 21 }, { dir: path.join(root, 'game'), bytes: 100 }]), /空间不足/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('事务空间不足：包含旧文件回滚副本，拒绝前不改游戏文件、不留下备份', async t => {
  const f = await fixture();
  try {
    const relative = 'left4dead2/cfg/server.cfg', target = path.join(f.game, relative), previous = await fs.readFile(target);
    const source = path.join(f.root, 'replacement.cfg'); await fs.writeFile(source, 'replacement');
    const size = (await fs.stat(source)).size; fakeFree(t, DISK_RESERVE + size + previous.length - 1);
    await assert.rejects(() => f.content.transaction(f.content.servers.get('s'), [{ source, relative }]), /空间不足/);
    assert.deepEqual(await fs.readFile(target), previous); assert.deepEqual(f.store.list('transaction'), []);
    assert.deepEqual(await fs.readdir(path.join(f.store.dir, 'backups')), []);
  } finally { await f.close(); }
});
test('ZIP 真实不足：解压前拒绝并保留安全余量', async t => {
  const root = await tempDir();
  try {
    const archive = path.join(root, 'input.zip'); await zipBuffer(archive, [['map.vpk', fixtureVpk()]]);
    fakeFree(t, DISK_RESERVE + 1);
    await assert.rejects(() => extractZip(archive, path.join(root, 'out')), /空间不足/);
    await assert.rejects(() => fs.stat(path.join(root, 'out/map.vpk')));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('直链真实不足：未知长度在写入中检查空间，失败清理临时文件', async t => {
  const root = await tempDir(), destination = path.join(root, 'download'); let calls = 0;
  t.mock.method(fs, 'statfs', async () => ({ bavail: ++calls === 1 ? GiB : DISK_RESERVE, bsize: 1 }));
  try {
    await assert.rejects(() => downloadDirect('https://example.com/map.vpk', destination, { request: async () => { const response = Readable.from([fixtureVpk()]); response.headers = {}; return response; } }), /空间不足/);
    await assert.rejects(() => fs.stat(destination));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('上传空间：按请求实际大小接收小文件，并发额度与未知长度受限，释放幂等', () => {
  const reservations = new UploadReservations(), first = reservations.reserve(DISK_RESERVE + 100, '60', 2 * GiB);
  assert.equal(first.fileLimit, 60); assert.throws(() => reservations.reserve(DISK_RESERVE + 100, '50', 2 * GiB), /空间不足/);
  first.release(); first.release(); assert.equal(reservations.bytes, 0);
  const unknown = reservations.reserve(DISK_RESERVE + 100, undefined, 2 * GiB); assert.equal(unknown.fileLimit, 100);
  assert.throws(() => reservations.reserve(DISK_RESERVE + 100, '1', 2 * GiB), /空间不足/); unknown.release();
  assert.throws(() => reservations.reserve(10 * GiB, String(2 * GiB + 64 * 1024 + 1), 2 * GiB), /大小限制/);
});

test('Steam 下载：按实际长度预检，可用 1 GiB 能下载小地图，真正不足时关闭响应', async t => {
  const root = await tempDir(), file = path.join(root, 'map.vpk'), body = fixtureVpk('steam_disk');
  const free = fakeFree(t, GiB); let response;
  t.mock.method(https, 'request', (_url, _options, callback) => {
    const request = new EventEmitter(); request.setTimeout = () => request;
    request.destroy = error => { request.emit('error', error); request.emit('close'); };
    request.end = () => queueMicrotask(() => { response = Readable.from([body]); response.statusCode = 200; response.headers = { 'content-length': String(body.length) }; callback(response); request.emit('close'); });
    return request;
  });
  try {
    await downloadSteam('https://cdn.steamusercontent.com/map.vpk', file);
    assert.deepEqual(await fs.readFile(file), body); await fs.rm(file);
    free.mock.mockImplementation(async () => ({ bavail: DISK_RESERVE + body.length - 1, bsize: 1 }));
    await assert.rejects(() => downloadSteam('https://cdn.steamusercontent.com/map.vpk', file), /空间不足/);
    assert(response.destroyed); await assert.rejects(() => fs.stat(file));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('空间提示：低于 5 GiB 仅提醒，低于安全余量才报告空间不足', async t => {
  const f = await fixture(), free = fakeFree(t, GiB);
  try {
    const owner = { role: 'owner' }, config = { dataDir: f.store.dir };
    let note = (await notifications(f.store, config, owner)).find(n => n.id === 'disk');
    assert.equal(note.type, 'warning'); assert.match(note.title, /余量较低/); assert.match(note.message, /实际大小/);
    free.mock.mockImplementation(async () => ({ bavail: DISK_RESERVE - 1, bsize: 1 }));
    note = (await notifications(f.store, config, owner)).find(n => n.id === 'disk');
    assert.equal(note.type, 'error'); assert.match(note.message, /256 MiB/);
  } finally { await f.close(); }
});
