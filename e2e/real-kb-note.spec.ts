import { expect, test } from '@playwright/test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHOT_DIR,
  clearStorage,
  getExtensionId,
  hasLoginCookie,
  launchWithExtension,
  writeSettings,
} from './helpers';

/**
 * 待办 2 的验收用例：2 分钟、无字幕、有 UP 章节的日报视频，走真实 ASR + 真实模型，
 * 再把笔记和原文底稿写进 D:\knowledge-base。
 *
 * 需要三样东西，缺一就 skip（不拖累全量测试）：
 * - .env 里的 SILICONFLOW_KEY / DS_KEY
 * - `pnpm companion` 正在 127.0.0.1:8787 跑
 * - .e2e/profile 里登录过 B 站
 */
const VIDEO = 'https://www.bilibili.com/video/BV19n4h6VENS/';
const COMPANION = 'http://127.0.0.1:8787';

async function companionReady(): Promise<boolean> {
  try {
    const response = await fetch(`${COMPANION}/api/kb/status`);
    return response.ok;
  } catch {
    return false;
  }
}

test('日报视频（无字幕）真实入库：ASR 大纲 + 存到知识库', async () => {
  test.setTimeout(600_000);
  const sfKey = process.env.SILICONFLOW_KEY ?? '';
  const dsKey = process.env.DS_KEY ?? '';
  test.skip(sfKey === '' || dsKey === '', '需要 .env 里的 SILICONFLOW_KEY 和 DS_KEY');
  test.skip(!(await companionReady()), '需要先在终端跑 pnpm companion');

  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  try {
    expect(await hasLoginCookie(context)).toBe(true);
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: dsKey,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      visionModel: 'deepseek-flash',
      thinking: false,
      frameEnabled: false,
      asrApiKey: sfKey,
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
    });

    const page = await context.newPage();
    await page.goto(VIDEO, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    // 没字幕的视频，点「生成大纲」会先自动转写，再让模型按转写切段。
    const t0 = Date.now();
    await page.locator('.vt-outline-generate').click();
    await expect(page.locator('.vt-outline-state')).toHaveText(/^\d+ 段$/, { timeout: 300_000 });
    console.log(`===OUTLINE=== ms=${Date.now() - t0}`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOT_DIR, 'd9-daily-outline.png') });

    const segments = page.locator('.vt-outline-item');
    const count = await segments.count();
    const titles = await segments.allInnerTexts();
    console.log(`===SEGMENTS=== ${count}\n${titles.join('\n')}`);

    // 待办 2 验收：3 段（UP 章节骨架）+ 每段都有说明 + 3–5 条核心结论。
    expect(count).toBe(3);
    const details = (await page.locator('.vt-outline-detail').allInnerTexts()).map(text => text.trim());
    console.log('===DETAILS===\n' + details.join('\n'));
    expect(details.length).toBe(3);
    expect(details.every(text => text !== '')).toBe(true);

    const conclusions = (await page.locator('.vt-conclusions-list li').allInnerTexts()).map(text =>
      text.trim(),
    );
    console.log('===CONCLUSIONS===\n' + conclusions.join('\n'));
    expect(conclusions.length).toBeGreaterThanOrEqual(3);
    expect(conclusions.length).toBeLessThanOrEqual(5);

    // 诊断行要说明白「这份大纲的时间戳是 ASR 估的」。
    await expect(page.locator('.vt-outline-diag')).toContainText('语音转写', { timeout: 20_000 });

    // 存到知识库：预览里应有「说明文字来自语音转写」的如实标注，且不能出现
    // 「这个视频没有字幕」这种和上面 5 条结论自相矛盾的话。
    await page.locator('.vt-kb-open').click();
    const box = page.locator('.vt-kb');
    await expect(box).toBeVisible({ timeout: 60_000 });
    const preview = await page.locator('.vt-kb-preview').inputValue();
    console.log('===KB-PREVIEW===\n' + preview.slice(0, 1200));
    expect(preview).toContain('## 核心结论');
    expect(preview).toContain('语音转写');
    expect(preview).not.toContain('这个视频没有字幕');
    await page.screenshot({ path: join(SHOT_DIR, 'd9-daily-kb-preview.png') });

    await page.locator('.vt-kb-confirm').click();
    // 第二次跑同名条目会是「已覆盖」，两种都算写成功。
    await expect(page.locator('.vt-status')).toContainText(/已存|已覆盖/, { timeout: 120_000 });
    const saved = await page.locator('.vt-status').innerText();
    console.log('===KB-SAVED=== ' + saved);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOT_DIR, 'd9-daily-kb-saved.png') });

    // 底稿要真的有字幕全文，且标明「时间戳是按字数估的」——这是待办 2 的验收点。
    const status = (await (await fetch(`${COMPANION}/api/kb/status`)).json()) as { kbDir?: string };
    const sourceDir = join(status.kbDir ?? 'D:\\knowledge-base', '50-底稿', '视频原文', 'BV19n4h6VENS');
    console.log('===SOURCE-DIR=== ' + sourceDir);
    await expect.poll(() => existsSync(sourceDir), { timeout: 20_000 }).toBe(true);
    const latest = waitLatestSource(sourceDir);
    const source = readFileSync(latest, 'utf8');
    console.log(`===SOURCE-PATH=== ${latest}\n===SOURCE-PREVIEW===\n${source.slice(0, 900)}`);
    expect(source).toContain('## 字幕');
    expect(source).toContain('时间戳由语音转写按字数估算');
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});

/** 底稿重名会带后缀，取 BV19n4h6VENS-p01 系列里最新写的那份。 */
function waitLatestSource(dir: string): string {
  const files = readdirSync(dir)
    .filter(name => name.startsWith('BV19n4h6VENS-p01') && name.endsWith('.md'))
    .map(name => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) throw new Error(`底稿目录里没有 BV19n4h6VENS-p01*.md：${dir}`);
  return join(dir, files[0].name);
}
