// @ts-nocheck —— 测试桩动态结构, 类型检查豁免
/** 提示音: 默认开启、可持久化关闭、无 AudioContext 环境静默不抛错 */
import assert from 'node:assert/strict';
import { test, beforeEach } from 'vitest';

const store = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => store.set(k, String(v)),
  removeItem: (k: string) => store.delete(k),
};

const { sfx, sfxEnabled, setSfxEnabled } = await import('../../extension/lib/sfx.js');

beforeEach(() => { store.clear(); });

test('默认开启', () => {
  assert.equal(sfxEnabled(), true);
});

test('关闭后持久化, 重新读取仍为关闭', () => {
  setSfxEnabled(false);
  assert.equal(sfxEnabled(), false);
  assert.equal(store.get('mooc.console.sfx'), '0');
  setSfxEnabled(true);
  assert.equal(store.get('mooc.console.sfx'), '1');
});

test('没有 AudioContext 时静默跳过（不抛错）', () => {
  assert.equal((globalThis as any).AudioContext, undefined);
  assert.doesNotThrow(() => sfx('ok'));
  assert.doesNotThrow(() => sfx('err'));
});

test('有 AudioContext 时按音高/时长调度两个振荡器', () => {
  const started: { freq: number; dur: number }[] = [];
  class FakeOsc {
    type = 'sine'; frequency = { setValueAtTime: (f: number) => { this._f = f; } }; _f = 0;
    connect() { return this; }
    start(at: number) { this._at = at; }
    stop(at: number) { started.push({ freq: this._f, dur: Math.round((at - this._at) * 1000) }); }
  }
  (globalThis as any).AudioContext = class {
    currentTime = 0; state = 'running'; destination = {};
    createOscillator() { return new FakeOsc(); }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() { return this; } }; }
    resume() {}
  };
  setSfxEnabled(true);
  sfx('ok');
  assert.equal(started.length, 2, '两声');
  assert.deepEqual(started.map((s) => s.freq), [660, 990]);
  delete (globalThis as any).AudioContext;
});
