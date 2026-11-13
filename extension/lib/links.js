const BASE = "https://mooc.ctt.cn";
function platformUrl(row) {
  const u = String(row?.url || "");
  if (u && /^https?:\/\//.test(u)) return u;
  const id = String(row?.bid || row?.id || "");
  if (!id) return BASE;
  return row?.type === "\u4E13\u9898" ? `${BASE}/#/study/subject/detail/${encodeURIComponent(id)}` : `${BASE}/#/study/course/detail/1&${encodeURIComponent(id)}`;
}
function ssoCourseUrl(row, token, kind = 1) {
  if (!token?.access_token) return platformUrl(kind === 2 ? { ...row, type: "\u4E13\u9898" } : row);
  const id = String(row?.bid || row?.id || "");
  const state = kind === 2 ? `/study/subject/detail/${id}` : `/study/course/detail/1&${id}`;
  const f = new URLSearchParams({
    access_token: token.access_token,
    token_type: token.token_type || "Bearer",
    state
  });
  if (token.expires_in) f.set("expires_in", String(token.expires_in));
  return `${BASE}/#${f}`;
}
const COURSE_DETAIL_RE = /\/study\/(?:course\/detail\/\d+&|subject\/detail\/)[0-9a-zA-Z-]+/;
function isCourseDetailUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname === "mooc.ctt.cn" && COURSE_DETAIL_RE.test(decodeURIComponent(u.hash || ""));
  } catch {
    return false;
  }
}
function platformSsoUrl(token) {
  const t = token || {};
  if (!t.access_token) return BASE;
  const f = new URLSearchParams({
    access_token: String(t.access_token),
    token_type: String(t.token_type || "Bearer"),
    state: "ext"
  });
  if (t.expires_in) f.set("expires_in", String(t.expires_in));
  return `${BASE}/#${f.toString()}`;
}
export {
  COURSE_DETAIL_RE,
  isCourseDetailUrl,
  platformSsoUrl,
  platformUrl,
  ssoCourseUrl
};
