# Video Tutor

B 站看课助手：暂停提问，AI 结合字幕与当前画面回答，并给出可点击的时间戳；也能按字幕生成大纲。
技术方案见 [`docs/archive/plan-v0.1.md`](docs/archive/plan-v0.1.md)（2026-11-05 的设计推演，已归档），路线图见 [`docs/roadmap.md`](docs/roadmap.md)。

## 现在能做什么

- **字幕**：有官方 / AI 字幕就直接抓；没有就语音转写（SiliconFlow SenseVoice）。15 分钟以内的视频自动转，更长的点「转写这段」手动跑。
- **大纲**：按字幕切段，每段一句说明，另给几条核心结论；完全没有字幕时可以「按画面生成」，用几张截图凑一份粗大纲。
- **问答**：暂停后点悬浮球或按 `Alt+Q`，回答带可点击的时间戳；支持同一视频内追问、以及「这页 PPT 写的什么」这类画面题。
- **成本**：每条回答带 ≈¥，面板显示今日 / 本月，设置页有预算和余额。

## 开发

```powershell
pnpm install
pnpm typecheck
pnpm build
npx playwright test
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
src/content/     页面检测、悬浮球 / 面板
src/background/  后台消息、字幕抓取、语音转写、大纲、问答
src/options/     设置页（API Key / 模型 / 预算）
src/shared/      类型、协议、提示词、解析
public/          manifest 与静态资源
e2e/             Playwright 用例（mock + 真实 Key 两套）
companion/       本地小服务（目前只服务已冻结的知识库链路）
```
