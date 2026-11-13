import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { authRouter } from './auth/routes.js';
import { apiRouter } from './routes/api.js';
import { env } from './env.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  // nginx 反代后面运行时，让 req.secure/req.ip 按转发头取值（决定 cookie 是否加 Secure）
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());

  // 认证端点限流：防爆破与无限注册（内存滑窗，按 IP）。GET /me 不计入此预算，另有粗限流
  const authHits = new Map<string, number[]>();
  const meHits = new Map<string, number[]>();
  const AUTH_WINDOW = 15 * 60_000, AUTH_MAX = 30;
  const ME_WINDOW = 60_000, ME_MAX = 300; // /me 是最便宜的未认证端点，粗限流防 DB 洪泛
  const prune = (map: Map<string, number[]>, now: number, window: number, hardCap: number): void => {
    for (const [k, ts] of map) {
      const alive = ts.filter((t) => now - t < window);
      if (alive.length === 0) map.delete(k); else map.set(k, alive);
      if (map.size > hardCap) break; // 只清到不过量，避免每次全表扫描
    }
    // 唯一 IP 洪泛下仍可能超硬顶：按插入序丢最旧的一半（Map 保序）
    if (map.size > hardCap) {
      let excess = map.size - (hardCap >> 1);
      for (const k of map.keys()) { if (excess-- <= 0) break; map.delete(k); }
    }
  };
  app.use('/api/auth', (req, res, next) => {
    const now = Date.now();
    const ip = req.ip ?? 'unknown';
    if (req.method === 'GET' && req.path === '/me') {
      const hits = (meHits.get(ip) ?? []).filter((t) => now - t < ME_WINDOW);
      if (hits.length >= ME_MAX) { res.status(429).json({ message: '请求过于频繁，请稍后再试' }); return; }
      hits.push(now); meHits.set(ip, hits); prune(meHits, now, ME_WINDOW, 20000);
      next(); return;
    }
    const hits = (authHits.get(ip) ?? []).filter((t) => now - t < AUTH_WINDOW);
    if (hits.length >= AUTH_MAX) { res.status(429).json({ message: '尝试过于频繁，请稍后再试' }); return; }
    hits.push(now);
    authHits.set(ip, hits);
    prune(authHits, now, AUTH_WINDOW, 20000);
    next();
  });

  app.use('/api/auth', authRouter);
  app.use('/api', apiRouter);

  // 生产：托管前端构建产物（Vite dist），SPA fallback
  const dist = join(here, '../../client/dist');
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(dist, 'index.html')));
  }

  // 统一错误兜底
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[app]', err.message);
    res.status(500).json({ message: env.isProd ? '服务器内部错误' : err.message });
  });

  return app;
}
