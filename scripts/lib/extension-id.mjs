/**
 * 扩展 ID 工具（脚本共用）:
 * 开发版 manifest 带固定 `key`, 由它按 Chrome 内部算法反推扩展 ID —— 避免脚本里硬编码 ID。
 * Chrome 规则: 公钥 DER 的 SHA-256 前 16 字节, 每个半字节 0-f 映射成 a-p。
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export function idFromKey(keyB64) {
  const der = Buffer.from(String(keyB64), 'base64');
  const hash = createHash('sha256').update(der).digest().subarray(0, 16);
  return [...hash]
    .map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15)))
    .join('');
}

/** 读 manifest 的 key → 扩展 ID（WXT 产物优先, 原生版回落到 extension/manifest.json） */
export function readExpectedId(root = process.cwd()) {
  const candidates = [
    '.output/chrome-mv3-dev/manifest.json',
    '.output/chrome-mv3/manifest.json',
    'extension/manifest.json', // 原生分支: extension/ 即加载目标, 无构建产物
  ].map((p) => resolve(root, p)).filter(existsSync);
  for (const p of candidates) {
    try {
      const key = JSON.parse(readFileSync(p, 'utf8')).key;
      if (key) return idFromKey(key);
    } catch { /* 读坏了就换下一个 */ }
  }
  return '';
}
