function tokenUsableAt(tok, now = Date.now()) {
  if (!tok || typeof tok !== "object") return false;
  if (!tok.access_token) return false;
  const ttl = Number(tok.expires_in);
  if (!Number.isFinite(ttl) || ttl <= 0) return true;
  const at = Number(tok.obtainedAt);
  if (!Number.isFinite(at) || at <= 0) return true;
  return at + ttl * 1e3 > now;
}
function accountUsable(tok, wall, key, now = Date.now()) {
  if (!tokenUsableAt(tok, now)) return false;
  if (wall?.account === key && Number(wall.at || 0) >= Number(tok?.obtainedAt || 0)) return false;
  return true;
}
function resolveActiveKey(tokens, hint) {
  const map = tokens && typeof tokens === "object" ? tokens : {};
  const keys = Object.keys(map);
  if (hint) return hint;
  if (keys.length === 1) return keys[0];
  return "";
}
function loginState(tokens, now = Date.now(), wall = null, activeKey) {
  const map = tokens && typeof tokens === "object" ? tokens : {};
  const keys = Object.keys(map);
  if (!keys.length) return wall ? "expired" : "none";
  const key = resolveActiveKey(map, activeKey);
  if (key) return accountUsable(map[key], wall, key, now) ? "ok" : "expired";
  return keys.some((k) => accountUsable(map[k], wall, k, now)) ? "ok" : "expired";
}
function authUi(input, now = Date.now()) {
  const map = input.tokens && typeof input.tokens === "object" ? input.tokens : {};
  const wall = input.wall || null;
  const activeKey = resolveActiveKey(map, input.activeKey);
  const st = loginState(map, now, wall, input.activeKey);
  if (st === "ok") {
    const wallHitsActive = !!wall && (!wall.account ? false : wall.account === activeKey ? !map[wall.account] || !accountUsable(map[wall.account], wall, wall.account, now) : false);
    if (wallHitsActive) return { grey: false, title: "\u767B\u5F55\u6001\u5DF2\u5931\u6548 \xB7 \u70B9\u51FB\u91CD\u65B0\u767B\u5F55", badge: "alert" };
    if (input.apOn) return { grey: false, title: "", badge: input.apPlaying ? "playing" : "busy" };
    return { grey: false, title: "", badge: "off" };
  }
  if (st === "none") {
    return { grey: true, title: "\u672A\u767B\u5F55 \xB7 \u70B9\u51FB\u767B\u5F55", badge: "off" };
  }
  const othersUsable = Object.keys(map).some((k) => k !== activeKey && accountUsable(map[k], wall, k, now));
  const title = wall ? "\u767B\u5F55\u6001\u5DF2\u5931\u6548 \xB7 \u70B9\u51FB\u91CD\u65B0\u767B\u5F55" : othersUsable ? "\u5F53\u524D\u8D26\u53F7\u767B\u5F55\u6001\u5DF2\u8FC7\u671F \xB7 \u5207\u6362\u8D26\u53F7\u6216\u91CD\u65B0\u767B\u5F55" : "\u767B\u5F55\u6001\u5DF2\u8FC7\u671F \xB7 \u70B9\u51FB\u91CD\u65B0\u767B\u5F55";
  return { grey: true, title, badge: "alert" };
}
export {
  accountUsable,
  authUi,
  loginState,
  resolveActiveKey,
  tokenUsableAt
};
