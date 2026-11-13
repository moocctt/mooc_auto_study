// @ts-nocheck —— 测试桩动态结构
/** 运行记录: 残影收尾（reapStaleRuns）+ 日志归属（say 的 runId） */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createBrowserApi } from '../../extension/lib/api.js';

const LS_KEY = 'mooc.console.state.v1';

function memStore(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: any) => m.set(k, String(v)),
    removeItem: (k: string) => m.delete(k),
    _dump: () => Object.fromEntries(m),
  };
}

function makeApi(runs: any[], now = 1_700_000_000_000) {
  const storage = memStore({
    [LS_KEY]: JSON.stringify({ accounts: [], tokens: {}, mode: 'auto', dryRun: false, runs, activeKey: null }),
  });
  const api = createBrowserApi({
    storage,
    sessionStore: memStore(),
    fetchImpl: async () => ({ status: 200, ok: true, text: async () => '{}', json: async () => ({}) }),
    sleepFn: () => Promise.resolve(),
    WebSocketImpl: class { close() {} send() {} },
    win: undefined as any,
    now: () => now,
  });
  return { api, storage };
}

test('reapStaleRuns: 没有心跳的「运行中」收尾成中断（控制台被关掉的残影）', () => {
  const now = 1_700_000_000_000;
  const { api } = makeApi([
    { id: 'a', label: '学习课程', startedAt: now - 3600e3, status: 'running' },          // 一小时前, 无心跳
    { id: 'b', label: '值守 某课程', startedAt: now - 3600e3, pulseAt: now - 10_000, status: 'running' }, // 10 秒前还活着
    { id: 'c', label: '值守 旧的', startedAt: now - 7200e3, endedAt: now - 7000e3, status: 'done' },
  ], now);

  const n = api.reapStaleRuns();
  assert.equal(n, 1, '只收尾真正没心跳的那条');

  const byId = Object.fromEntries(api.state.runs.map((r: any) => [r.id, r]));
  assert.equal(byId.a.status, 'stopped');
  assert.equal(byId.a.interrupted, true, '标记为中断, 与「用户主动停止」区分');
  assert.equal(byId.a.endedAt, null, '结束时间未知 → 耗时显示「—」而不是瞎算');
  assert.equal(byId.b.status, 'running', '还有心跳的运行不能被误杀');
  assert.equal(byId.c.status, 'done');
});

test('reapStaleRuns: 超过阈值(5 分钟)才判死, 4 分钟前的心跳仍算活着', () => {
  const now = 1_700_000_000_000;
  const { api } = makeApi([
    { id: 'a', label: '学习课程', startedAt: now - 600e3, pulseAt: now - 240e3, status: 'running' },
  ], now);
  assert.equal(api.reapStaleRuns(), 0);
  assert.equal(api.state.runs[0].status, 'running');
});

test('say(text, runId): 日志能挂到指定运行上（回放历史值守日志靠它）', () => {
  const { api } = makeApi([]);
  api.say('值守开启', 'run-1');
  api.say('播放第 1 节');
  const logs = api.logs as any[];
  assert.equal(logs[logs.length - 2].runId, 'run-1');
  assert.equal(logs[logs.length - 1].runId, undefined, '不传 runId 时不归属任何运行');
});
