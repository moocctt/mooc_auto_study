# 测试与调试脚本

按「跑什么」分两层：

```
tests/
├── unit/   # vitest 单测（npm run test:unit / CI 只跑这一层）
└── e2e/    # 需要真实浏览器/扩展的端到端脚本
            #   e2e.mjs            控制台各页 UI 契约（连 CDP 9223）
            #   login-wall.mjs     登录墙停值守冒烟（自带 browser）
            #   store-contract.mjs 商店包契约（提交前手动跑）
            #   screenshots.mjs    商店截图生成（Windows / CDP）
            #   screenshots.sh     商店截图生成（Linux / agent-browser）
```

约定：

- **只有 `unit/` 进 CI**：`npm run test:unit`。`npm test` 等同 `test:unit`；E2E 单独跑 `npm run test:e2e`。
- E2E 前置：`npm run dev`（起 Chrome + CDP 9223）+ `npm run dev:ready`（Chrome 137+ 必须走
  `Extensions.loadUnpacked` 加载扩展）。`e2e.mjs` 会在跑批期间保持焦点模拟，避免后台标签 rAF
  挂起导致「路由没切换」的假 FAIL。
- `e2e/` 里带 `ROOT = resolve(..., '../..')` 的脚本可以独立起浏览器，**不要**和 dev-chrome.sh 的
  9223 实例混用（profile 冲突）。
- 新增正式测试放 `unit/`；一次性排查脚本放 `.tmp/`（已 gitignore），不要留在仓库里。
