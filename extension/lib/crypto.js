const KEY_HEX = "64386367386756616b45713941677570";
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
const RCON = [1, 2, 4, 8, 16, 32, 64, 128, 27, 54];
(function buildSbox() {
  const rotl = (x, n) => (x << n | x >>> 8 - n) & 255;
  const inv = (a) => {
    let r = 1;
    for (let i = 0; i < 8; i++) {
      r = mul(r, r);
      if (i < 7) r = mul(r, a);
    }
    return r;
  };
  function mul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
      if (b & 1) p ^= a;
      const hi = a & 128;
      a = a << 1 & 255;
      if (hi) a ^= 27;
      b >>= 1;
    }
    return p;
  }
  for (let i = 0; i < 256; i++) {
    const x = i === 0 ? 0 : inv(i);
    const s = x ^ rotl(x, 1) ^ rotl(x, 2) ^ rotl(x, 3) ^ rotl(x, 4) ^ 99;
    SBOX[i] = s;
    INV_SBOX[s] = i;
  }
})();
function mul2(a) {
  const hi = a & 128;
  const r = a << 1 & 255;
  return hi ? r ^ 27 : r;
}
function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key, 0);
  for (let i = 16, r = 0; i < 176; i += 4) {
    let t = [w[i - 4], w[i - 3], w[i - 2], w[i - 1]];
    if (i % 16 === 0) {
      t = [SBOX[t[1]] ^ RCON[r++], SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]];
    }
    for (let j = 0; j < 4; j++) w[i + j] = w[i - 16 + j] ^ t[j];
  }
  return w;
}
function addRoundKey(s, w, round) {
  for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
}
function encryptBlock(block, w) {
  const s = Uint8Array.from(block);
  addRoundKey(s, w, 0);
  for (let round = 1; round <= 10; round++) {
    const t = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) t[c * 4 + r] = SBOX[s[(c + r) % 4 * 4 + r]];
    }
    s.set(t);
    if (round !== 10) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = mul2(a0) ^ (mul2(a1) ^ a1) ^ a2 ^ a3;
        s[c * 4 + 1] = a0 ^ mul2(a1) ^ (mul2(a2) ^ a2) ^ a3;
        s[c * 4 + 2] = a0 ^ a1 ^ mul2(a2) ^ (mul2(a3) ^ a3);
        s[c * 4 + 3] = mul2(a0) ^ a0 ^ a1 ^ a2 ^ mul2(a3);
      }
    }
    addRoundKey(s, w, round);
  }
  return s;
}
function gfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 128;
    a = a << 1 & 255;
    if (hi) a ^= 27;
    b >>= 1;
  }
  return p;
}
function decryptBlock(block, w) {
  const s = Uint8Array.from(block);
  addRoundKey(s, w, 10);
  for (let round = 9; round >= 0; round--) {
    const t = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) t[(c + r) % 4 * 4 + r] = INV_SBOX[s[c * 4 + r]];
    }
    s.set(t);
    addRoundKey(s, w, round);
    if (round !== 0) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3];
        s[c * 4] = gfMul(a0, 14) ^ gfMul(a1, 11) ^ gfMul(a2, 13) ^ gfMul(a3, 9);
        s[c * 4 + 1] = gfMul(a0, 9) ^ gfMul(a1, 14) ^ gfMul(a2, 11) ^ gfMul(a3, 13);
        s[c * 4 + 2] = gfMul(a0, 13) ^ gfMul(a1, 9) ^ gfMul(a2, 14) ^ gfMul(a3, 11);
        s[c * 4 + 3] = gfMul(a0, 11) ^ gfMul(a1, 13) ^ gfMul(a2, 9) ^ gfMul(a3, 14);
      }
    }
  }
  return s;
}
function keyBytes() {
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(KEY_HEX.substr(i * 2, 2), 16);
  return out;
}
const AES_KEY = keyBytes();
const ROUND_KEYS = expandKey(AES_KEY);
function toBinaryString(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}
function fromBinaryString(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 255;
  return out;
}
const utf8Encode = (s) => new TextEncoder().encode(s);
const utf8Decode = (b) => new TextDecoder().decode(b);
function encField(value) {
  if (value === null || value === void 0) return null;
  const text = typeof value === "boolean" ? value ? "true" : "false" : String(value);
  if (text === "") return "";
  const data = utf8Encode(text);
  const pad = 16 - data.length % 16;
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) {
    out.set(encryptBlock(padded.subarray(i, i + 16), ROUND_KEYS), i);
  }
  return btoa(toBinaryString(out));
}
function decField(b64) {
  const bytes = fromBinaryString(atob(b64));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i += 16) {
    out.set(decryptBlock(bytes.subarray(i, i + 16), ROUND_KEYS), i);
  }
  const pad = out[out.length - 1];
  return utf8Decode(out.subarray(0, out.length - pad));
}
// 只有 401 与这四个平台登录态错误码才代表“凭据被拒”。422 是参数非法、403/429 是风控/限流,
// 与密码无关: 误判会导致删除用户已保存的密码并累计登录失败锁定（审计 P0-3）
var AUTH_REJECT_CODES = ["90901", "90902", "90908", "90105"];
function isAuthRejection(err) {
  if (!err) return false;
  if (Number(err.status || 0) === 401) return true;
  return AUTH_REJECT_CODES.includes(String(err.errorCode || ""));
}
export {
  AES_KEY,
  decField,
  encField,
  isAuthRejection
};
