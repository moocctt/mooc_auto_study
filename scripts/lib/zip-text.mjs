// 从 zip 里按名字读一个文本条目（配合 zip-manifest 的中央目录遍历, 不依赖 unzip）。
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

export function readZipText(zipPath, entryName) {
  const buf = readFileSync(zipPath);
  let off = buf.length - 22;
  while (off >= 0 && buf.readUInt32LE(off) !== 0x06054b50) off--;
  if (off < 0) throw new Error("不是合法 zip (缺 EOCD): " + zipPath);
  const count = buf.readUInt16LE(off + 10);
  let p = buf.readUInt32LE(off + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    if (name === entryName) {
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lnameLen + lextraLen;
      const raw = buf.subarray(start, start + csize);
      return method === 0 ? raw.toString("utf8") : inflateRawSync(raw).toString("utf8");
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`zip 内没有 ${entryName}: ${zipPath}`);
}
