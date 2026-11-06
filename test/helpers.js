import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import yazl from 'yazl';
import fss from 'node:fs';
import { pipeline } from 'node:stream/promises';

export async function tempDir() { return fs.mkdtemp(path.join(os.tmpdir(), 'safehouse-test-')); }
export async function fixtureServer(root) {
  await fs.mkdir(path.join(root, 'left4dead2/cfg'), { recursive: true });
  await fs.mkdir(path.join(root, 'left4dead2/addons/sourcemod/plugins/disabled'), { recursive: true });
  await fs.writeFile(path.join(root, process.platform === 'win32' ? 'srcds.exe' : 'srcds_run'), 'TEST FIXTURE ONLY');
  await fs.writeFile(path.join(root, 'left4dead2/gameinfo.txt'), '"GameInfo" { "game" "Left 4 Dead 2" }');
  await fs.writeFile(path.join(root, 'left4dead2/cfg/server.cfg'), 'hostname "Fixture"\n');
  return root;
}
export function fixtureVpk(map = 'fixture_map', payload = Buffer.from('VBSP')) {
  const entry = Buffer.alloc(18); entry.writeUInt16LE(0x7fff, 6); entry.writeUInt32LE(payload.length, 12); entry.writeUInt16LE(0xffff, 16);
  const tree = Buffer.concat([Buffer.from(`bsp\0maps\0${map}\0`), entry, Buffer.from([0, 0, 0])]);
  const header = Buffer.alloc(12); header.writeUInt32LE(0x55aa1234); header.writeUInt32LE(1, 4); header.writeUInt32LE(tree.length, 8);
  return Buffer.concat([header, tree, payload]);
}
export function fixtureSmx() { const header = Buffer.alloc(24); header.write('FFPS'); header.writeUInt16LE(0x0107,4); header.writeUInt32LE(24,7); header.writeUInt32LE(24,11); return header; }
export async function zipBuffer(file, entries) {
  const zip = new yazl.ZipFile(); const finished = pipeline(zip.outputStream, fss.createWriteStream(file));
  for (const [name, bytes, options] of entries) zip.addBuffer(Buffer.from(bytes), name, options);
  zip.end(); await finished;
}
