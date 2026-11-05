import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  SHOT_DIR,
  VIDEO_URL,
  clearStorage,
  getExtensionId,
  hasLoginCookie,
  launchWithExtension,
  writeSettings,
} from './helpers';

const API_KEY = process.env.DS_KEY ?? '';

/**
 * 真实 DeepSeek vision 手动验证：暂停在画面有字的帧，问「这页写的什么」。
 * 没有 DS_KEY 时整个用例跳过，默认 `pnpm e2e` 不会花钱。
 */
test('真实 vision：暂停截图后模型能读出画面文字', async () => {
  test.skip(API_KEY === '', '需要环境变量 DS_KEY 才会跑真实 API');
  test.setTimeout(120_000);

  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  try {
    expect(await hasLoginCookie(context), '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）').toBe(true);
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: API_KEY,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      visionModel: 'deepseek-flash',
      frameEnabled: true,
      thinking: false,
      maxTokens: 1024,
      contextWindowSec: 90,
    });

    const page = await context.newPage();
    await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    // 12s 处画面是 ChatGPT logo + (2022.11.30)，正好考「读画面文字」。
    await page.evaluate(async () => {
      const video = document.querySelector('video');
      if (!video) return;
      video.pause();
      video.currentTime = 12;
      await new Promise<void>(resolve => {
        if (!video.seeking) {
          resolve();
          return;
        }
        video.addEventListener('seeked', () => resolve(), { once: true });
        window.setTimeout(resolve, 2000);
      });
    });

    const started = Date.now();
    await page.locator('.vt-input').fill('这页写的什么？用一句话回答，再给一个时间戳。');
    await page.locator('.vt-send').click();

    await expect(page.locator('.vt-status')).toContainText('完成', { timeout: 90_000 });
    const elapsed = Date.now() - started;
    const answer = (await page.locator('.vt-a').last().innerText()).trim();
    const status = (await page.locator('.vt-status').innerText()).trim();

    console.log(`\n[real-vision] 耗时 ${elapsed}ms`);
    console.log(`[real-vision] 状态 ${status}`);
    console.log(`[real-vision] 回答 ${answer}\n`);

    await page.screenshot({ path: join(SHOT_DIR, 'd4-real.png') });
    expect(answer.length).toBeGreaterThan(5);
    // 画面里最大的字就是 ChatGPT，读不出来说明 vision 链路有问题。
    expect(answer).toMatch(/chatgpt/i);
  } finally {
    // 别把 API Key 留在 .e2e/profile 的 storage 里。
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});
