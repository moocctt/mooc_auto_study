// 平台 HTTP 客户端：https 直连 + 每用户令牌缓存 + 401 自动重登一次。
import { request, Agent } from 'node:https';
import { encField, fingerprintFor, HASH_KEY } from './crypto.js';
export interface PlatformBound { username: string; company: string }

const ORIGIN = 'https://mooc.ctt.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export class PlatformError extends Error {
  constructor(message: string, public readonly auth = false) { super(message); }
}

interface RawResponse { status: number; headers: Record<string, string | string[] | undefined>; text: string }

// 复用 TLS 连接：引擎一轮要发几十个请求，不握手每次都付 TCP+TLS 全价
const agent = new Agent({ keepAlive: true, maxSockets: 4 });
const MAX_BODY = 5 * 1024 * 1024; // 平台响应体积上限，防止异常来源撑爆内存

function send(method: string, path: string, body?: string, headers: Record<string, string> = {}, timeoutMs = 20_000): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      ORIGIN + path,
      {
        method,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          Referer: `${ORIGIN}/`,
          Origin: ORIGIN,
          ...headers,
        },
        timeout: timeoutMs,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) { res.destroy(); req.destroy(new PlatformError('平台响应超过 5MB，已中止')); return; }
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text });
        });
      },
    );
    req.on('timeout', () => { req.destroy(new PlatformError('平台请求超时')); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function parseJson(res: RawResponse): unknown {
  try { return JSON.parse(res.text); } catch { throw new PlatformError(`平台返回非 JSON（HTTP ${res.status}）：${res.text.slice(0, 120)}`); }
}

/** 平台接口通用调用：GET+query 或 POST+form-urlencoded（与平台前端一致，不是 JSON） */
export async function platformReq(
  token: string,
  method: 'GET' | 'POST',
  apiPath: string,
  { params, data }: { params?: Record<string, unknown>; data?: Record<string, unknown> } = {},
): Promise<{ status: number; body: Record<string, unknown> | unknown[] | null }> {
  const pystr = (v: unknown) => (v === true ? 'True' : v === false ? 'False' : v === null || v === undefined ? '' : String(v));
  const qsOf = (p: Record<string, unknown> | undefined) => {
    if (!p) return '';
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(p)) if (v !== null && v !== undefined) sp.append(k, pystr(v));
    return sp.toString();
  };
  const query = qsOf(params);
  const url = apiPath + (query ? `?${query}` : '');
  const headers: Record<string, string> = { Authorization: `Bearer__${token}` };
  let body: string | undefined;
  if (data) {
    body = qsOf(data);
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  }
  const res = await send(method, url, body, headers);
  if (res.status === 401) throw new PlatformError('平台登录态已失效', true);
  const head = res.text.trimStart();
  let parsed: Record<string, unknown> | unknown[] | null = null;
  if (head && head !== 'null' && head !== 'undefined') {
    if (head.startsWith('{') || head.startsWith('[')) {
      try { parsed = JSON.parse(head) as Record<string, unknown> | unknown[]; } catch { parsed = null; }
    }
  }
  if (parsed && !Array.isArray(parsed)) {
    const errorCode = (parsed as Record<string, unknown>).errorCode;
    const n = Number(errorCode);
    if (Number.isFinite(n) && n !== 0) {
      if (n === 90901 || n === 90902) throw new PlatformError('平台登录态已失效', true);
    }
  }
  return { status: res.status, body: parsed };
}

/** app-login：账号密码 → access_token（无验证码，绕开网页端短信二次验证） */
export async function platformLogin(username: string, password: string, company: string): Promise<string> {
  const fp = fingerprintFor(username);
  const fields: Record<string, string> = {
    username: encField(username),
    pword: encField(password),
    company_name: encField(company),
    login_method: encField('login-by-user'),
    client_id: encField('999'),
    displayDynamic: encField('true'),
    terminal: encField(fp.terminal),
    system: encField(fp.system),
    captcha: encField(''),
  };
  const body = new URLSearchParams(fields).toString();
  const res = await send('POST', '/oauth/api/v1/app-login', body, {
    'Content-Type': 'application/x-www-form-urlencoded',
    Referer: `${ORIGIN}/oauth/`,
  });
  const data = parseJson(res) as Record<string, unknown>;
  const token = data.access_token as string | undefined;
  if (!token) {
    const code = data.errorCode as number | undefined;
    const msgs: Record<number, string> = {
      900000: '参数无效（检查账号/密码/单位名称）',
      90105: '账号不存在',
      90106: '账号或密码错误',
      90903: '登录频次过多，请稍后再试',
      90908: '密码错误',
    };
    throw new PlatformError(`登录失败：${msgs[code ?? -1] ?? data.message ?? `HTTP ${res.status}`}`);
  }
  return token;
}

/** 用站点自己的二维码接口没意义——平台 App 扫码返回的令牌格式一致，这里提供 hashKey 供前端展示说明 */
export const oauthKey = HASH_KEY;

/** 平台绑定信息视图 */
export function boundOf(user: { platformUsername: string | null; platformCompany: string }): PlatformBound | null {
  return user.platformUsername ? { username: user.platformUsername, company: user.platformCompany } : null;
}
