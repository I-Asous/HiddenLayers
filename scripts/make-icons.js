// Renders the app icons from the dragon whelp sprite, without any image
// dependencies. Run with: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { buddyPixels } from '../public/js/buddy.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');
const BACKGROUND = '#29366f';
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// Crop the 32×32 canvas down to the sprite itself.
const canvas = buddyPixels({ species: 'dragon', stage: 'baby' });
const filled = canvas.flatMap((row, y) => row.map((color, x) => (color ? [x, y] : null)).filter(Boolean));
const x1 = Math.min(...filled.map(([x]) => x));
const y1 = Math.min(...filled.map(([, y]) => y));
const spriteW = Math.max(...filled.map(([x]) => x)) - x1 + 1;
const spriteH = Math.max(...filled.map(([, y]) => y)) - y1 + 1;
const sprite = canvas.slice(y1, y1 + spriteH).map((row) => row.slice(x1, x1 + spriteW));

/** `fill` is how much of the icon the sprite may cover (maskable icons need a safe zone). */
function render(size, fill) {
  const scale = Math.floor((size * fill) / Math.max(spriteW, spriteH)); // whole pixels only
  const left = Math.round((size - spriteW * scale) / 2);
  const top = Math.round((size - spriteH * scale) / 2);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const color = sprite[Math.floor((y - top) / scale)]?.[Math.floor((x - left) / scale)] ?? BACKGROUND;
      rgba.set([...hex(color), 255], (y * size + x) * 4);
    }
  }
  return png(size, rgba);
}

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(zlib.crc32(body), body.length + 4);
  return out;
}

function png(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function svg() {
  const pad = 3;
  const side = Math.max(spriteW, spriteH) + pad * 2;
  const dx = (side - spriteW) / 2;
  const dy = (side - spriteH) / 2;
  const pixels = sprite.flatMap((row, y) => row.map((color, x) =>
    (color ? `<rect x="${x + dx}" y="${y + dy}" width="1" height="1" fill="${color}"/>` : ''))).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges">` +
    `<rect width="${side}" height="${side}" fill="${BACKGROUND}"/>${pixels}</svg>\n`;
}

mkdirSync(OUT, { recursive: true });
const icons = {
  'icon-192.png': render(192, 0.8),
  'icon-512.png': render(512, 0.8),
  'icon-maskable-512.png': render(512, 0.56),
  'apple-touch-icon.png': render(180, 0.8),
  'icon.svg': svg(),
};
for (const [name, data] of Object.entries(icons)) {
  writeFileSync(path.join(OUT, name), data);
  console.log(`${name}  ${data.length} bytes`);
}
