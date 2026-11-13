// 版本一致性工具 —— package.json / extension/manifest.json / docs/store/listing.md / docs/store/changelog.md 多处单一来源对齐。
//
// 用法:
//   node scripts/sync-version.mjs --check        # 只校验（CI 用），不一致 exit 1
//   node scripts/sync-version.mjs <2.12.0>       # 把 package.json + listing 版本号统一改过去
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const pkgPath = resolve(root, "package.json");
const listingPath = resolve(root, "docs/store/listing.md");
const changelogPath = resolve(root, "docs/store/changelog.md");

const read = (p) => readFileSync(p, "utf8");
const pkgVersion = () => JSON.parse(read(pkgPath)).version;
const manifestPath = resolve(root, "extension/manifest.json");
const manifestVersion = () => JSON.parse(read(manifestPath)).version;

// listing 的「### 版本号」代码块里的那行（容忍 CRLF 行尾）
const listingRe = () => /(### 版本号\r?\n```\r?\n)(\d+\.\d+\.\d+)(-\S+)?(\r?\n```)/;

function problemsFor(version) {
  const problems = [];
  const listing = read(listingPath);
  const m = listing.match(listingRe());
  if (!m) problems.push("listing.md 找不到「### 版本号」代码块");
  else if (m[2] !== version) problems.push(`listing.md 版本号 ${m[2]} ≠ package.json ${version}`);
  const mv = manifestVersion();
  if (mv !== version) problems.push(`extension/manifest.json 版本号 ${mv} ≠ package.json ${version}`);
  const cl = read(changelogPath);
  if (!new RegExp(`^## ${version.replace(/\./g, "\\.")}$`, "m").test(cl)) {
    problems.push(`changelog.md 缺少 ## ${version} 章节`);
  }
  return problems;
}

if (process.argv[2] === "--check") {
  const problems = problemsFor(pkgVersion());
  if (problems.length) {
    console.error(`✗ 版本不一致:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  console.log(`✓ 版本一致: ${pkgVersion()} (package.json / listing / changelog)`);
  process.exit(0);
}

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(-\S+)?$/.test(version ?? "")) {
  console.error("用法: node scripts/sync-version.mjs <2.12.0> | --check");
  process.exit(1);
}
const pkg = JSON.parse(read(pkgPath));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
const listing = read(listingPath);
if (!listingRe().test(listing)) {
  console.error("✗ listing.md 找不到「### 版本号」代码块, 未改 listing");
  process.exit(1);
}
writeFileSync(listingPath, listing.replace(listingRe(), `$1${version}$4`));
const problems = problemsFor(version).filter((p) => !p.startsWith("changelog"));
if (problems.length) {
  console.error(`✗ 同步后仍有问题:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}
console.log(`✓ package.json + listing.md → ${version}（changelog 章节由 release.mjs 生成）`);
