const NEED_LOGIN_KEY = "mooc.needLogin";
function stripSensitive(raw) {
  const src = String(raw);
  const [beforeHash, ...rest] = src.split("#");
  const base = beforeHash.split("?")[0];
  const hash = rest.join("#").split("?")[0];
  const out = (base + (hash ? `#${hash}` : "")).replace(/([?&#](?:access_token|refresh_token|id_token|token|code)=)[^&]*/gi, "$1***");
  return out.slice(0, 300);
}
const DEDUPE_MS = 3e4;
const ext = () => globalThis.browser || globalThis.chrome;
async function activeAccountKey() {
  try {
    const api = ext();
    if (!api?.storage?.local?.get) return "";
    const got = await api.storage.local.get("mooc.activeAccount");
    return String(got?.["mooc.activeAccount"] || "");
  } catch {
    return "";
  }
}
async function markNeedLogin(why, opts = {}) {
  const now = opts.at || Date.now();
  const rec = {
    at: now,
    why: String(why || "\u767B\u5F55\u6001\u5DF2\u5931\u6548").slice(0, 120),
    ...opts.url ? { url: stripSensitive(opts.url) } : {},
    ...opts.account ? { account: String(opts.account).slice(0, 80) } : {}
  };
  try {
    const cur = await readNeedLogin();
    if (cur && cur.at > 0 && now - cur.at < DEDUPE_MS && (cur.account || "") === (rec.account || "") && cur.why === rec.why) {
      return cur;
    }
    if (cur?.account && rec.account && cur.account !== rec.account) {
      const act = await activeAccountKey();
      if (cur.account === act && rec.account !== act) return cur;
    }
    const api = ext();
    if (api?.storage?.local?.set) await api.storage.local.set({ [NEED_LOGIN_KEY]: rec });
    else globalThis.localStorage?.setItem(NEED_LOGIN_KEY, JSON.stringify(rec));
    return rec;
  } catch {
    return null;
  }
}
async function readNeedLogin() {
  try {
    const api = ext();
    let raw;
    if (api?.storage?.local?.get) raw = (await api.storage.local.get(NEED_LOGIN_KEY))?.[NEED_LOGIN_KEY];
    else {
      const s = globalThis.localStorage?.getItem(NEED_LOGIN_KEY);
      raw = s ? JSON.parse(s) : null;
    }
    if (!raw || typeof raw !== "object") return null;
    const at = Number(raw.at);
    if (!(at > 0)) return null;
    return {
      at,
      why: String(raw.why || ""),
      url: raw.url ? String(raw.url) : void 0,
      account: raw.account ? String(raw.account) : void 0,
      ...raw.dismissed ? { dismissed: true } : {}
    };
  } catch {
    return null;
  }
}
async function clearNeedLogin(accountKey) {
  if (accountKey) {
    const cur = await readNeedLogin();
    if (cur?.account && cur.account !== accountKey) return;
  }
  try {
    const api = ext();
    if (api?.storage?.local?.remove) await api.storage.local.remove(NEED_LOGIN_KEY);
    else globalThis.localStorage?.removeItem(NEED_LOGIN_KEY);
  } catch {
  }
}
function isLoginWallError(e) {
  if (!e) return false;
  const status = Number(e.status || 0);
  const code = String(e.errorCode || "");
  if (status === 401 || code === "90901" || code === "90902" || code === "90908" || code === "90105") return true;
  return /登录态已失效|登录状态已过期|请重新登录/.test(String(e.message || ""));
}
const LOGIN_ROUTE_RE = /#!?\/(login|oauth|sso)\b|#login\/|\/oauth(?:\/|$)/i;
const LOGIN_TEXT_RE = /登录已失效|登录已过期|登录超时|登录状态已过期|请重新登录|重新登录后继续|请先登录|用户未登录/;
function detectLoginWall(input) {
  const path = String(input.pathname || "");
  const hash = String(input.hash || "");
  const href = String(input.href || "");
  if (LOGIN_ROUTE_RE.test(hash) || LOGIN_ROUTE_RE.test(path)) return "\u5E73\u53F0\u8DF3\u8F6C\u5230\u767B\u5F55\u9875";
  if (LOGIN_TEXT_RE.test(String(input.bodyText || ""))) return "\u5E73\u53F0\u63D0\u793A\u767B\u5F55\u5DF2\u5931\u6548";
  if (input.hasLoginForm) return "\u9875\u9762\u51FA\u73B0\u767B\u5F55\u8868\u5355";
  if (LOGIN_ROUTE_RE.test(href) && !/#\/study\//.test(href)) return "\u5E73\u53F0\u8DF3\u8F6C\u5230\u767B\u5F55\u9875";
  return "";
}
function wallBannerVisible(wall, activeKey, knownKeys) {
  if (!wall || wall.dismissed) return false;
  if (!wall.account) return true;
  if (!knownKeys.includes(wall.account)) return false;
  return wall.account === String(activeKey || "");
}
export {
  NEED_LOGIN_KEY,
  clearNeedLogin,
  detectLoginWall,
  isLoginWallError,
  markNeedLogin,
  readNeedLogin,
  wallBannerVisible
};
