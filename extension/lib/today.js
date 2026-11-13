const LEDGER_BASE = "mooc.console.today.v1";
const ledgerKey = (accountKey) => `${LEDGER_BASE}.${accountKey || "default"}`;
const PROFILE_KEY = "mooc.console.profile.v1";
let store = globalThis.localStorage;
function setTodayStorage(s) {
  store = s;
}
const todayStr = () => {
  const d = /* @__PURE__ */ new Date();
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const readLedger = (accountKey) => {
  try {
    return JSON.parse(store.getItem(ledgerKey(accountKey)) || "{}");
  } catch {
    return {};
  }
};
const writeLedger = (o, accountKey) => {
  try {
    store.setItem(ledgerKey(accountKey), JSON.stringify(o));
  } catch {
  }
};
const round2 = (n) => Math.round(n * 100) / 100;
function todayUsed(hourSelf, accountKey) {
  const obj = readLedger(accountKey);
  if (obj.date !== todayStr()) return 0;
  if (obj.base !== void 0 && obj.last !== void 0) {
    const last = hourSelf == null ? Number(obj.last) : hourSelf;
    return Math.max(0, round2(last - Number(obj.base)));
  }
  return Math.max(0, Number(obj.used) || 0);
}
function todayHoursTotal(hourSelf, accountKey, history) {
  const used = todayUsed(hourSelf, accountKey);
  const recorded = Number(history?.[todayStr()] || 0);
  return Math.round(Math.max(used, recorded) * 100) / 100;
}
function recordTodayHours(hourSelf, sessionBase, accountKey) {
  if (!hourSelf || hourSelf <= 0) return;
  const today = todayStr();
  const obj = readLedger(accountKey);
  const legacy = obj.date === today && obj.base === void 0 ? Number(obj.used) || 0 : 0;
  if (obj.date !== today || obj.base === void 0) {
    writeLedger({ date: today, base: round2((sessionBase ?? hourSelf) - legacy), last: round2(hourSelf) }, accountKey);
  } else {
    writeLedger({ ...obj, last: round2(hourSelf) }, accountKey);
  }
}
function recordTodayUsed(delta, accountKey) {
  if (!delta || delta <= 0) return;
  const obj = readLedger(accountKey);
  if (obj.base !== void 0) return;
  const used = round2(todayUsed(void 0, accountKey) + delta);
  writeLedger({ date: todayStr(), used }, accountKey);
}
const DEFAULT_PROFILE = { label: "\u9ED8\u8BA4", weekday_hours: 2, weekend_hours: 4 };
function getProfile() {
  try {
    const raw = store.getItem(PROFILE_KEY);
    if (raw) return { ...DEFAULT_PROFILE, ...JSON.parse(raw) };
  } catch {
  }
  return { ...DEFAULT_PROFILE };
}
function setProfile(patch) {
  const next = { ...getProfile(), ...patch };
  try {
    store.setItem(PROFILE_KEY, JSON.stringify(next));
  } catch {
  }
  return next;
}
function todayCapacity() {
  const prof = getProfile();
  const dow = (/* @__PURE__ */ new Date()).getDay();
  const weekend = dow === 6 || dow === 0;
  return [Number(prof[weekend ? "weekend_hours" : "weekday_hours"]) || 0, prof];
}
function getLedger(accountKey) {
  const obj = readLedger(accountKey);
  return obj && Object.keys(obj).length ? obj : null;
}
function putLedger(accountKey, data) {
  if (!data || typeof data !== "object" || typeof data.date !== "string") return false;
  const clean = { date: data.date };
  for (const k of ["used", "base", "last"]) {
    const v = Number(data[k]);
    if (Number.isFinite(v)) clean[k] = v;
  }
  writeLedger(clean, accountKey);
  return true;
}
export {
  getLedger,
  getProfile,
  putLedger,
  recordTodayHours,
  recordTodayUsed,
  setProfile,
  setTodayStorage,
  todayCapacity,
  todayHoursTotal,
  todayStr,
  todayUsed
};
