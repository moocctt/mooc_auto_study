/** 登录保护：失败次数/锁定/节流/成功清零/持久化 */
import { beforeEach, describe, expect, it } from 'vitest';
import { GUARD_POLICY, loginStatus, recordAttempt, recordFailure, recordSuccess, setGuardEnv } from '../../extension/lib/loginGuard.js';

const m = new Map<string, string>();
const mem = { getItem: (k: string) => (m.has(k) ? m.get(k)! : null), setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); }, clear: () => m.clear(), key: () => null, length: 0 } as unknown as Storage;
let t = 1000;
const setNow = (ms: number) => { t = ms; };
const env = () => setGuardEnv(mem, () => t);

beforeEach(() => { m.clear(); t = Date.now(); env(); });

describe('loginGuard', () => {
  it('连续 3 次失败 → 本地锁定 30 分钟（每次失败后 15 秒节流）', () => {
    const u = 'a@b';
    const base = t;
    for (let i = 1; i <= GUARD_POLICY.MAX_FAILS - 1; i++) {
      setNow(base + i * (GUARD_POLICY.MIN_INTERVAL_MS + 1));
      const r = recordFailure(u);
      expect(r.left).toBeGreaterThan(0);
    }
    setNow(base + GUARD_POLICY.MAX_FAILS * (GUARD_POLICY.MIN_INTERVAL_MS + 1));
    const r3 = recordFailure(u);
    expect(r3.left).toBe(0);
    const st = loginStatus(u);
    expect(st.allowed).toBe(false);
    expect(st.waitMs).toBeGreaterThan(GUARD_POLICY.LOCK_MS - 1000);   // 锁定优先于节流
  });
  it('锁定到期后恢复', () => {
    const u = 'c@d';
    recordFailure(u); recordFailure(u); recordFailure(u);
    expect(loginStatus(u).allowed).toBe(false);
    setNow(t + GUARD_POLICY.MAX_FAILS * GUARD_POLICY.MIN_INTERVAL_MS + GUARD_POLICY.LOCK_MS + 1);
    // 锁定到期但节流仍可能生效：再推进一点
    setNow(t + GUARD_POLICY.LOCK_MS * 2);
    expect(loginStatus(u).allowed).toBe(true);
  });
  it('15 秒节流', () => {
    const u = 'e@f';
    recordAttempt(u);
    expect(loginStatus(u).allowed).toBe(false);
    setNow(t + GUARD_POLICY.MIN_INTERVAL_MS + 1);
    expect(loginStatus(u).allowed).toBe(true);
  });
  it('成功登录清零', () => {
    const u = 'g@h';
    recordFailure(u); recordFailure(u);
    expect(loginStatus(u).fails).toBe(2);
    recordSuccess(u);
    expect(loginStatus(u)).toEqual({ allowed: true, waitMs: 0, fails: 0, left: GUARD_POLICY.MAX_FAILS });
  });
  it('不同账号互不影响', () => {
    recordFailure('x'); recordFailure('x'); recordFailure('x');
    expect(loginStatus('x').allowed).toBe(false);
    expect(loginStatus('y').allowed).toBe(true);
  });
});
