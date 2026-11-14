import { randomBytes } from 'node:crypto';

function required(name: string, fallback?: string | (() => string)): string {
  const v = process.env[name] ?? (typeof fallback === 'function' ? fallback() : fallback);
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

export const env = {
  port: Number(process.env.PORT ?? 8080),
  databaseUrl: required('DATABASE_URL', 'file:./prisma/dev.db'),
  // 平台账号密码落库前的加密密钥（hex 64 字符）。该 key 解密库里全部平台密码：
  // 随机兜底意味着密钥从未被备份，重启后所有绑定静默失效，所以生产环境缺失直接拒绝启动
  platformEncKey: (() => {
    const key = process.env.PLATFORM_ENC_KEY;
    if (key) return key;
    if (process.env.NODE_ENV === 'production') {
      console.error('[env] 生产环境缺少 PLATFORM_ENC_KEY：该密钥用于加密/解密库内平台账号密码，'
        + '缺失会导致重启后所有平台绑定失效。请执行 `openssl rand -hex 32` 生成，'
        + '写入 .env 或容器环境变量后重启（一经设定不可更改，改了旧密文解不开）。');
      process.exit(1);
    }
    console.warn('[env] PLATFORM_ENC_KEY 未设置，本次使用一次性随机密钥：重启后库内平台密码不可解，'
      + '所有用户需重新绑定平台账号。仅限本地开发，生产环境（NODE_ENV=production）会直接拒绝启动。');
    return randomBytes(32).toString('hex');
  })(),
  sessionTtlDays: 30,
  isProd: process.env.NODE_ENV === 'production',
};

if (!/^[0-9a-f]{64}$/.test(env.platformEncKey)) throw new Error('PLATFORM_ENC_KEY 必须是 64 位 hex（openssl rand -hex 32）');
