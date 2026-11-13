#!/usr/bin/env node
/**
 * 商店版契约自检: 校验 STORE 构建产物 (目录或 zip) 的 manifest。
 *
 * 本地: node tests/e2e/store-contract.mjs [dir|zip]
 * CI:   构建商店版后直接跑（默认 extension）
 * 提交前: scripts/submit.mjs 会对 zip 再跑一次（防止把旧包/少权限的包传上去）
 *
 * zip 走 scripts/lib/zip-manifest.mjs（纯 Node 读中央目录）, 不依赖 unzip 命令。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest } from '../../scripts/lib/zip-manifest.mjs';

const target = process.argv[2] || 'extension';
const isZip = target.endsWith('.zip');
const manifest = isZip
  ? readManifest(target)
  : JSON.parse(readFileSync(join(target, 'manifest.json'), 'utf8'));

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const manifestVersion = manifest.version;

ok(manifest.name === '烟草网络学院学习助手', `name 应为「烟草网络学院学习助手」，实际「${manifest.name}」`);
ok(manifestVersion === pkg.version, `version 应与 package.json 一致（manifest ${manifestVersion} / pkg ${pkg.version}）`);
ok(!manifest.key, '商店版不应携带 key（CWS 分配 ID）');
ok(JSON.stringify(manifest.host_permissions || null) === 'null', '安装时不应声明 host_permissions（改为 optional 授权）');
ok(JSON.stringify(manifest.optional_host_permissions) === JSON.stringify(['https://mooc.ctt.cn/*']),
  `optional_host_permissions 应只含平台域名，实际 ${JSON.stringify(manifest.optional_host_permissions)}`);
ok(JSON.stringify(manifest.permissions) === JSON.stringify(['storage', 'alarms']),
  `permissions 应仅 storage+alarms（scripting 改为 optional 运行时请求）, 实际 ${JSON.stringify(manifest.permissions)}`);
ok(manifest.optional_permissions === undefined,
  `不应声明 optional_permissions（令牌由内容脚本捕获）, 实际 ${JSON.stringify(manifest.optional_permissions)}`);
ok(Array.isArray(manifest.content_scripts) && manifest.content_scripts.some((c) => (c.matches || []).includes('https://mooc.ctt.cn/*')),
  '应声明 mooc.ctt.cn 内容脚本（无感令牌捕获）');
ok(!(manifest.content_scripts || []).some((c) => (c.matches || []).some((m) => m !== 'https://mooc.ctt.cn/*')),
  `内容脚本不应匹配平台以外域名，实际 ${JSON.stringify((manifest.content_scripts || []).map((c) => c.matches))}`);
ok(!JSON.stringify(manifest).includes('127.0.0.1'), '商店版不应出现 127.0.0.1');
ok(!JSON.stringify(manifest).includes('localhost'), '商店版不应出现 localhost');
ok(!manifest.externally_connectable, '不应声明 externally_connectable');

// 说明: /api/run 的路由代码仍会打进包里, 但 STORE 构建下该路由直接 403、入口 UI 由 __STORE__
// 在构建期剔除, 且上报节奏被强制为「真实时间 == 上报秒数」（platform.ts 构造器）——
// 因此这里只校验"可声明的能力"(manifest), 不去猜 bundle 文本（那样的断言只会误报）。

if (fails.length) {
  console.error('✗ 商店版契约自检失败:\n  - ' + fails.join('\n  - '));
  process.exit(1);
}
console.log(`✓ 商店版契约通过 (name=${manifest.name} ver=${manifestVersion} optional=${manifest.optional_host_permissions.join(',')})`);
