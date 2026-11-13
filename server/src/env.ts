import { randomBytes } from 'node:crypto';

function required(name: string, fallback?: string | (() => string)): string {
  const v = process.env[name] ?? (typeof fallback === 'function' ? fallback() : fallback);
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL', 'file:./prisma/dev.db'),
  // 平台账号密码落库前的加密密钥（hex 64 字符），缺失时生成一次性密钥（重启后旧密文不可解）
  platformEncKey: required('PLATFORM_ENC_KEY', () => {
    const key = randomBytes(32).toString('hex');
    console.warn('[env] PLATFORM_ENC_KEY 未设置，使用一次性随机密钥（重启后库内平台密码不可解）');
    return key;
  }),
  sessionTtlDays: 30,
  isProd: process.env.NODE_ENV === 'production',
};

if (!/^[0-9a-f]{64}$/.test(env.platformEncKey)) throw new Error('PLATFORM_ENC_KEY 必须是 64 位 hex（openssl rand -hex 32）');
