// 每用户引擎实例管理：进程内运行，日志环形缓冲，重启即清空（引擎本来就是短任务）。
import { createEngine } from './engine.js';
import { PlatformError } from '../platform/client.js';
import { platformToken } from '../auth/routes.js';
import { prisma } from '../db.js';

const LOG_LIMIT = 500;

interface RunState {
  engine: ReturnType<typeof createEngine> | null;
  logs: string[];
  running: boolean;
  startedAt: number | null;
}

const runs = new Map<string, RunState>();

function getRun(userId: string): RunState {
  let r = runs.get(userId);
  if (!r) {
    r = { engine: null, logs: [], running: false, startedAt: null };
    runs.set(userId, r);
  }
  return r;
}

export async function startRun(userId: string, courseId: string, trigger: 'manual' | 'schedule' = 'manual'): Promise<{ ok: boolean; message?: string }> {
  const r = getRun(userId);
  if (r.running) return { ok: false, message: '已在运行中，请先停止' };
  const log = (msg: string) => {
    r.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${msg}`);
    if (r.logs.length > LOG_LIMIT) r.logs.splice(0, r.logs.length - LOG_LIMIT);
  };
  r.logs = [];
  // run 行先落库：失败运行也要可回溯（此前在 platformToken 成功后才建行，失败根本不入库）
  let runId: string | null = null;
  try {
    runId = (await prisma.engineRun.create({ data: { userId, trigger, reason: 'running' } })).id;
  } catch { /* 建行失败不阻断运行：日志页仍可见进度 */ }
  // 同步验证凭据：未绑定/解密失败直接返回失败，而不是假成功让用户干等
  try {
    await platformToken(userId, log);
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    log(`✗ ${errMsg}`);
    if (runId) {
      await prisma.engineRun.update({ where: { id: runId }, data: { endedAt: new Date(), reason: 'error' } }).catch(() => {});
    }
    return { ok: false, message: errMsg };
  }
  r.running = true;
  r.startedAt = Date.now();
  // 后台跑，不 await；完成后自然置位。platformToken 已缓存，不会再登录
  void (async () => {
    let quotaHit = false;
    let errMsg: string | undefined;
    try {
      // 引擎闭包捕获启动时的 token 快照；401 即整体终止，重跑一次即可（代理类接口有自己的重登）
      const token = await platformToken(userId, log);
      const engine = createEngine({ token, log });
      r.engine = engine;
      const res = await engine.runAll(courseId);
      quotaHit = res.quotaHit;
      errMsg = res.error;
    } catch (e) {
      errMsg = e instanceof PlatformError ? e.message : (e instanceof Error ? e.message : String(e));
      log(`✗ ${errMsg}`);
    } finally {
      const s = r.engine?.getState();
      if (runId) {
        const reason = errMsg ? 'error' : s?.stopFlag ? 'stopped' : quotaHit ? 'quota' : 'completed';
        await prisma.engineRun.update({ where: { id: runId }, data: {
          endedAt: new Date(), reason, submitted: s?.submitted ?? null,
        } }).catch(() => {});
      }
      r.running = false;
      r.startedAt = null;
    }
  })();
  return { ok: true };
}

export function stopRun(userId: string): { ok: boolean; message?: string } {
  const r = getRun(userId);
  if (!r.running) return { ok: false, message: '当前没有运行中的任务' };
  r.engine?.stop();
  return { ok: true };
}

export function runStatus(userId: string) {
  const r = getRun(userId);
  const s = r.engine?.getState() ?? { course: '', section: '', round: 0, submitted: 0 };
  return {
    running: r.running,
    startedAt: r.startedAt,
    course: s.course,
    section: s.section,
    round: s.round,
    submitted: s.submitted,
    logs: r.logs.slice(-100),
  };
}
