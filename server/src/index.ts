import { createApp } from './app.js';
import { startScheduler } from './engine/scheduler.js';
import { prisma } from './db.js';
import { env } from './env.js';

const app = createApp();
const listener = app.listen(env.port, () => {
  const dbHost = (() => {
    try { return new URL(env.databaseUrl).host || 'sqlite'; } catch { return 'sqlite'; }
  })();
  console.log(`[server] http://localhost:${env.port}（db=${dbHost}）`);
});

// 兜底清扫过期会话（登录时也会顺带清，这里防长期无登录的库）
startScheduler();

const sweep = setInterval(() => {
  prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } }).catch(() => {});
}, 24 * 3600_000);
sweep.unref();

const shutdown = async () => {
  await new Promise<void>((r) => listener.close(() => r())); // 在途请求处理完再退
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
