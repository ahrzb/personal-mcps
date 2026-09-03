// The PWA icons, rendered from BrandMark's geometry (server/src/pages/layout.tsx) with no
// browser and no dependency: a signed-distance rasterizer over the four strokes, 8x8
// supersampled, written as an RGB PNG through node:zlib. Deterministic — the same bytes on
// every run — so `node scripts/icon.mjs` regenerates what server/src/pages/icon.ts embeds.
//
//   node scripts/icon.mjs            prints the two base64 constants
//   node scripts/icon.mjs <dir>      also writes <dir>/icon-192.png and <dir>/icon-512.png
//
// Ground #ffffff full-bleed, stroke #09090b (--fg), the 24-unit viewBox inset to the middle
// 80 % of the square (the mark's farthest point stays inside the 0.4N maskable safe zone).
import fs from "node:fs";
import zlib from "node:zlib";

const STROKE = [0x09, 0x09, 0x0b];
const GROUND = [0xff, 0xff, 0xff];
const WIDTH = 2; // stroke-width, viewBox units
const CIRCLE = { cx: 12, cy: 12, r: 3.5 };
const LINES = [
  [12, 8.5, 12, 3.5],
  [14.5, 14.5, 18.5, 18.5],
  [9.5, 14.5, 5.5, 18.5],
];
const SS = 8; // supersamples per axis

/** Signed distance from (x, y) in viewBox units to the nearest stroke edge (< 0 = inside). */
function distance(x, y) {
  const half = WIDTH / 2;
  let d = Math.abs(Math.hypot(x - CIRCLE.cx, y - CIRCLE.cy) - CIRCLE.r) - half;
  for (const [ax, ay, bx, by] of LINES) {
    const vx = bx - ax, vy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)));
    d = Math.min(d, Math.hypot(x - (ax + t * vx), y - (ay + t * vy)) - half); // round caps
  }
  return d;
}

function raster(n) {
  const scale = (0.8 * n) / 24, offset = 0.1 * n;
  const rgb = Buffer.alloc(n * n * 3);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let inside = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS - offset) / scale;
          const y = (py + (sy + 0.5) / SS - offset) / scale;
          if (distance(x, y) <= 0) inside++;
        }
      }
      const a = inside / (SS * SS);
      for (let c = 0; c < 3; c++) rgb[(py * n + px) * 3 + c] = Math.round(GROUND[c] * (1 - a) + STROKE[c] * a);
    }
  }
  return rgb;
}

const CRC_TABLE = new Int32Array(256).map((_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
function png(n, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0);
  ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  const rows = Buffer.alloc(n * (1 + n * 3));
  for (let y = 0; y < n; y++) rgb.copy(rows, y * (1 + n * 3) + 1, y * n * 3, (y + 1) * n * 3); // filter 0 per row
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const outDir = process.argv[2];
for (const n of [192, 512]) {
  const bytes = png(n, raster(n));
  if (outDir) fs.writeFileSync(`${outDir}/icon-${n}.png`, bytes);
  console.log(`// icon-${n}.png — ${bytes.length} bytes\n${bytes.toString("base64")}\n`);
}
