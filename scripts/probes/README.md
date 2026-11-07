# 手动验证脚本

这里的脚本不进 playwright 用例集：它们要真实 B 站页面 + 真实模型 Key + 真实费用，
跑一次几十秒到两分钟，用来复现「换视频 / 换分 P 之后」这类时序问题。

跑之前先 `pnpm build`（扩展加载的是 `dist/`）。

## spa-video-switch.mjs

打开 `BV19n4h6VENS` → 开面板 → 点右侧「相关推荐」里的下一个视频（SPA 内跳转，不刷新）
→ 等面板换到新视频 → 点「转写这段」→ 核对：

- 面板显示的 cid 是新视频的；
- 转写缓存 key 里的 cid 与新视频一致；
- 缓存文本是**新视频**的内容（不是上一个视频的）。

```powershell
node scripts/probes/spa-video-switch.mjs
```

通过时最后一行是 `RESULT ok`，日志同时写到 `scripts/probes/spa-video-switch.log`。

## kb-save-real.mjs

真实走一遍「存到知识库」：打开 `BV19n4h6VENS` → 生成大纲（没有字幕会先自动转写）
→ 点「存到知识库」→ 看草稿 → 写入 → 核对知识库里：

- 索引卡文件名是 `<分 P 标题>（BV19n4h6VENS-p01）.md`（不带日期）；
- 状态行是「已存入 / 已覆盖 …（约 8 秒后可搜到）」；
- 需要本机 `pnpm companion` 在跑（默认 8787）。

```powershell
node scripts/probes/kb-save-real.mjs
```

日志写到 `test-results/kb-save-real.log`，截图 `e2e/screenshots/d13-kb-real-*.png`。
