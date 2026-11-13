// 隐私政策单一来源同步: docs/store/privacy-policy.html → docs/privacy/index.html
// 商店提交页与公开托管页必须是同一份内容, 手改两处必然漂移。
//
// 用法: node scripts/sync-privacy.mjs [--check]
//   --check 只比对不写入, 不一致时退出码 1（CI 用）
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const src = resolve(root, "docs/store/privacy-policy.html");
const dst = resolve(root, "docs/privacy/index.html");
const check = process.argv.includes("--check");

if (!existsSync(src)) {
  console.error("✗ 缺少 docs/store/privacy-policy.html");
  process.exit(1);
}
const html = readFileSync(src, "utf8");
const cur = existsSync(dst) ? readFileSync(dst, "utf8") : "";

if (html === cur) {
  console.log("✓ 隐私政策已同步");
  process.exit(0);
}
if (check) {
  console.error("✗ docs/privacy/index.html 与商店版不一致, 运行 npm run privacy:sync");
  process.exit(1);
}
writeFileSync(dst, html);
console.log("✓ 已同步 docs/privacy/index.html");
