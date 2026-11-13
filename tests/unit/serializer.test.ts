/** 串行执行器: 值守「同时只开一个标签页」的时序保证 */
import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createSerializer } from '../../extension/lib/serializer.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('createSerializer: 并发调用按调用顺序串行执行（不重叠）', async () => {
  const run = createSerializer();
  const log: string[] = [];
  let active = 0;
  let maxActive = 0;

  const task = (name: string, ms: number) => async () => {
    active++;
    maxActive = Math.max(maxActive, active);
    log.push(`${name}:start`);
    await sleep(ms);
    log.push(`${name}:end`);
    active--;
    return name;
  };

  // 不 await: 模拟同一 tick 内连续两次开课
  const a = run(task('a', 30));
  const b = run(task('b', 5));
  const c = run(task('c', 1));
  assert.deepEqual(await Promise.all([a, b, c]), ['a', 'b', 'c']);

  assert.equal(maxActive, 1, '任何时刻都只有一个任务在跑');
  assert.deepEqual(log, ['a:start', 'a:end', 'b:start', 'b:end', 'c:start', 'c:end']);
});

test('createSerializer: 前一个失败不影响后一个, 错误仍抛给它的调用方', async () => {
  const run = createSerializer();
  const order: string[] = [];

  const bad = run(async () => { order.push('bad'); throw new Error('boom'); });
  const good = run(async () => { order.push('good'); return 1; });

  await assert.rejects(bad, /boom/);
  assert.equal(await good, 1);
  assert.deepEqual(order, ['bad', 'good']);
});

test('createSerializer: 返回值透传', async () => {
  const run = createSerializer();
  assert.equal(await run(async () => 42), 42);
});
