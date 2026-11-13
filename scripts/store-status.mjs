// 商店审核状态盯守 —— 不用人工开三个后台，也不用 AI Agent 查。
//
// 数据源:
//   CWS:  GET https://www.googleapis.com/chromewebstore/v1.1/items/{id}
//         (OAuth refresh_token 换 access_token, 与 submit 同一套凭据)
//   AMO:  GET https://addons.mozilla.org/api/v4/addons/addon/{guid}
//         (JWT HS256, issuer/secret 与 amo-submit 同一套)
//   Edge: Partner Center 无公开只读 API, 暂不支持（提交已自动化, 状态人工看一次即可）
//
// 用法:
//   node scripts/store-status.mjs            # 打印各商店状态, 全部正常 exit 0
//   node scripts/store-status.mjs --json     # JSON 输出（workflow 用）
//   node scripts/store-status.mjs --watch-diff  # 与 .store-status.snapshot.txt 比较, 有变化 exit 10
//
// 注意: 本机若到 oauth2.googleapis.com 不通, 会报网络错误 —— CI（GitHub runner）没问题。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createHmac } from "node:crypto";

const root = process.cwd();
const env = { ...process.env };
// CI secrets 叫 CWS_*, 本地 .env.submit 叫 CHROME_* —— 两套名都认
for (const [from, to] of [
  ["CWS_EXTENSION_ID", "CHROME_EXTENSION_ID"],
  ["CWS_CLIENT_ID", "CHROME_CLIENT_ID"],
  ["CWS_CLIENT_SECRET", "CHROME_CLIENT_SECRET"],
  ["CWS_REFRESH_TOKEN", "CHROME_REFRESH_TOKEN"],
]) if (!env[to] && env[from]) env[to] = env[from];

// 本地无 CI 环境变量时, 尝试读 .env.submit（只取所需键, 不打印值）
if (existsSync(resolve(root, ".env.submit"))) {
  for (const line of readFileSync(resolve(root, ".env.submit"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^(CHROME_EXTENSION_ID|CHROME_CLIENT_ID|CHROME_CLIENT_SECRET|CHROME_REFRESH_TOKEN|FIREFOX_EXTENSION_ID|FIREFOX_JWT_ISSUER|FIREFOX_JWT_SECRET)=(.*)$/);
    if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^"|"$|^\s+|\s+$/g, "");
  }
}

const JSON_OUT = process.argv.includes("--json");
const WATCH_DIFF = process.argv.includes("--watch-diff");
const results = [];
const note = (store, state, detail = "") => { results.push({ store, state, detail }); };

// ---- CWS ----
async function checkChrome() {
  if (!env.CHROME_CLIENT_ID || !env.CHROME_CLIENT_SECRET || !env.CHROME_REFRESH_TOKEN || !env.CHROME_EXTENSION_ID) {
    note("chrome", "SKIPPED", "凭据缺失"); return;
  }
  try {
    const tr = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.CHROME_CLIENT_ID,
        client_secret: env.CHROME_CLIENT_SECRET,
        refresh_token: env.CHROME_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }),
    });
    if (!tr.ok) { note("chrome", "AUTH_FAIL", `token ${tr.status}`); return; }
    const token = (await tr.json()).access_token;
    const r = await fetch(`https://www.googleapis.com/chromewebstore/v1.1/items/${env.CHROME_EXTENSION_ID}?projection=DRAFT`, {
      headers: { Authorization: `Bearer ${token}`, "x-goog-api-version": "2" },
    });
    const j = await r.json().catch(() => null);
    if (!r.ok) { note("chrome", "API_FAIL", `GET ${r.status} ${j?.error?.message ?? ""}`.trim()); return; }
    // CWS 现在只支持 projection=DRAFT, 审核状态在 uploadState:
    // NOT_FOUND(无草稿, 通常=已提交在审) / ITEM_PENDING_REVIEW / ITEM_APPROVED / ITEM_REJECTED ...
    note("chrome", j.uploadState ?? "UNKNOWN", j.crxVersion ? `crx ${j.crxVersion}` : "");
  } catch (e) {
    note("chrome", "NETWORK_FAIL", String(e.message ?? e).slice(0, 120));
  }
}

// ---- AMO ----
function amoJwt(issuer, secret) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const payload = b64({ iss: issuer, jti: String(now) + "-" + Math.random().toString(36).slice(2, 10), iat: now, exp: now + 300 });
  const sig = createHmac("sha256", secret).update(`${head}.${payload}`).digest("base64url");
  return `${head}.${payload}.${sig}`;
}
async function checkFirefox() {
  if (!env.FIREFOX_JWT_ISSUER || !env.FIREFOX_JWT_SECRET || !env.FIREFOX_EXTENSION_ID) {
    note("firefox", "SKIPPED", "凭据缺失"); return;
  }
  try {
    const r = await fetch(`https://addons.mozilla.org/api/v5/addons/addon/${env.FIREFOX_EXTENSION_ID}/`, {
      headers: { Authorization: `JWT ${amoJwt(env.FIREFOX_JWT_ISSUER, env.FIREFOX_JWT_SECRET)}` },
    });
    if (!r.ok) { note("firefox", "API_FAIL", `GET ${r.status}`); return; }
    const j = await r.json();
    const ver = Array.isArray(j.versions) && j.versions[0];
    const vst = ver?.file?.status ?? ver?.files?.[0]?.status ?? "";
    note("firefox", j.status ?? "UNKNOWN", ver ? `最新版本 ${ver.version}: ${vst}` : "");
  } catch (e) {
    note("firefox", "NETWORK_FAIL", String(e.message ?? e).slice(0, 120));
  }
}

await checkChrome();
await checkFirefox();

// ---- 输出 ----
if (JSON_OUT) {
  console.log(JSON.stringify(results));
} else {
  for (const r of results) console.log(`${r.store.padEnd(8)} ${r.state}${r.detail ? `  (${r.detail})` : ""}`);
}

if (WATCH_DIFF) {
  const snapPath = resolve(root, ".store-status.snapshot.txt");
  const current = results.map((r) => `${r.store}=${r.state}`).join("\n") + "\n";
  const prev = existsSync(snapPath) ? readFileSync(snapPath, "utf8") : "(首次)";
  if (prev !== current) {
    writeFileSync(snapPath, current);
    console.error(`STATUS_CHANGED\n之前:\n${prev}\n现在:\n${current}`);
    process.exit(10);
  }
  console.error("状态无变化");
  process.exit(0);
}
// NETWORK_FAIL/SKIPPED 不算失败（本地没网/没凭据是常态）, CI 里凭据齐全时真状态都会打出来
process.exit(0);
