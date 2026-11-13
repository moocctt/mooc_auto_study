function prefillForAccount(acc) {
  const key = String(acc?.key || "");
  const user = String(acc?.username || "");
  if (!key || !user) return "";
  return key === user ? user : "";
}
function wantsLogin(search) {
  try {
    return new URLSearchParams(String(search).split("#")[0]).get("login") === "1";
  } catch {
    return false;
  }
}
function stripLogin(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has("login")) return url;
    u.searchParams.delete("login");
    return u.toString();
  } catch {
    return url;
  }
}
function consoleUrl(base, opts = {}) {
  const params = new URLSearchParams();
  if (opts.login) params.set("login", "1");
  if (opts.onboard) params.set("onboard", "1");
  const q = params.toString();
  return base + (q ? `?${q}` : "");
}
export {
  consoleUrl,
  prefillForAccount,
  stripLogin,
  wantsLogin
};
