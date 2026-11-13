const KEY = "mooc.login.guard.v1";
const MAX_FAILS = 3;
const LOCK_MS = 30 * 6e4;
const MIN_INTERVAL_MS = 15e3;
let storage = globalThis.localStorage;
let now = () => Date.now();
function setGuardEnv(s, nowFn) {
  storage = s;
  if (nowFn) now = nowFn;
}
const load = () => {
  try {
    return JSON.parse(storage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
};
const save = (s) => {
  try {
    storage.setItem(KEY, JSON.stringify(s));
  } catch {
  }
};
const keyOf = (username) => String(username || "").trim().toLowerCase() || "(unknown)";
function loginStatus(username) {
  const e = load()[keyOf(username)];
  if (!e) return { allowed: true, waitMs: 0, fails: 0, left: MAX_FAILS };
  const left = Math.max(0, MAX_FAILS - Number(e.fails || 0));
  if (e.lockedUntil > now()) return { allowed: false, waitMs: e.lockedUntil - now(), fails: e.fails, left };
  const wait = Math.max(0, Number(e.lastAt || 0) + MIN_INTERVAL_MS - now());
  return { allowed: wait <= 0, waitMs: wait, fails: Number(e.fails || 0), left };
}
function recordAttempt(username) {
  const s = load();
  const k = keyOf(username);
  s[k] = { ...s[k] || { fails: 0, lockedUntil: 0 }, lastAt: now() };
  save(s);
}
function recordFailure(username) {
  const s = load();
  const k = keyOf(username);
  const prev = s[k] || { fails: 0, lockedUntil: 0, lastAt: 0 };
  const fails = Number(prev.fails || 0) + 1;
  const lockedUntil = fails >= MAX_FAILS ? now() + LOCK_MS : 0;
  s[k] = { fails, lockedUntil, lastAt: now() };
  save(s);
  return { fails, left: Math.max(0, MAX_FAILS - fails), lockedUntil };
}
function recordSuccess(username) {
  const s = load();
  delete s[keyOf(username)];
  save(s);
}
const GUARD_POLICY = { MAX_FAILS, LOCK_MS, MIN_INTERVAL_MS };
export {
  GUARD_POLICY,
  loginStatus,
  recordAttempt,
  recordFailure,
  recordSuccess,
  setGuardEnv
};
