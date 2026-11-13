const PAGE_SIZE = 12;
const LIB_BLOCK_PAGES = 20;
const LIB_BLOCK_SIZE = PAGE_SIZE * LIB_BLOCK_PAGES;
function isAutopilotTarget(r) {
  return !!r?.runnable && (r.type === "\u8BFE\u7A0B" || r.type === "\u4E13\u9898") && (r.state === "\u672A\u5F00\u59CB" || r.state === "\u5B66\u4E60\u4E2D");
}
function autopilotPending(rows, status = "all") {
  const scope = status === "\u672A\u5F00\u59CB" || status === "\u5B66\u4E60\u4E2D" ? [status] : ["\u672A\u5F00\u59CB", "\u5B66\u4E60\u4E2D"];
  return rows.filter((r) => isAutopilotTarget(r) && scope.includes(r.state));
}
function autopilotQueueOf(rows) {
  const pending = rows.filter((r) => r.runnable && (r.type === "\u8BFE\u7A0B" || r.type === "\u4E13\u9898") && !String(r.state).startsWith("\u5DF2\u5B8C\u6210") && r.state !== "\u5DF2\u8FC7\u671F");
  return [
    ...pending.filter((r) => r.required === "\u5FC5\u4FEE"),
    ...pending.filter((r) => r.required !== "\u5FC5\u4FEE")
  ];
}
const STATE_RANK = { "\u672A\u5F00\u59CB": 0, "\u5B66\u4E60\u4E2D": 1, "\u5DF2\u5B8C\u6210": 2, "\u5DF2\u8FC7\u671F": 3 };
const SEC_TYPE = {
  1: "PDF",
  2: "\u56FE\u7247",
  3: "\u94FE\u63A5",
  4: "SCORM",
  5: "\u97F3\u9891",
  6: "\u89C6\u9891",
  7: "EPUB",
  8: "\u4F5C\u4E1A",
  9: "\u8003\u8BD5",
  10: "\u5173\u8054\u8BFE\u7A0B",
  12: "\u8C03\u7814"
};
const fmtNum = (n, d = 1) => Number.isFinite(Number(n)) ? Number(n).toFixed(d) : "0";
const pad2 = (n) => String(n).padStart(2, "0");
function formatPercent(done, req) {
  const d = Number(done) || 0;
  const r = Number(req) || 0;
  if (r <= 0) return "0%";
  const raw = d / r * 100;
  const rounded = Math.round(raw * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}%`;
}
function barPercent(done, req) {
  const r = Number(req) || 0;
  if (r <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((Number(done) || 0) / r * 100)));
}
function fmtTime(ms) {
  if (!ms) return "\u2014";
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "\u2014";
  const s = Math.round(ms / 1e3);
  if (s < 60) return `${s} \u79D2`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} \u5206 ${s % 60} \u79D2`;
  return `${Math.floor(m / 60)} \u65F6 ${m % 60} \u5206`;
}
const initials = (s) => (String(s || "?").trim()[0] || "?").toUpperCase();
function undoneOf(rows) {
  return rows.filter((r) => r.runnable && r.state !== "\u5DF2\u5B8C\u6210" && r.state !== "\u5DF2\u8FC7\u671F");
}
function sortedRows(rows) {
  return [...rows].sort((a, b) => {
    const doneA = a.state === "\u5DF2\u5B8C\u6210" || a.state === "\u5DF2\u8FC7\u671F";
    const doneB = b.state === "\u5DF2\u5B8C\u6210" || b.state === "\u5DF2\u8FC7\u671F";
    return Number(doneA) - Number(doneB) || (b.push_ts || b.reg_ts || 0) - (a.push_ts || a.reg_ts || 0) || Number(a.required !== "\u5FC5\u4FEE") - Number(b.required !== "\u5FC5\u4FEE") || Number(STATE_RANK[a.state] ?? 9) - Number(STATE_RANK[b.state] ?? 9) || a.name.localeCompare(b.name);
  });
}
function continueList(rows, limit = 5) {
  const undone = undoneOf(rows);
  const required = undone.filter((r) => r.required === "\u5FC5\u4FEE");
  const pool = required.length ? required : undone;
  const rank = (r) => r.state === "\u5B66\u4E60\u4E2D" ? 0 : 1;
  const list = [...pool].sort((a, b) => rank(a) - rank(b) || (b.push_ts || b.reg_ts || 0) - (a.push_ts || a.reg_ts || 0) || a.name.localeCompare(b.name));
  const doing = pool.filter((r) => r.state === "\u5B66\u4E60\u4E2D").length;
  return {
    rows: list.slice(0, limit),
    total: pool.length,
    doing,
    waiting: pool.length - doing,
    required: required.length > 0,
    hint: required.length ? `\u5FC5\u4FEE \xB7 \u5B66\u4E60\u4E2D ${doing} \xB7 \u672A\u5F00\u59CB ${pool.length - doing}` : `\u5FC5\u4FEE\u5DF2\u5168\u90E8\u5B8C\u6210 \xB7 \u4EE5\u4E0B\u4E3A\u9009\u4FEE/\u5176\u5B83\u5F85\u5B66 ${pool.length} \u9879`
  };
}
function filterRows(rows, { status = "all", type = "all", q = "" } = {}) {
  const key = String(q).trim().toLowerCase();
  return sortedRows(rows.filter((r) => (status === "all" || r.state === status || status === "\u5DF2\u5B8C\u6210" && String(r.state).startsWith("\u5DF2\u5B8C\u6210")) && (type === "all" || r.type === type) && (!key || `${r.name} ${r.bid} ${r.type}`.toLowerCase().includes(key))));
}
function countStates(rows) {
  const out = {};
  for (const r of rows) out[r.state] = (out[r.state] || 0) + 1;
  return out;
}
function logClass(text) {
  const s = String(text);
  if (/FAIL|错误|异常/.test(s)) return "l-err";
  if (/配额|跳过|警告/.test(s)) return "l-warn";
  if (/-> OK|🎉|✅/.test(s)) return "l-ok";
  if (/^\[(TUI|学时|凭证|账号|匹配|配额|心跳|登录)\]/.test(s)) return "l-tag";
  return "";
}
export {
  LIB_BLOCK_PAGES,
  LIB_BLOCK_SIZE,
  PAGE_SIZE,
  SEC_TYPE,
  STATE_RANK,
  autopilotPending,
  autopilotQueueOf,
  barPercent,
  continueList,
  countStates,
  filterRows,
  fmtDur,
  fmtNum,
  fmtTime,
  formatPercent,
  initials,
  isAutopilotTarget,
  logClass,
  pad2,
  sortedRows,
  undoneOf
};
