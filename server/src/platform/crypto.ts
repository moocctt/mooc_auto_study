// 平台侧加密/指纹：与油猴脚本、utools 插件同源（AES-128-ECB/PKCS7 + base64）。
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const KEY = Buffer.from('64386367386756616b45713941677570', 'hex');

/** app-login 接口的字段加密：AES-128-ECB + PKCS7 → base64 */
export function encField(v: string): string {
  const c = createCipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([c.update(v, 'utf8'), c.final()]).toString('base64');
}

export function decryptField(v: string): string {
  const d = createDecipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([d.update(Buffer.from(v, 'base64')), d.final()]).toString('utf8');
}

/** 本地平台密码二次加密（AES-256-GCM），密钥来自 PLATFORM_ENC_KEY；格式 iv.authTag.ciphertext (base64) */
export function sealSecret(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function openSecret(sealed: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const [ivB, tagB, dataB] = sealed.split('.');
  if (!ivB || !tagB || !dataB) throw new Error('密文格式错误');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB, 'base64')), decipher.final()]).toString('utf8');
}

/** 与站点一致的登录页 hashKey：OAuth 参数串的 base64 */
export const HASH_KEY = Buffer.from(
  'response_type=token&client_id=999&redirect_uri=https%3A%2F%2Fmooc.ctt.cn&state=%2Fhome&lang=cn&cancelRememberState=0',
  'utf8',
).toString('base64');

export const ORG_ID_ENC = encField('1');

/** FNV-1a → 10 款安卓机型，terminal/system 与官网登录一致 */
const DEVICES = ['Xiaomi 13', 'HUAWEI Mate 50', 'OPPO Find X6', 'vivo X90', 'HONOR Magic5', 'realme GT Neo5', 'OnePlus 11', 'Pixel 7', 'Samsung S23', 'moto X40'];
const SYSTEMS = ['Linux armv8l', 'Linux aarch64'];

export function fingerprintFor(seed: string): { terminal: string; system: string } {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return { terminal: DEVICES[(h >>> 0) % DEVICES.length]!, system: SYSTEMS[(h >>> 8) % SYSTEMS.length]! };
}

export function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}
