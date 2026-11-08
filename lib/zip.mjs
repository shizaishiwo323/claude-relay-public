// Minimal ZIP writer for "download all": files are stored, not compressed (images, PDFs and Office files are already
// compressed, and storing keeps it fast). UTF-8 names (Chinese file names show correctly). No dependencies.
import fs from 'node:fs';
import zlib from 'node:zlib';

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

// entries: [{ name, path }]. Writes the archive to the stream `out` (e.g. an HTTP response) one file at a time.
export async function writeZip(out, entries) {
  const write = (buf) => new Promise((ok) => (out.write(buf) ? ok() : out.once('drain', ok)));
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const data = fs.readFileSync(e.path);
    const name = Buffer.from(e.name, 'utf8');
    const mt = fs.statSync(e.path).mtime, crc = zlib.crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(0, 8);
    head.writeUInt16LE(dosTime(mt), 10); head.writeUInt16LE(dosDate(mt), 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    await write(head); await write(name); await write(data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
    c.writeUInt16LE(dosTime(mt), 12); c.writeUInt16LE(dosDate(mt), 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, name]));
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  await write(cd); await write(end);
  out.end();
}
