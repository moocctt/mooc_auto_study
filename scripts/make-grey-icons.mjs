#!/usr/bin/env node
/**
 * 生成工具栏图标的静态灰度版（extension/icon/grey-*.png）
 * ===================================================
 * background 优先在运行时用 OffscreenCanvas 灰度化（换图标不会出现「彩色换了、灰色还是旧图」）,
 * 但某些环境（无 OffscreenCanvas/createImageBitmap、取图失败）拿不到 ImageData ——
 * 那时必须退回这组静态灰度图, 否则会出现「标题说登录失效、图标还是彩色」这种最误导的组合。
 *
 * 纯 Node 实现（zlib 解码 PNG → 灰度+淡化 → 重新编码）, 不依赖浏览器/图像库。
 * 用法: npm run icons:grey     （改完 extension/icon/*.png 后重跑）
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 128];
/** 与 background.ts 的运行时算法保持一致: 灰度权重 + 55% 不透明度 */
const ALPHA = 0.55;

function readChunks(buf) {
  const out = [];
  let off = 8;                       // 跳过 PNG 签名
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    out.push({ type, data });
    off += 12 + len;                 // len + type(4) + data + crc(4)
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 解 PNG（支持 8bit 的 RGB/RGBA/灰度; 图标都是这类）→ { w, h, rgba } */
function decodePng(buf) {
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === 'IHDR').data;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const colorType = ihdr[9];
  if (depth !== 8) throw new Error(`只支持 8bit PNG（当前 ${depth}bit）`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels) throw new Error(`不支持的 PNG colorType=${colorType}`);

  const raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const stride = w * channels;
  const px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const v = line[x];
      px[y * stride + x] = filter === 0 ? v
        : filter === 1 ? (v + a) & 0xff
        : filter === 2 ? (v + b) & 0xff
        : filter === 3 ? (v + ((a + b) >> 1)) & 0xff
        : filter === 4 ? (v + paeth(a, b, c)) & 0xff
        : v;
    }
  }

  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * channels;
    const d = i * 4;
    if (channels === 1) { rgba[d] = rgba[d + 1] = rgba[d + 2] = px[s]; rgba[d + 3] = 255; }
    else if (channels === 3) { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = 255; }
    else { rgba[d] = px[s]; rgba[d + 1] = px[s + 1]; rgba[d + 2] = px[s + 2]; rgba[d + 3] = px[s + 3]; }
  }
  return { w, h, rgba };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;                                  // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of SIZES) {
  const src = join(ROOT, 'extension', 'icon', `${size}.png`);
  const { w, h, rgba } = decodePng(readFileSync(src));
  for (let i = 0; i < w * h; i++) {
    const d = i * 4;
    const g = Math.round(0.299 * rgba[d] + 0.587 * rgba[d + 1] + 0.114 * rgba[d + 2]);
    rgba[d] = g; rgba[d + 1] = g; rgba[d + 2] = g;
    rgba[d + 3] = Math.round(rgba[d + 3] * ALPHA);
  }
  const out = join(ROOT, 'extension', 'icon', `grey-${size}.png`);
  writeFileSync(out, encodePng(w, h, rgba));
  console.log(`✓ grey-${size}.png (${w}×${h})`);
}
