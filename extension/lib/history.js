const BASE = "mooc.console.today.v1.hist";
const keyOf = (accountKey) => `${BASE}.${accountKey || "default"}`;
let store = globalThis.localStorage;
function setHistoryStorage(s) {
  store = s;
}
const dayStr = (d = /* @__PURE__ */ new Date()) => {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
function getHistory(accountKey) {
  try {
    return JSON.parse(store.getItem(keyOf(accountKey)) || "{}");
  } catch {
    return {};
  }
}
function recordHistoryDay(accountKey, date, hours) {
  if (!Number.isFinite(hours) || hours <= 0) return false;
  const h = getHistory(accountKey);
  const prev = Number(h[date] || 0);
  if (hours <= prev) return false;
  h[date] = Math.round(hours * 100) / 100;
  try {
    store.setItem(keyOf(accountKey), JSON.stringify(h));
  } catch {
  }
  return true;
}
function levelOf(hours) {
  if (!hours || hours <= 0) return 0;
  if (hours < 0.5) return 1;
  if (hours < 1) return 2;
  if (hours < 2) return 3;
  return 4;
}
function heatmapCells(history, { weeks = 26, today = /* @__PURE__ */ new Date() } = {}) {
  const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const dow = end.getDay();
  const start = new Date(end);
  start.setDate(end.getDate() - dow - (weeks - 1) * 7);
  const out = [];
  for (let w = 0; w < weeks; w++) {
    const col = [];
    for (let d = 0; d < 7; d++) {
      const cur = new Date(start);
      cur.setDate(start.getDate() + w * 7 + d);
      const date = dayStr(cur);
      const future = cur.getTime() > end.getTime();
      const hours = future ? 0 : Number(history[date] || 0);
      col.push({ date, hours, level: future ? 0 : levelOf(hours), future });
    }
    out.push(col);
  }
  return out;
}
const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d) => {
  const t = atMidnight(d);
  t.setDate(t.getDate() - (t.getDay() + 6) % 7);
  return t;
};
function summarize(history, { today = /* @__PURE__ */ new Date(), todayHours } = {}) {
  const t = atMidnight(today);
  const key = dayStr(t);
  const merged = { ...history };
  if (todayHours != null) merged[key] = Math.max(Number(history[key] || 0), Math.max(0, todayHours));
  const sum = (from) => {
    let hours = 0;
    let days = 0;
    for (const [k, v] of Object.entries(merged)) {
      const d = /* @__PURE__ */ new Date(`${k}T00:00:00`);
      if (Number.isNaN(d.getTime())) continue;
      if (d < from || d > t) continue;
      const h = Number(v) || 0;
      if (h > 0) {
        hours += h;
        days += 1;
      }
    }
    return { hours: Math.round(hours * 100) / 100, days };
  };
  return {
    today: sum(t),
    week: sum(startOfWeek(t)),
    month: sum(new Date(t.getFullYear(), t.getMonth(), 1)),
    year: sum(new Date(t.getFullYear(), 0, 1))
  };
}
export {
  dayStr,
  getHistory,
  heatmapCells,
  levelOf,
  recordHistoryDay,
  setHistoryStorage,
  summarize
};
