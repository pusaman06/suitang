import { expect, test } from '@playwright/test';
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
 * 真实抽帧大纲：BV1XnxP6vEdX 是 55 秒的文字卡片视频，没有字幕也没有 UP 章节，
 * 只能靠抽帧 + 视觉模型。没有 DS_KEY 时跳过（CI 里不会跑）。
 */
test('真实抽帧：无字幕无章节时用画面生成大纲', async () => {
  test.setTimeout(240_000);
  const key = process.env.DS_KEY ?? '';
  test.skip(key === '', '需要 DS_KEY');
  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  try {
    expect(await hasLoginCookie(context)).toBe(true);
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: key,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      visionModel: 'deepseek-flash',
      thinking: false,
      frameEnabled: true,
    });

    const page = await context.newPage();
    await page.goto('https://www.bilibili.com/video/BV1XnxP6vEdX/', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    const started = Date.now();
    await page.locator('.vt-outline-generate').click();
    await expect(page.locator('.vt-outline-item').first()).toBeVisible({ timeout: 120_000 });
    const elapsed = Date.now() - started;
    const titles = await page.locator('.vt-outline-item').allInnerTexts();
    console.log(
      '\n===FRAMES-OUTLINE===\n' + titles.join('\n') + `\n(耗时 ${elapsed}ms)\n===END===\n`,
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOT_DIR, 'd5-frames-real.png') });

    // 55 秒的视频抽 6 帧，合并后至少能分出 3 段。
    expect(titles.length).toBeGreaterThanOrEqual(3);
    // 第一帧就是开场标题卡，模型应该能读出 DSH 相关的字。
    expect(titles.join(' ')).toMatch(/DSH|Go|公测/i);
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});
