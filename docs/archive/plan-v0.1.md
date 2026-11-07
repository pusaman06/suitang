# 视频学习助手（B 站）· 技术方案 v0.1

> 状态：D1–D5、D9、D10 已完成；D6/D7 已停、知识库链路冻结（2026-11-07 收口）。本文保留当时的设计与推演，当前范围以 README 为准。
> 日期：2026-11-05（2026-11-07 加注）
> 项目改名：2026-11-07 改为「随堂（Suitang）」，目录同步改名 `suitang`（本文已按新名更新）。
> 关联：grilling 决策见文末「决策记录」

---

## 1. 目标与非目标

### 1.1 一句话

在 B 站看课时，**暂停即可问 AI**；它读过整份字幕、能看到当前画面、回答带可点击时间戳；视频数据存在本地，之后在 DSH 里随时复习。

### 1.2 v1.0 必须做到（第一周结束）

- 打开有字幕的 B 站视频，自动抓字幕并生成大纲（「已预习」）
- 暂停后点悬浮球或按 `Alt+Q`，5 秒内给出回答
- 回答**至少引用 1 个时间戳**，点击可跳转到视频对应位置
- 同一视频内多轮追问；刷新页面后历史还在
- 无字幕视频给出明确提示，不崩

### 1.3 v1.1 追加（第二周结束）

- 本地 companion 落盘，每个视频一份 JSON + 一份 Markdown
- DSH 技能 `video-notes`：搜「上次那个 XX 视频」、读大纲/讲稿、基于原文追问
- 一键标记「没懂」的时间点，进复习清单

### 1.4 明确不做（v1）

- 华为云学堂等其它平台（v2，用适配器扩展）
- ASR / 语音转写（v2）。v1 无字幕只做「按画面回答」+ 标题兜底；可行路径已由 Bilitato 验证：playurl 取音轨 + offscreen 里 FFmpeg.wasm 切片 + 云 ASR，不需要 companion。详见 §6.5
- RAG / 向量库（v1 用「大纲 + 时间窗」检索，够用）
- Chrome 商店发布、移动端、多人协作
- 下载视频文件（只取字幕 + 暂停帧，不碰视频流）

---

## 2. 已定决策

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| 1 | 首要目的 | 工具优先，学习顺带 | 第一次做扩展，但功能确实要用 |
| 2 | 平台 | v1 只做 B 站 | 有字幕、有时间戳、页面结构稳定 |
| 3 | 输入依据 | 字幕为主 + 按需帧 | 准确性主体在字幕，画面只补「看得见但说不清」的内容 |
| 4 | 预解析 | 打开视频时后台建索引（字幕 + 大纲） | 回答有全局观，不用每次从零读 |
| 5 | 模型 | DeepSeek `deepseek-flash` + BYOK | 单图按 detail 计，上限 1024 token，一个 Key 搞定文本和视觉 |
| 6 | 预算 | 每月 10–20 元封顶 | 正常学习强度远低于此 |
| 7 | 技术栈 | 原生 TS + Vite，无 React | 代码量小，每一步看得懂 |
| 8 | 节奏 | 第一周扩展 MVP，第二周接 DSH | 先有能用的东西，再接复习 |
| 9 | DSH 复习 | 技能读本地知识库，搜索 + 总结 + 深挖 | 不需要 RAG，文件 + 关键词就够 |
| 10 | 交互 | 悬浮球 + Shadow DOM 浮层面板；侧栏可选 | 全屏可用，不挡画面 |
| 11 | 视觉预习 | 默认关；可选「按变化拼图」 | 借鉴 See Now，幻灯片课再开 |

---

## 3. 架构

```
┌──────────────────── B 站视频页 ────────────────────┐
│  <video>                                           │
│  content script                                    │
│   · 检测 bvid / cid / 标题 / 时长 / 当前时间        │
│   · 抓字幕（带登录态）                              │
│   · 悬浮球 + Shadow DOM 面板                        │
│   · 暂停 / Alt+Q / 时间戳跳转                       │
└──────────┬──────────────────────────┬──────────────┘
           │ chrome.runtime port      │ HTTP（可选）
           ▼                          ▼
┌──────────────────────┐   ┌──────────────────────────┐
│ background (MV3 SW)  │   │ companion (Node, 可选)   │
│  · DeepSeek 流式调用 │   │  · 127.0.0.1:8787        │
│  · 截图 + 裁剪       │   │  · 落盘 JSON / Markdown  │
│  · 消息路由          │   └───────────┬──────────────┘
└──────────┬───────────┘               │
           ▼                           ▼
   api.deepseek.com        D:\project\suitang\data\
                                           │
                                           ▼
                                  DSH 技能 video-notes
```

原则：

- **扩展独立可用**：companion 没开，实时问答照常，只是不同步。
- **数据格式先定死**：第一周就按最终格式存，第二周接 DSH 不返工。
- **不碰视频流**：只拿字幕和暂停帧，规避下载/版权问题。

---

## 4. 组件与职责

### 4.1 扩展（MV3）

**manifest 权限（初稿）**

```json
{
  "manifest_version": 3,
  "permissions": ["storage", "unlimitedStorage", "scripting"],
  "host_permissions": ["<all_urls>"],
  "content_scripts": [{
    "matches": ["https://www.bilibili.com/video/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "background": { "service_worker": "background.js", "type": "module" },
  "commands": {
    "ask": {
      "suggested_key": { "default": "Alt+Q" },
      "description": "暂停并提问"
    }
  }
}
```

**content script**

- 检测页面：`location.href` 里的 `BV...`；SPA 路由变化要重新初始化（监听 `pushState` / `popstate`）。
- 取元数据：内容脚本在隔离世界读不到页面的 `__INITIAL_STATE__`；background 用 `chrome.scripting.executeScript({ world: "MAIN" })` 读取 aid/bvid/cid/title/owner/duration/pages 并回传。直连 `x/web-interface/view` 带 `Origin: chrome-extension://` 会被 B 站 412，只作兜底。
- 字幕：`x/player/v2?aid=&cid=` → `subtitle.subtitles[]` → `subtitle_url` → JSON `body[{from,to,content}]`。带 `credentials: 'include'`。
- 面板：`Shadow DOM` 挂到 `<body>`，固定右侧居中；按钮 44px；面板 380×560；`z-index` 顶格；全屏时仍可见。
- 互动：点球展开/收起；`Alt+Q` 暂停并打开；点时间戳 `video.currentTime = t`。

**background service worker**

- `deepseek.ts`：`POST https://api.deepseek.com/chat/completions`，`stream: true`，解析 SSE，通过 port 把 chunk 推回页面。
- `screenshot.ts`：`chrome.tabs.captureVisibleTab` → 按视频 `getBoundingClientRect()` 裁剪 → 缩到宽 ≤798 → JPEG 0.8 → dataURL。
- `index.ts`：消息路由 + 端口保活（问答期间保持 port 打开，避免 SW 被回收）。

**面板 UI**

- 三个页签：**问答 / 大纲 / 标记**。
- 回答用 `marked` 渲染、`DOMPurify` 清洗；`[12:35]` 正则替换成可点击链接。
- 底部输入框 + 发送；顶部状态（已预习 / 预习中 / 无字幕）。

### 4.2 companion（第二周，可选）

- `node companion/server.mjs`，Node 20+，**零依赖**，只监听 `127.0.0.1:8787`。
- 接口：
  - `GET /health`
  - `GET /api/videos` 列表
  - `GET /api/videos/:bvid`
  - `PUT /api/videos/:bvid` 覆盖写入
- 落盘：`videos/<bvid>.json` + `videos/<bvid>.md`，默认目录 `D:\project\suitang\data\`，可用 `--dir` 改。
- CORS 只允许 `chrome-extension://*`；不接受局域网访问。

### 4.3 DSH 技能

- 目录：`.dsh/skills/video-notes/`（项目级）。
- `SKILL.md` 写明：何时用、数据目录、如何搜索、如何引用时间戳。
- `scripts/search.mjs "<query>"`：扫 JSON，匹配标题/UP/讲稿/问答，输出前 5 条（bvid、标题、命中时间戳、摘要）。
- 典型用法：
  - 「上次那个讲 XX 的视频讲了什么」→ 搜索 → 读 `.md` → 总结
  - 「12:30 那段再展开」→ 读该视频 segments → 回答
  - 「根据这个视频出 3 道题」→ 读大纲和讲稿 → 出题

---

## 5. 数据模型

### 5.0 多 P 修正（D1 实测）

样本 `BV1sHU9BmEne` 是 **185 P** 的合集（每 P 5–15 分钟，总长 51.6 小时）。数据必须按 **bvid + p + cid** 存，不能只按 bvid：

- `videos/<bvid>/course.json`：课程元数据 + `pages[]`（p、cid、part、duration），来自 MAIN world 的 `__INITIAL_STATE__`。
- `videos/<bvid>/p<page>.json`：该 P 的字幕、大纲、问答、标记。
- 全局大纲优先用 B 站现成的 185 个分 P 标题（免费、准确）；每个 P 内再生成 3–8 段小纲。
- DSH 技能跨 P 搜索时按 `bvid + p` 返回，并附「第 N P」与课程标题。

### 5.1 JSON

```json
{
  "schema": 1,
  "bvid": "BV1sHU9BmEne",
  "p": 2,
  "partTitle": "02. Python启航-初识Python",
  "pageCount": 185,
  "cid": 39525878466,
  "aid": 115610906266258,
  "title": "黑马程序员Python+AI零基础入门到大神全套视频课程，覆盖Python核心语法、AI应用、数据分析及Web应用等python实战项目开发全流程",
  "owner": "黑马程序员",
  "duration": 455,
  "indexedAt": "2026-11-05T08:00:00+08:00",
  "subtitle": {
    "lang": "zh-CN",
    "source": "bilibili",
    "segments": [{ "from": 12.3, "to": 15.0, "text": "……" }]
  },
  "outline": [
    { "start": 0, "end": 180, "title": "开场与问题" },
    { "start": 180, "end": 420, "title": "核心机制" }
  ],
  "qa": [
    {
      "at": 123.4,
      "q": "这里说的变化分怎么算？",
      "a": "…… [02:03] ……",
      "citations": [123.4],
      "createdAt": "2026-11-05T08:01:00+08:00"
    }
  ],
  "marks": [
    { "at": 88.0, "note": "没懂：为什么要拼图", "createdAt": "…" }
  ]
}
```

### 5.2 Markdown

```markdown
# dsh-see-now v0.1.0插件已发布

- UP：苍穹晓雷
- 时长：10:56
- 链接：https://www.bilibili.com/video/BV1QoxX6NEGk/
- 索引时间：2026-11-05 08:00

## 大纲

- [00:00] 开场与问题
- [03:00] 核心机制

## 讲稿

- [00:12] ……
- [00:15] ……

## 问答

### [02:03] 这里说的变化分怎么算？

**问**：……

**答**：…… [02:03] ……

## 标记

- [01:28] 没懂：为什么要拼图
```

---

## 6. 关键流程

### 6.1 首次打开视频（索引）

1. content script 检测到视频页 → 取 bvid/p；background 从 MAIN world 取 cid/title/owner/duration/pages。
2. `chrome.storage.local` 查缓存：同一 bvid+p+cid 已索引 → 直接显示「已预习」，跳过。
3. 拉字幕列表 → 下载字幕 JSON → 转成 segments → 存本地。
4. 异步生成大纲（文本模型，一次调用）→ 存 `outline` → 显示「预习卡」。
   - 无字幕且 UP 章节不足 2 段时，按时间抽 6–10 帧送视觉模型生成大纲（`model: frames-vision`）。
5. 若 companion 在线 → `PUT` 同步。

**失败处理**

- 字幕列表为空 / `need_login_subtitle` → 标记「无字幕」，提示「只能按画面回答」。
- 大纲调用失败 → 不阻塞问答，只显示「大纲生成失败，可重试」。

### 6.2 提问

1. 暂停（或 `Alt+Q`）→ 取 `currentTime`。
2. 组装上下文：全局大纲（压缩）+ 当前时间 ±90 秒字幕 + 最近 2 轮问答 + 可选截图。
3. 打开 port → background 调 DeepSeek 流式 → chunk 回传 → 面板逐字渲染。
4. 完成后解析引用 → 生成可点击时间戳 → 存 history + 同步。
5. 关闭 port。

### 6.3 无字幕视频

- 面板显示「无字幕 · 按画面回答」。
- 提问时强制带暂停帧；prompt 里说明「没有字幕，只能依据画面，不要编造台词」。
- 不做大纲。
- v2 走 ASR 兜底，见 §6.5。

### 6.4 复习（DSH）

- 用户：「上次那个讲 RAG 的视频说了什么？」
- DSH 技能：搜索本地 JSON → 找到 bvid → 读 Markdown → 用大纲 + 相关段落回答 → 带时间戳。
- 追问：「12:30 那段再展开」→ 读 segments 对应区间。

### 6.5 ASR 兜底（v2）

参考实现：Bilitato v1.6.4.1（`erikzhuang55/Bilitato`），纯扩展内闭环，不用 companion。

**触发判断**

- `need_login_subtitle` → 提示登录，不启动 ASR。
- 真无字幕 → 面板给「转写」按钮，用户点了才跑（不自动烧钱）。
- 拉取失败 → 重试，不降级成「无字幕」。

**音频获取**（`background.js:3638` `extractAudioSourceFromTab`）

1. `GET api.bilibili.com/x/player/playurl`，带当前 tab 的 aid/cid，`type=audio`。
2. 取 `data.dash.audio[0]`（按码率降序，第一条最高）。
3. 校验返回的 bvid 与当前页一致，不一致直接放弃——防 SPA 切 P 串线。
4. 降级链：playurl API → content 传来的 audioUrl → `executeScript` 读 `__playinfo__`。

**Referer 坑**

下载 `*.bilivideo.com` 音轨必须带 `Referer: https://www.bilibili.com/`，但 Referer 是 forbidden header，JS 设不了。用 `declarativeNetRequest` 的 `modifyHeaders` 规则改写（`rules.json`），`urlFilter: "bilivideo"`。

**切片**（`offscreen.js`）

- offscreen document 里跑 FFmpeg.wasm（`@ffmpeg/ffmpeg` + `@ffmpeg/core` esm）；manifest 需 `"offscreen"` 权限 + CSP `wasm-unsafe-eval`。
- 默认 600s/片、重叠 4s、最小 45s；按 `maxBytes × 0.72 / (字节/秒)` 估算安全时长。
- Groq 用 `-c:a copy` 直切 m4a（快）；限制严的服务转 16k mono mp3。
- 合并：丢掉 `end <= overlap` 的重复段，相邻同文本合并。

**ASR 服务**

| 服务 | 端点 | 备注 |
|---|---|---|
| Groq | `api.groq.com/openai/v1/audio/transcriptions` | whisper-large-v3-turbo，免费 2000 次/天，**国内需梯子** |
| 硅基流动 | `api.siliconflow.cn/v1/audio/transcriptions` | 国内可达 |
| 小米 MiMo | `api.xiaomimimo.com/v1/chat/completions` | `input_audio` base64，600s 分片 |

**代价**

- 扩展体积 +30MB 左右（wasm core），首次加载慢几秒。
- 1 小时视频约 6 片，串行请求 1–3 分钟；结果按 `BVID::CID` 缓存。
- 失败回退到「按画面回答」，不阻塞。

---

## 7. Prompt 设计

### 7.1 大纲（一次性）

```
你是课程笔记助手。下面是视频《{title}》的完整字幕（带时间戳）。
请输出 JSON 数组，每项 {start, end, title}，按时间顺序把视频切成 {min}–{max} 个主题段。
title 用 8–16 个汉字，概括这一段在讲什么。
硬约束：
1. 按时间顺序首尾相接覆盖全片：首段 start=0，末段 end ≥ 视频时长。
2. 时间戳只能使用字幕行开头给出的时间，不要自己估算。
3. 只输出 JSON 数组，不要 markdown 围栏，不要解释。
```

### 7.2 问答

System：

```
你是坐在用户旁边一起看课的学霸朋友：懂技术，说话自然，不端着，也不掉书袋。
用户在看 B 站课程，随时暂停问你问题。

回答方式：
- 像聊天一样直接说，不要「首先/其次/综上」这种模板腔，不要动不动列小标题。
- 默认只讲核心，两到四句话说清楚。用户没让你展开就别展开，也不要顺手把相关概念都讲一遍。
- 遇到新名词先用一句话带过，等用户追问「那 X 是什么」时再详细讲。
- 用户说「详细讲讲 / 展开 / 举个例子 / 为什么」时再放开，可以分点、可以举例。
- 视频里讲到的内容，句末标 [mm:ss]；时间戳只能取自给定字幕行开头的时间，不要估算。
- 视频没讲、但不补一句就听不懂的地方，用「补一句：」引出，一两句即可，别写小论文。
- 不编造视频里的台词、画面和时间戳。
```

> 2026-11-05 第二次调整：第一版要求「只依据字幕、找不到就说视频里没有讲到」，用户实测后反馈这更像检索器而不是学习助手——问「什么叫 Transformer」时只会说视频没讲。第二版把概念解开了，但用户又反馈「拓展太多、AI 味太重」：问「深度学习是什么」能写一篇小论文。现在定稿为角色卡 + 长度分级：默认两到四句，只有用户明确说「详细讲讲 / 展开 / 举例 / 为什么」才放开；新名词一句带过，等追问。补充内容的标签也从「补充：」改成「补一句：」，语气更接近聊天。

User：

```
视频：{title}（{duration}）
全局大纲：
{outline}
当前播放：{mm:ss}
附近字幕（{start}–{end}）：
[12:30] ……
[12:35] ……
最近对话：
Q: ……
A: ……
问题：{question}
```

有截图时追加一条 image content（base64 dataURL）。

---

## 8. 成本模型

| 项目 | 估算 | 频率 |
|---|---|---|
| 索引（1 小时课） | 字幕约 1.2 万 token 输入 + 1 千输出 | 每视频一次，缓存 |
| 单次问答 | 3–5 千输入 + 0.5–1 千输出 | 每次提问 |
| 截图 | 按 detail 计，low 约 384、单图上限 1024 | 仅画面题 |
| 视觉预习（可选） | 40–60 张拼图 × 222 token ≈ 9–13k | 每视频一次，默认关 |

- 每月 100 次问答 + 10 个视频索引 ≈ 50 万 token 量级，按 V4-Flash 单价远低于 20 元。
- 面板显示本次 token 用量；设置页可设每月软上限，超了提示。

---

## 9. 技术风险与验证顺序

| # | 风险 | 影响 | 验证 | 备选 |
|---|---|---|---|---|
| 1 | 字幕接口要登录态 / WBI 签名 / CORS；扩展 Origin 直连 API 会 412 | 无字幕则核心体验不成立 | **D2 第一件事** | 页面内（MAIN world）fetch；DOM 兜底；再不行上 ASR（v2，路径已验证：playurl 音轨 + FFmpeg.wasm 切片 + 云 ASR） |
| 2 | `captureVisibleTab` 权限与频率（2 次/秒） | 截不到帧 | D3 | `activeTab` + 快捷键触发；或请求 `<all_urls>`（仅个人用） |
| 3 | canvas 画 `<video>` 被跨域污染 | 不能直接抽帧 | D3 | 改用屏幕截图 + 裁剪（主方案） |
| 4 | MV3 SW 30 秒回收 | 长回答中断 | D3 | port 保活；失败自动重试一次 |
| 5 | B 站 DOM / SPA 路由变动 | 按钮丢失、状态错 | D4 | 用 `__INITIAL_STATE__` 而非 DOM 取数据；监听路由 |
| 6 | 长视频上下文超限 | 大纲/问答失败 | D5 | 字幕截断 6 万字；按时间窗检索，不整段送 |
| 7 | 内容脚本隔离世界读不到页面变量 | 取不到 cid/pages | D1 已解决 | background `scripting.executeScript({world:"MAIN"})` |
| 8 | `x/player/v2` 会随机返回**别的视频**的字幕地址（AI/人工都中过招） | 拉到的字幕内容与课程无关 | D2 已解决 | AI 轨道校验 URL 里的 `aid/cid` 前缀；人工轨道用「字幕末尾覆盖视频时长」兜底；校验失败重试 12 次 |

---

## 10. 两周排期（按每周 6–8 小时）

| 天 | 内容 | 产出 | 验证 |
|---|---|---|---|
| D1 ✅ | 脚手架：Vite 8 + TS 7 + MV3，加载未打包扩展 | 悬浮球 + 多 P 识别 + 设置页骨架 | 2026-11-05 用户截图验收通过 |
| D2 ✅ | **字幕 spike**：拉列表、下载、解析、缓存 | 面板显示前 10 条字幕（346 条） | 2026-11-05 e2e 通过，断言正文「零基础学AI」 |
| D3 | DeepSeek 流式 + 面板问答 + 引用跳转 | 能问第一个问题 | 回答含时间戳且可跳 |
| D4 | `Alt+Q`、暂停检测、截图裁剪 | 画面题可用 | 问「这页写的什么」 |
| D5 | 大纲生成 + 预习卡 + 缓存 | 打开即「已预习」 | 30 秒内出大纲 |
| D6 | companion + 同步 + Markdown 导出 | 文件落盘 | 目录里出现 json/md |
| D7 | DSH 技能 + 复习流程 | 在 DSH 里搜到视频 | 「上次那个…」能答 |
| D8 | 打磨：设置页、错误态、图标、README | 可交付 | 跑完验收清单 |

**里程碑**

- 第一周结束 = v1.0，扩展可独立使用。
- 第二周结束 = v1.1，接上 DSH。

### D4 截图策略

- 暂停后等画面稳定 300–500ms 再截，避免截到过渡帧、弹幕动画。
- 与上一帧做 64×36 缩略帧差，变化小于阈值就复用上次截图，省一次 vision 调用。
- 讲师画中画/摄像头 ROI 裁掉，只看正文区域。
- 变化触发选帧（自动挑关键帧）不用于 D4 实时截图，留给 v2 的整段抽取/笔记。
- 主方案仍是 `chrome.tabs.captureVisibleTab` + 裁剪；`canvas.drawImage` 只作跨域验证通过后的备选。

---

## 11. 验收清单

2026-11-05 实测（D1–D7 完成后，D8 打磨时更新）：

- [x] 打开有字幕的 B 站视频，悬浮球出现，点开面板能看到标题与分 P
- [x] 暂停 → 点球 → 提问，5 秒内出首字（真实 Key 实测 1.0 秒）
- [x] 回答至少 1 个时间戳，点击能跳转（e2e 断言 currentTime 1.95 → 6.00）
- [x] 同一视频多轮追问，上下文不丢（带最近 2 轮，内存）
- [ ] 刷新页面后历史还在（切片 2，未做）
- [x] 无字幕视频有明确提示，不崩（e2e `无字幕视频：不编造字幕，仍能回答`）
- [x] 关掉 companion，扩展仍可用（面板显示待同步 N 条，问答不受影响）
- [x] 打开 companion，文件落盘，DSH 能搜到（`course.md` 185 P；`suitang` 技能 list/show 可读）
- [x] 设置页能改 API Key / 模型 / 上下文窗口 / 回答长度 / 追问轮数 / 画面开关 / companion 地址
- [x] 连续问 10 次不触发 SW 回收（e2e 实测 10 轮全过，17.7 秒）

- [x] 成本可见：回答行显示本次费用，面板显示今日/本月，设置页显示用量与余额（e2e `cost.spec.ts`）

---

## 12. 目录结构

```
suitang/
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ vite.content.config.ts
├─ public/
│  ├─ manifest.json
│  └─ icons/
├─ src/
│  ├─ content/
│  │  ├─ index.ts          # 入口：路由、检测、注入
│  │  ├─ page.ts           # bvid/cid/标题/视频元素
│  │  ├─ subtitles.ts      # 字幕抓取与解析
│  │  ├─ ui.ts             # 悬浮球 + Shadow DOM 面板
│  │  ├─ capture.ts        # 截图请求与裁剪参数
│  │  └─ ui.css
│  ├─ background/
│  │  ├─ index.ts          # 消息路由 + 端口
│  │  ├─ deepseek.ts       # 流式调用
│  │  └─ screenshot.ts     # captureVisibleTab + crop
│  ├─ shared/
│  │  ├─ types.ts
│  │  ├─ storage.ts
│  │  ├─ prompt.ts
│  │  └─ time.ts
│  └─ options/
│     ├─ index.html
│     └─ main.ts
├─ companion/
│  └─ server.mjs
├─ dsh-skill/
│  └─ video-notes/
│     ├─ SKILL.md
│     └─ scripts/search.mjs
└─ docs/
   └─ plan.md
```

---

## 13. 决策记录

| 问题 | 回答 |
|---|---|
| Q1 目的 | 工具优先，学习顺带 |
| Q2 平台 | B 站先行；华为云学堂 v2 |
| Q3 输入 | 字幕为主 + 按需帧；预解析大纲 |
| Q4 模型/预算 | DeepSeek vision，BYOK，10–20 元/月 |
| Q5 底子/时间 | 会一点 JS，第一次做扩展；每周 5–8 小时 |
| Q6 节奏 | 扩展先跑通，数据格式先定，第二周接 DSH |
| Q7 复习能力 | 搜索 + 总结 + 深挖；出题/卡片后置 |
| Q8 本地服务 | 接受，做成可选增强 |
| Q9 视觉预习 | 默认关；可选「按变化拼图」 |
| Q10 交互 | 悬浮球为主，侧栏可选 |
| Q11 样本 | 主样本 BV1sHU9BmEne（黑马 Python，185 P，51.6 小时，需登录态字幕）；早期样本 BV1QoxX6NEGk |
| Q12 ASR | v1 不做；v2 做，纯扩展内（offscreen + FFmpeg.wasm + 云 ASR），不依赖 companion |

---

## 15. 下一步

D1–D10 已完成（2026-11-05），全部用真实 Key 验证过，`pnpm e2e` 42 passed + 8 skipped。

- D3 流式问答：首字 1.0s、`[00:06]` 可点可跳；切片 2 补了持久化（`qa:<bvid>:<p>`，刷新后还在）与全局问题 + 2 轮追问。
- D4 画面：暂停在 12s 问「这页写的什么」，2.7s 答出「ChatGPT (2022.11.30)」并带 `[00:12]`；截图时自动隐藏弹幕层。
- D5 大纲四路兜底：字幕 → UP 章节（秒出）→ ASR → 抽帧；`BV1FW9ZBhEEN` 章节 7 段 5.8s，`BV1XnxP6vEdX` 抽帧 6 段 6.5s。
- D6 落盘：零依赖 companion，落 `videos/<bvid>/course.json|md`、`p<N>.json|md`。
- D7 DSH 技能：`.dsh/skills/suitang/`，`list` / `show` / `search`。
- D9 ASR（A 路径）：硅基流动 SenseVoiceSmall，480s → 7.1s / 175 句，无时间戳、按句均分。
- D10 成本：回答行尾 `≈¥0.0014`，今日/本月账本 + 余额。

**下一步**：把产出接进个人知识库（见 `docs/decisions-notes.md` D1–D12 与「待定」一节）。未做：ASR B 路径（>1h / >45MB 切片）、图标、README、语义搜索。
