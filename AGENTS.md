# 随堂（Suitang）

B 站看课助手（MV3 扩展 + 本地 companion）。说明见 [README.md](README.md)，路线图见 [docs/roadmap.md](docs/roadmap.md)。

## 命令

- `pnpm typecheck` — 类型检查，改完必跑
- `pnpm build` — 构建到 `dist/`（e2e 加载的是 `dist/`）
- `npx playwright test` — 全量 e2e，约 7 分钟；mock 用例不需要真实 Key
- `npx playwright test e2e/outline.spec.ts` — 单个 spec
- `pnpm companion` — 本地 companion（知识库链路，端口 8787）

真实 Key 在 `.env`（`DS_KEY` / `SILICONFLOW_KEY`），由 `playwright.config.ts` 自动加载；`.env` 不进库。

## 目录

- `src/background/` — service worker：字幕 / ASR / 大纲 / 问答 / 知识库写入
- `src/content/` — 面板 UI（shadow DOM）与页面抓取
- `src/shared/` — 类型、提示词、解析、缓存键
- `e2e/` — Playwright 用例；`real-*.spec.ts` 走真实 B 站与模型
- `companion/` — 本地 HTTP 服务（知识库链路用；旧落盘已停）

## 防坑

- 改 `src/` 后必须先 `pnpm build` 再跑 e2e，否则跑的是 `dist/` 里的旧代码。
- Playwright 对不可见元素点不动：用 `dispatchEvent('click')`，或在页面里 `evaluate` 直接点。
- 别用 PowerShell 写中文源码（GBK 乱码），改文件用编辑工具。
- 测试结束 Service Worker 显示 CLOSED 是正常的。
- 提交前有 `size-guard` 钩子：单文件超 20 KB 会被拒，例外写在 `.githooks/size-allowlist.txt`。
