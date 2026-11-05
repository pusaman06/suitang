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

test('real asr end to end on BV14FHP6LEJE', async () => {
  test.setTimeout(300_000);
  const sfKey = process.env.SILICONFLOW_KEY ?? '';
  const dsKey = process.env.DS_KEY ?? '';
  test.skip(sfKey === '' || dsKey === '', '需要 SILICONFLOW_KEY 和 DS_KEY');
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
      frameEnabled: true,
      asrApiKey: sfKey,
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
    });

    const page = await context.newPage();
    await page.goto('https://www.bilibili.com/video/BV14FHP6LEJE/', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    const t0 = Date.now();
    await expect(page.locator('.vt-outline-asr')).toBeVisible({ timeout: 20_000 });
    const asrLabel = await page.locator('.vt-outline-asr').innerText();
    console.log('\n===ASR-BUTTON=== ' + asrLabel);
    await page.locator('.vt-outline-asr').click();

    // 转写完成：按钮变成「已转写」
    await expect(page.locator('.vt-outline-asr')).toHaveText('已转写', { timeout: 180_000 });
    const asrMs = Date.now() - t0;
    console.log('===ASR-DONE=== ms=' + asrMs);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(SHOT_DIR, 'd8-asr-real.png') });

    // 生成大纲
    const t1 = Date.now();
    await page.locator('.vt-outline-generate').click();
    await expect(page.locator('.vt-outline-item').first()).toBeVisible({ timeout: 120_000 });
    const outlineMs = Date.now() - t1;
    const titles = await page.locator('.vt-outline-item').allInnerTexts();
    console.log('===OUTLINE=== ms=' + outlineMs + '\n' + titles.join('\n'));

    // 问一个全局问题
    await page.locator('.vt-input').fill('这期视频主要讲了什么？');
    await page.locator('.vt-send').click();
    await expect(page.locator('.vt-status')).toContainText('完成', { timeout: 120_000 });
    const answer = await page.locator('.vt-a').last().innerText();
    console.log('===ANSWER===\n' + answer.slice(0, 800) + '\n');
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(SHOT_DIR, 'd8-asr-qa.png') });

    expect(titles.length).toBeGreaterThanOrEqual(3);
    expect(answer.length).toBeGreaterThan(20);
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});
