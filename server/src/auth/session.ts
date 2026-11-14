// Lucia 式自管会话：httpOnly cookie 存随机 token，库里存 sha256(token)。
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { env } from '../env.js';
import { sha256 } from '../platform/crypto.js';

const scrypt = promisify(_scrypt) as (p: string, s: Buffer, k: number) => Promise<Buffer>;

const COOKIE = 'session';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), 32);
  return timingSafeEqual(hash, Buffer.from(hashHex, 'hex'));
}

export async function createSession(req: Request, res: Response, userId: string): Promise<void> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.sessionTtlDays * 86400_000);
  await prisma.session.create({ data: { id: sha256(token), userId, expiresAt } });
  // 顺带清扫过期会话：只靠本人再次到访时删除，长生命周期部署下会无限增长
  prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // 部署形态已强制 https（nginx 443 TLS 终结 + 80 跳转）：生产环境恒发 Secure，
    // 防止会话 cookie 随明文 HTTP 外发；本地开发无证书仍靠 req.secure 判定
    secure: req.secure || env.isProd,
    maxAge: env.sessionTtlDays * 86400_000,
    path: '/',
  });
}

export async function destroySession(req: Request, res: Response, next?: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (token) await prisma.session.deleteMany({ where: { id: sha256(token) } });
  } catch (e) { next?.(e); return; }
  res.clearCookie(COOKIE, { path: '/', sameSite: 'lax', secure: req.secure || env.isProd });
  next?.();
}

/** 会话中间件：挂 req.user 或直接 401 */
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { user?: { id: string; username: string } }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = req.cookies?.[COOKIE] as string | undefined;
    if (!token) { res.status(401).json({ message: '未登录', code: 'AUTH' }); return; }
    const session = await prisma.session.findUnique({
      where: { id: sha256(token) },
      include: { user: true },
    });
    if (!session || session.expiresAt < new Date()) {
      if (session) await prisma.session.delete({ where: { id: session.id } });
      res.status(401).json({ message: '会话已过期', code: 'AUTH' });
      return;
    }
    req.user = { id: session.user.id, username: session.user.username };
    next();
  } catch (e) { next(e); }
}
