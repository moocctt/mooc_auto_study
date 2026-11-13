// 每用户定时引擎：每天到点自动 startRun（当天只补跑一次，错过 30 分钟内仍补）。
import { prisma } from '../db.js';
import { startRun, runStatus } from './runner.js';

const TICK_MS = 60_000;
// 错过触发点多久内仍补跑（服务重启 / 卡顿兜底）
const GRACE_MIN = 30;

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  const now = new Date();
  const day = dayKey(now);
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  const rows = await prisma.engineSchedule.findMany({ where: { enabled: true } });
  for (const s of rows) {
    if (s.lastRunDay === day) continue;
    const due = s.hour * 60 + s.minute;
    if (minutesNow < due || minutesNow - due > GRACE_MIN) continue;
    const user = await prisma.user.findUnique({ where: { id: s.userId }, select: { platformUsername: true } });
    if (!user?.platformUsername) continue; // 未绑定平台，跳过（明天再试）
    if (runStatus(s.userId).running) { continue; } // 手动跑着，今天算数
    // 先落 lastRunDay 再启动：启动失败也不会每分钟重试轰炸
    await prisma.engineSchedule.update({ where: { userId: s.userId }, data: { lastRunDay: day } });
    console.log(`[scheduler] 定时启动 userId=${s.userId}（计划 ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}）`);
    await startRun(s.userId, '', 'schedule');
  }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => { tick().catch((e) => console.error('[scheduler]', e)); }, TICK_MS);
  timer.unref();
}
