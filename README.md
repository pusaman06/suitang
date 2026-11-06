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

## 存到个人知识库

**看视频本身不会往硬盘写任何东西**——没有自动落盘、没有后台同步。只有你在面板上点「**存到知识库**」，才会写盘。

点一下会拿这期视频的标题、大纲、问答拼成一条 Markdown 笔记，先显示在面板里让你改，点「写入知识库」才真正落盘。确认时一次写两份：

| 写什么 | 落在哪 | 进不进搜索 |
|---|---|---|
| 索引卡（摘要/大纲/关键词） | `<知识库根>/20-知识笔记/<日期>-<标题>（<BV号>）.md` | 进 |
| 原文底稿（逐句字幕 + 问答） | `<知识库根>/50-底稿/视频原文/<BV号>/p1.md` | **不进**（`50-底稿` 在插件默认排除目录里） |

默认根目录 `D:\knowledge-base`（`D:\knowledge-base\_模板\视频笔记.md` 是格式说明）。写进去之后，知识库插件的 watcher 大约 8 秒会把它索引进库，之后就能用 `kb_search` 搜到。

**这一步需要本地 companion 在跑**（浏览器扩展不能直接写任意磁盘路径）：

```powershell
pnpm companion
```

看到 `kb dir:` 那行就说明起来了，窗口留着别关。companion 默认监听 `127.0.0.1:8787`，也可以在设置页改地址。知识库在别的盘就加参数：

```powershell
node companion/server.mjs --kb "E:\my-kb"
```

没开 companion 就点保存，面板会直接告诉你「连不上 companion」，不会静默失败。

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
