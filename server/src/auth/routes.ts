import { Router, type Request, type Response, type NextFunction } from 'express';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { PlatformError, platformLogin } from '../platform/client.js';
import { sealSecret, openSecret } from '../platform/crypto.js';
import { createSession, destroySession, hashPassword, requireAuth, verifyPassword } from './session.js';

export const authRouter = Router();

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,32}$/;

// Express 4 不会接住 async handler 的 rejection，进程会直接退出：统一包一层
const asyncH = (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res, next).catch(next); };

authRouter.post('/register', asyncH(async (req, res) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  if (!username || !USERNAME_RE.test(username)) { res.status(400).json({ message: '用户名 2-32 位，中英文/数字/下划线' }); return; }
  if (!password || password.length < 8) { res.status(400).json({ message: '密码至少 8 位' }); return; }
  // 直接 create，撞唯一约束回 409：先查后建在并发注册同名时是 TOCTOU
  let user;
  try {
    user = await prisma.user.create({
      data: { username, passwordHash: await hashPassword(password) },
    });
  } catch (e: unknown) {
    const code = (e as { code?: string })?.code;
    if (code === 'P2002') { res.status(409).json({ message: '用户名已存在' }); return; }
    throw e;
  }
  await createSession(req, res, user.id);
  res.json({ id: user.id, username: user.username });
}));

authRouter.post('/login', asyncH(async (req, res) => {
  const { username, password } = (req.body ?? {}) as { username?: string; password?: string };
  const user = username ? await prisma.user.findUnique({ where: { username } }) : null;
  // 用户不存在时也跑一遍哈希，避免计时侧信道区分用户名
  if (!user || !password || !(await verifyPassword(password, user.passwordHash))) {
    await hashPassword(password ?? '');
    res.status(401).json({ message: '用户名或密码错误' });
    return;
  }
  await createSession(req, res, user.id);
  res.json({ id: user.id, username: user.username });
}));

authRouter.post('/logout', asyncH(destroySession), (_req, res) => { res.json({ ok: true }); });

authRouter.get('/me', requireAuth, (req, res) => { res.json({ id: req.user!.id, username: req.user!.username }); });

/** 绑定平台账号：登录一次验证可用后加密落库 */
authRouter.post('/platform', requireAuth, asyncH(async (req, res) => {
  const { username, password, company } = (req.body ?? {}) as { username?: string; password?: string; company?: string };
  if (!username || !password) { res.status(400).json({ message: '需要平台账号与密码' }); return; }
  try { await platformLogin(username, password, company || '全行业'); } catch (e) {
    res.status(400).json({ message: e instanceof PlatformError ? e.message : '平台登录失败' });
    return;
  }
  await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      platformUsername: username,
      platformPasswordEnc: sealSecret(password, env.platformEncKey),
      platformCompany: company || '全行业',
    },
  });
  tokens.delete(req.user!.id); // 换账号后丢弃旧令牌
  res.json({ username, company: company || '全行业' });
}));

authRouter.get('/platform', requireAuth, asyncH(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) { res.status(401).json({ message: '用户不存在' }); return; }
  res.json(user.platformUsername ? { username: user.platformUsername, company: user.platformCompany } : null);
}));

authRouter.delete('/platform', requireAuth, asyncH(async (req, res) => {
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { platformUsername: null, platformPasswordEnc: null, platformCompany: '全行业' },
  });
  tokens.delete(req.user!.id);
  res.json({ ok: true });
}));

/** 解密库内平台凭据（仅供引擎/代理用） */
export async function platformCreds(userId: string): Promise<{ username: string; password: string; company: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.platformUsername || !user.platformPasswordEnc) return null;
  try {
    return { username: user.platformUsername, password: openSecret(user.platformPasswordEnc, env.platformEncKey), company: user.platformCompany };
  } catch {
    throw new PlatformError('平台凭据解密失败（PLATFORM_ENC_KEY 与写入时不一致）', false);
  }
}

/** 每用户平台令牌缓存：401 时用库内凭据重登一次 */
const tokens = new Map<string, string>();
export function invalidateToken(userId: string): void { tokens.delete(userId); }

export async function platformToken(userId: string, log: (m: string) => void = () => {}): Promise<string> {
  const cached = tokens.get(userId);
  if (cached) return cached;
  const creds = await platformCreds(userId);
  if (!creds) throw new PlatformError('尚未绑定平台账号', true);
  const token = await platformLogin(creds.username, creds.password, creds.company);
  tokens.set(userId, token);
  log(`平台登录成功：${creds.username}`);
  return token;
}

/** 带自动重登的平台调用 */
export async function withPlatform<T>(userId: string, fn: (token: string) => Promise<T>, log?: (m: string) => void): Promise<T> {
  try { return await fn(await platformToken(userId, log)); }
  catch (e) {
    if (e instanceof PlatformError && e.auth) {
      invalidateToken(userId);
      return fn(await platformToken(userId, log));
    }
    throw e;
  }
}
