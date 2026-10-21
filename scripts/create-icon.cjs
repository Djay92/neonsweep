// Original NeonSweep vector mark. Generate the bundled Windows icon without image dependencies.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assets = path.join(__dirname, '..', 'src', 'assets');
const size = 256;
const segments = [[76, 184, 76, 72], [76, 72, 180, 184], [180, 184, 180, 72]];
function distance(x, y, [ax, ay, bx, by]) {
  const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const sum = [0, 0, 0];
  for (const dy of [.25, .75]) for (const dx of [.25, .75]) {
    const px = x + dx, py = y + dy;
    let color = [9, 15, 20];
    if (segments.some((s) => distance(px, py, s) <= 10)) color = [104, 231, 219];
    if (px > 202 && px < 224 && py > 202 && py < 210) color = [220, 239, 111];
    color.forEach((c, i) => { sum[i] += c; });
  }
  const offset = y * (size * 4 + 1) + 1 + x * 4;
  sum.forEach((v, i) => { raw[offset + i] = Math.round(v / 4); });
  raw[offset + 3] = 255;
}
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE(crc32(body), out.length - 4);
  return out;
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.mkdirSync(assets, { recursive: true });
fs.writeFileSync(path.join(assets, 'icon.png'), png);
fs.writeFileSync(path.join(assets, 'icon.ico'), Buffer.concat([ico, png]));
