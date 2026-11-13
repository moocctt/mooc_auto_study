/**
 * 构建期开关：原 ext 分支由 WXT 编译期 define 注入 __STORE__（STORE_BUILD=1 产出商店合规版）。
 * 原生版无构建工具链，无编译期 define —— 直接取常量 false（开发版行为：
 * 保留自动化入口、日志浮层、完整名称/描述）。
 * shortcut: 不再区分商店版/开发版，如需商店合规发布再手动改 false→true 并核对 manifest 权限。
 */
export const STORE = false;
