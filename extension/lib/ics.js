const encoder = new TextEncoder();
const byteLen = (s) => encoder.encode(s).length;
const esc = (t) => String(t ?? "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r\n/g, "\\n").replace(/\n/g, "\\n");
const fold = (line) => {
  if (byteLen(line) <= 75) return line;
  const parts = [];
  let cur = "";
  for (const ch of line) {
    if (byteLen(cur + ch) > 74) {
      parts.push(cur);
      cur = ch;
    } else cur += ch;
  }
  parts.push(cur);
  return parts.join("\r\n ");
};
const ymd = (d) => {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
function renderIcs(tasks, today, alarmDays = 3, maskTitles = true) {
  const TASK_NAME = { 1: "\u8BFE\u7A0B", 2: "\u4E13\u9898" };
  const now = today ?? /* @__PURE__ */ new Date();
  const todayStr = ymd(now);
  const stamp = `${todayStr.replace(/-/g, "")}T000000Z`;
  let n = 0;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//tobacco-mooc-study//mooc_auto_study//CN",
    "CALSCALE:GREGORIAN"
  ];
  for (const t of tasks) {
    const bt = t.businessType ?? 0;
    if (bt !== 1 && bt !== 2) continue;
    if (t.status === 3 || t.expired) continue;
    if (!t.endTime) continue;
    const dl = ymd(new Date(t.endTime));
    if (dl < todayStr) continue;
    n += 1;
    const label = TASK_NAME[bt] ?? String(bt);
    const title = maskTitles ? `\u5FC5\u4FEE\u4EFB\u52A1 #${n}` : t.name ?? "";
    const left = Math.round(((/* @__PURE__ */ new Date(`${dl}T00:00:00`)).getTime() - now.getTime()) / 864e5);
    const summary = `\u3010\u622A\u6B62\u3011${label} \xB7 ${title}\uFF08\u8FD8\u5DEE ${left} \u5929\uFF09`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.businessId ?? n}@mooc-auto-study`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${dl.replace(/-/g, "")}`,
      fold(`SUMMARY:${esc(summary)}`)
    );
    if (alarmDays > 0) lines.push(
      "BEGIN:VALARM",
      `TRIGGER:-P${alarmDays}D`,
      "ACTION:DISPLAY",
      fold(`DESCRIPTION:${esc(summary)}`),
      "END:VALARM"
    );
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}
export {
  renderIcs
};
