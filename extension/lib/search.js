function splitQuery(q, max = 2) {
  const parts = String(q || "").split(/\s+/).map((s) => s.trim()).filter(Boolean);
  return [...new Set(parts)].slice(0, max);
}
function mergeResults(lists) {
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const list of lists) {
    for (const it of list || []) {
      const id = String(it?.id || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(it);
    }
  }
  return out;
}
function existingOf(item, rows) {
  const id = String(item?.id || "");
  const hit = rows.find((r) => String(r.bid || "") === id);
  if (!hit) return "";
  return String(hit.state || "").startsWith("\u5DF2\u5B8C\u6210") ? "\u5DF2\u52A0\u5165\u4EFB\u52A1" : "\u5B66\u4E60\u4E2D";
}
function resolveLibTotal(opts) {
  if (opts.hasData) return Math.max(0, Number(opts.dataTotal) || 0);
  return opts.newQuery ? 0 : Math.max(0, Number(opts.prevTotal) || 0);
}
export {
  existingOf,
  mergeResults,
  resolveLibTotal,
  splitQuery
};
