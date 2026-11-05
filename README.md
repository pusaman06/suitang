# Video Tutor（D1 脚手架）

B 站看课助手：暂停提问，AI 结合字幕与当前画面回答，并给出可点击的时间戳。
完整方案见 [`docs/plan.md`](docs/plan.md)。

## 当前进度

- D1：MV3 脚手架、B 站视频页注入悬浮球、识别 `bvid / 分P / cid`、`Alt+Q` 开关面板、设置页骨架。
- D2 起：字幕抓取、DeepSeek 流式问答、时间戳跳转。

## 开发

```powershell
pnpm install
pnpm typecheck
pnpm build
```

`dist/` 就是可加载的扩展目录。

### 真实用例要 API Key

`e2e/real-*.spec.ts` 打真接口。把 `.env.example` 复制成 `.env` 再填值：

```powershell
Copy-Item .env.example .env
```

`playwright.config.ts` 会自动加载 `.env`（`process.loadEnvFile`），没填 key 的用例会自动 skip 而不是报错。
`.env` 已在 `.gitignore` 里，不会进仓库。

## 在 Edge 里加载

1. 打开 `edge://extensions/`
2. 打开「开发人员模式」
3. 点「加载解压缩的扩展」，选择本项目的 `dist` 目录
4. 打开任意 B 站普通视频（`https://www.bilibili.com/video/BV...`）
5. 视频页右侧应出现「问」悬浮球；点它或按 `Alt+Q` 打开面板

> 安装时 Edge 会提示「读取所有网站数据」，这是因为截图需要 `<all_urls>` 权限；内容脚本只在 B 站视频页运行。

## 目录

```
src/content/     页面检测、悬浮球/面板
src/background/  后台消息、快捷键、工具栏图标
src/options/     设置页（API Key / 模型）
src/shared/      类型与设置
public/          manifest 与静态资源
```
