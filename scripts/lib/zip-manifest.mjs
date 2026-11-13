// 只读 zip 中央目录 —— 不依赖 unzip 命令 (Windows/CI 一致)。
// - listZipEntries(zipPath): 所有条目名（目录/文件）
// - readManifest(zipPath):   取出 manifest.json 并 JSON.parse
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

/** 遍历中央目录, 对每个条目调 cb(name, entryInfo); 返回 false 可提前终止 */
function walkCentralDirectory(zipPath, cb) {
  const buf = readFileSync(zipPath);
  let off = buf.length - 22;
  while (off >= 0 && buf.readUInt32LE(off) !== 0x06054b50) off--;
  if (off < 0) throw new Error("不是合法 zip (缺 EOCD): " + zipPath);
  const count = buf.readUInt16LE(off + 10);
  let p = buf.readUInt32LE(off + 16);
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const entry = {
      method: buf.readUInt16LE(p + 10),
      csize: buf.readUInt32LE(p + 20),
      nameLen: buf.readUInt16LE(p + 28),
      extraLen: buf.readUInt16LE(p + 30),
      commentLen: buf.readUInt16LE(p + 32),
      localOff: buf.readUInt32LE(p + 42),
      name: buf.subarray(p + 46, p + 46 + buf.readUInt16LE(p + 28)).toString("utf8"),
    };
    if (cb(entry.name, entry, buf) === false) return;
    p += 46 + entry.nameLen + entry.extraLen + entry.commentLen;
  }
}

export function listZipEntries(zipPath) {
  const names = [];
  walkCentralDirectory(zipPath, (name) => void names.push(name));
  return names;
}

export function readManifest(zipPath) {
  let manifest;
  walkCentralDirectory(zipPath, (name, entry, buf) => {
    if (name !== "manifest.json") return;
    const lnameLen = buf.readUInt16LE(entry.localOff + 26);
    const lextraLen = buf.readUInt16LE(entry.localOff + 28);
    const start = entry.localOff + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(start, start + entry.csize);
    const text = entry.method === 0 ? raw.toString("utf8") : inflateRawSync(raw).toString("utf8");
    manifest = JSON.parse(text);
    return false; // 找到即停
  });
  if (!manifest) throw new Error("zip 内没有 manifest.json: " + zipPath);
  return manifest;
}
