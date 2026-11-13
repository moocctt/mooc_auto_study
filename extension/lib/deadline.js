const DONE = (s) => {
  const v = String(s || "");
  return v.startsWith("\u5DF2\u5B8C\u6210") || v === "\u5DF2\u8FC7\u671F";
};
function dueSoon(rows, { days = 7, now = Date.now() } = {}) {
  const horizon = now + days * 864e5;
  return rows.filter((r) => r.required === "\u5FC5\u4FEE" && !DONE(r.state) && !!r.endTime && r.endTime > now && r.endTime <= horizon).sort((a, b) => a.endTime - b.endTime);
}
function daysLeftText(endTime, now = Date.now()) {
  const ms = endTime - now;
  if (ms <= 0) return "\u5DF2\u622A\u6B62";
  const h = ms / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(ms / 6e4))} \u5206\u949F`;
  if (h < 24) return `${Math.round(h)} \u5C0F\u65F6`;
  const d = h / 24;
  return d < 10 ? `${d.toFixed(1)} \u5929` : `${Math.round(d)} \u5929`;
}
export {
  daysLeftText,
  dueSoon
};
