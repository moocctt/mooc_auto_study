import { apiUrl } from "./platform.js";
import { encField } from "./crypto.js";
import qrcode from "./vendor/qrcode.js";
const QR_TTL_MS = 55e3;
const QR_INTERVAL_MS = 2e3;
const OAUTH = "/oauth/api/v1";
const QR_HEADERS = {
  "X-Requested-With": "XMLHttpRequest",
  "Accept": "application/json;charset=UTF-8"
};
const sessionKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const wechatUrl = (uuid) => `https://wx.zhixueyun.com/mswx/wechat/tobaccoQR/login/${uuid}/v5/online`;
const toForm = (obj) => new URLSearchParams(obj).toString();
const oauthHashKey = () => {
  const params = `response_type=token&client_id=999&redirect_uri=${encodeURIComponent("https://mooc.ctt.cn/")}&state=${encodeURIComponent("index")}&lang=cn&cancelRememberState=0`;
  return btoa(params);
};
async function issueQr(kind, { fetchImpl } = {}) {
  const F = fetchImpl || ((u, i) => fetch(u, i));
  const get = async (path) => {
    const res = await F(apiUrl(path), { headers: QR_HEADERS, credentials: "include", signal: AbortSignal.timeout(2e4) });
    if (!res.ok) throw new Error(`\u53D6\u7801\u5931\u8D25 (HTTP ${res.status})`);
    return res.json();
  };
  if (kind === "app") {
    const body = await get(`${OAUTH}/deriveQRCode`);
    if (!body || !body.uuid || !body.data) throw new Error("\u53D6\u7801\u54CD\u5E94\u7F3A\u5C11 uuid/data");
    return { uuid: body.uuid, png: `data:image/png;base64,${body.data}` };
  }
  const uuid = crypto.randomUUID();
  const reg = await F(
    apiUrl(`${OAUTH}/createQRCode?uuid=${encodeURIComponent(uuid)}`),
    { method: "POST", headers: QR_HEADERS, credentials: "include", signal: AbortSignal.timeout(2e4) }
  );
  if (!reg.ok) throw new Error(`\u5FAE\u4FE1\u53D6\u7801\u5931\u8D25 (HTTP ${reg.status})`);
  const qr = qrcode(0, "Q");
  qr.addData(wechatUrl(uuid));
  qr.make();
  return { uuid, png: qr.createDataURL(6, 2) };
}
async function checkQr(kind, uuid, key, { fetchImpl } = {}) {
  const F = fetchImpl || ((u, i) => fetch(u, i));
  const readJson = async (res2) => {
    const text = await res2.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };
  if (kind === "app") {
    const qs = new URLSearchParams({ uuid, organizationId: encField(1), key: oauthHashKey() });
    const res2 = await F(apiUrl(`${OAUTH}/loginCheck?${qs}`), { headers: QR_HEADERS, credentials: "include", signal: AbortSignal.timeout(2e4) });
    const body2 = await readJson(res2);
    if (body2 && body2.access_token) return { done: true, token: body2 };
    if (!res2.ok) return { done: false, error: `\u626B\u7801\u72B6\u6001\u67E5\u8BE2\u88AB\u62D2 (HTTP ${res2.status}${body2 && body2.message ? "\uFF1A" + body2.message : ""}\uFF1Buuid=${uuid.slice(0, 13)})` };
    return { done: false };
  }
  const res = await F(
    apiUrl(`${OAUTH}/checkUUIDStatus?uuid=${encodeURIComponent(uuid)}`),
    { method: "POST", headers: QR_HEADERS, credentials: "include", signal: AbortSignal.timeout(2e4) }
  );
  const body = await readJson(res);
  if (!res.ok && res.status !== 200) {
    return { done: false, error: `\u67E5\u8BE2\u626B\u7801\u72B6\u6001\u5931\u8D25 (HTTP ${res.status})` };
  }
  if (!body || !body.status || !body.openId) return { done: false };
  const rawRes = await F(apiUrl(`${OAUTH}/weChat-auth`), {
    method: "POST",
    headers: { ...QR_HEADERS, credentials: "include", "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(2e4),
    body: toForm({ key: oauthHashKey(), organization_id: encField(1), openId: encField(body.openId) })
  });
  const raw = await rawRes.text();
  let tok = null;
  try {
    tok = raw ? JSON.parse(raw) : null;
  } catch {
    tok = null;
  }
  if (tok && tok.access_token) return { done: true, token: tok };
  const detail = tok && (tok.message || tok.errorCode || tok.error_description) || (raw || "").slice(0, 100) || `HTTP ${"?"}`;
  return { done: false, error: `\u5FAE\u4FE1\u5DF2\u626B\u7801\uFF0C\u4F46\u6362\u53D6\u51ED\u8BC1\u5931\u8D25\uFF08${detail}\uFF09\u3002\u53EF\u6539\u7528 APP \u626B\u7801`, raw: (raw || "").slice(0, 200) };
}
export {
  QR_INTERVAL_MS,
  QR_TTL_MS,
  checkQr,
  issueQr,
  oauthHashKey,
  sessionKey,
  wechatUrl
};
