const PREFIX = "mooc.vault.";
const CRED = "creds";
const TOKENS = "tokens";
const SYNC_FLAG = "syncEnabled";
const browserApi = () => globalThis.browser || globalThis.chrome || null;
const hasExtStorage = () => {
  const b = browserApi();
  return !!(b && b.storage && b.storage.local && typeof b.storage.local.get === "function");
};
async function extGet(key) {
  const b = browserApi();
  const got = await b.storage.local.get(PREFIX + key);
  return got?.[PREFIX + key];
}
async function extSet(key, value) {
  await browserApi().storage.local.set({ [PREFIX + key]: value });
}
async function extRemove(key) {
  await browserApi().storage.local.remove(PREFIX + key);
}
function lsGet(key) {
  try {
    return JSON.parse(globalThis.localStorage.getItem(PREFIX + key) || "null");
  } catch {
    return null;
  }
}
function lsSet(key, value) {
  try {
    globalThis.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
  }
}
function lsRemove(key) {
  try {
    globalThis.localStorage.removeItem(PREFIX + key);
  } catch {
  }
}
async function get(key) {
  return hasExtStorage() ? extGet(key) : lsGet(key);
}
async function set(key, value) {
  return hasExtStorage() ? extSet(key, value) : lsSet(key, value);
}
async function remove(key) {
  return hasExtStorage() ? extRemove(key) : lsRemove(key);
}
const syncArea = () => {
  const b = browserApi();
  return b && b.storage && b.storage.sync && typeof b.storage.sync.get === "function" ? b.storage.sync : null;
};
const syncSupported = () => !!syncArea();
async function syncEnabled() {
  const s = syncArea();
  if (!s) return false;
  try {
    const got = await s.get(PREFIX + SYNC_FLAG);
    return !!(got && got[PREFIX + SYNC_FLAG]);
  } catch {
    return false;
  }
}
async function setSyncEnabled(on) {
  const s = syncArea();
  if (!s) throw new Error("\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u6D4F\u89C8\u5668\u540C\u6B65");
  if (on) {
    await s.set({ [PREFIX + SYNC_FLAG]: true });
    await s.set({ [PREFIX + CRED]: await allCreds() });
  } else {
    await s.remove(PREFIX + CRED);
    await s.remove(PREFIX + SYNC_FLAG);
  }
}
async function pullSyncCreds() {
  if (!await syncEnabled()) return 0;
  const s = syncArea();
  if (!s) return 0;
  try {
    const got = await s.get(PREFIX + CRED);
    const cloud = got && got[PREFIX + CRED];
    if (!cloud || typeof cloud !== "object") return 0;
    const merged = { ...await allCreds(), ...cloud };
    await set(CRED, merged);
    return Object.keys(cloud).length;
  } catch {
    return 0;
  }
}
const allCreds = async () => await get(CRED) || {};
async function putCred(accountKey, password) {
  const m = await allCreds();
  m[accountKey] = password;
  await set(CRED, m);
  const s = syncArea();
  if (s && await syncEnabled()) await s.set({ [PREFIX + CRED]: m });
}
async function dropCred(accountKey) {
  const m = await allCreds();
  delete m[accountKey];
  await set(CRED, m);
  const s = syncArea();
  if (s && await syncEnabled()) await s.set({ [PREFIX + CRED]: m });
}
async function clearVault() {
  await remove(CRED);
  await remove(TOKENS);
  const b = browserApi();
  if (b?.storage?.local) {
    try {
      await b.storage.local.remove("mooc.capturedToken");
      await b.storage.local.remove("mooc.importSuppressed");
    } catch {
    }
  }
  const s = syncArea();
  if (s && await syncEnabled()) await s.set({ [PREFIX + CRED]: {} });
}
const allTokens = async () => await get(TOKENS) || {};
async function putToken(accountKey, token) {
  const m = await allTokens();
  m[accountKey] = { ...token, obtainedAt: token?.obtainedAt || Date.now() };
  await set(TOKENS, m);
}
async function putTokens(map) {
  const out = {};
  for (const [k, t] of Object.entries(map || {})) {
    if (t && t.access_token) out[k] = { ...t, obtainedAt: t?.obtainedAt || Date.now() };
  }
  await set(TOKENS, out);
}
async function dropToken(accountKey) {
  const m = await allTokens();
  delete m[accountKey];
  await set(TOKENS, m);
}
function tokenTtlMs(token) {
  const exp = Number(token?.expires_in || 0);
  return exp > 0 ? exp * 1e3 : null;
}
function tokenLifetimeLeft(token, now = Date.now()) {
  const ttl = tokenTtlMs(token);
  if (ttl == null) return null;
  const at = Number(token?.obtainedAt || token?.login_time || 0) || now;
  return at + ttl - now;
}
function renewWithinMs(token) {
  const ttl = tokenTtlMs(token);
  if (ttl == null) return null;
  return Math.round(Math.min(7 * 864e5, Math.max(30 * 6e4, ttl * 0.2)));
}
function formatTtl(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "\u672A\u77E5";
  const days = ms / 864e5;
  if (days >= 1) return `${Math.round(days)} \u5929`;
  const hours = ms / 36e5;
  if (hours >= 1) return `${Math.round(hours)} \u5C0F\u65F6`;
  return `${Math.max(1, Math.round(ms / 6e4))} \u5206\u949F`;
}
export {
  allCreds,
  allTokens,
  clearVault,
  dropCred,
  dropToken,
  formatTtl,
  pullSyncCreds,
  putCred,
  putToken,
  putTokens,
  renewWithinMs,
  setSyncEnabled,
  syncEnabled,
  syncSupported,
  tokenLifetimeLeft,
  tokenTtlMs
};
