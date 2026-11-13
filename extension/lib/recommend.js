const STOP = /* @__PURE__ */ new Set([
  "专题",
  "课程",
  "示例",
  "学习",
  "网络",
  "学院",
  "管理",
  "烟草",
  "行业",
  "深入",
  "贯彻",
  "要求",
  "办法",
  "解读",
  "实务",
  "基础",
  "知识",
  "与",
  "和",
  "的",
  "月",
  "年",
  "（",
  "）",
  "《",
  "》",
  "示例专题"
]);
function keywordOf(name) {
  const raw = String(name || "");
  const clean = raw.replace(/[（(].*?[)）]/g, " ").replace(/[《》【】\s]/g, " ").split(/[，,。、:：;；]+/).join(" ");
  const tokens = clean.split(/\s+/).filter((t) => t.length >= 2 && !STOP.has(t));
  tokens.sort((a, b) => b.length - a.length);
  return (tokens[0] || raw.slice(0, 12)).slice(0, 16);
}
function filterLibrary(items, existing, limit = 4) {
  const bids = new Set(existing.map((e) => String(e.bid || "")).filter(Boolean));
  const names = new Set(existing.map((e) => String(e.name || "")));
  const seen = /* @__PURE__ */ new Set();
  const out = [];
  for (const it of items) {
    const id = String(it.id || "");
    if (!id || bids.has(id) || names.has(String(it.name || "")) || seen.has(id)) continue;
    seen.add(id);
    out.push(it);
    if (out.length >= limit) break;
  }
  return out;
}
function recentNames(rows, { limit = 3 } = {}) {
  const touched = rows.filter((r) => r.state === "\u5B66\u4E60\u4E2D" || String(r.state || "").startsWith("\u5DF2\u5B8C\u6210"));
  return touched.slice(0, limit).map((r) => String(r.name || "")).filter(Boolean);
}
export {
  filterLibrary,
  keywordOf,
  recentNames
};
