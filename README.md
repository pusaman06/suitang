# 随堂 Suitang

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
companion/       本地小服务：把大纲与原文底稿写进个人知识库（`pnpm companion`）
```

## 存到知识库（可选）

大纲生成后，面板底部有「存到知识库」：先预览（标题 / 摘要 / 关键词可改），再写入。
文件名是 `<分 P 标题或视频标题>（BV号-pNN）.md`，同一分 P 再存是覆盖更新；字幕全文单独落到
`50-底稿/视频原文/<BV号>/<BV号>-pNN.md`。

需要本机跑一个 companion 小服务（默认 `127.0.0.1:8787`）：

```powershell
pnpm companion
```

## 免责声明

本项目是个人学习 / 研究作品，与哔哩哔哩（B 站）官方无关。

- 只读取你已登录账号可见的字幕与播放地址，在浏览器本地缓存；**不下载、不存储、不传播视频内容**。
- 抓字幕、取播放地址等行为请遵守 [B 站用户协议](https://www.bilibili.com/blackboard/protocol.html)，使用本项目产生的风险由使用者自行承担。
- 问答与语音转写需要你自己的 API Key（DeepSeek / SiliconFlow），费用自负；Key 只保存在浏览器本地存储。
- 视频内容版权归原作者所有；生成的大纲与问答仅供个人学习使用，请勿公开发布或商用。

## 协议

[MIT](LICENSE)
