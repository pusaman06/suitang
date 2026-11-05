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
 * 真实 DeepSeek 文本模型生成大纲：真实字幕 → 合并/抽稀 → 模型 → 解析 → 渲染。
 * 没有 DS_KEY 时跳过。
 */
test('真实大纲：点生成后得到覆盖全片的 6–10 段', async () => {
  test.skip(API_KEY === '', '需要环境变量 DS_KEY 才会跑真实 API');
  test.setTimeout(120_000);

  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  try {
    expect(
      await hasLoginCookie(context),
      '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）',
    ).toBe(true);
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: API_KEY,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      thinking: false,
      maxTokens: 2048,
    });

    const page = await context.newPage();
    await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    const started = Date.now();
    await page.locator('.vt-outline-generate').click();

    // 成功出分段，或失败出错误文案；两个谁先到都算「有结果」。
    await expect(
      page
        .locator('.vt-outline-item:visible')
        .first()
        .or(page.locator('.vt-outline-error:visible').first()),
    ).toBeVisible({ timeout: 90_000 });
    const elapsed = Date.now() - started;

    const errorLocator = page.locator('.vt-outline-error:visible .vt-outline-error-text');
    const errorText = (await errorLocator.count()) > 0 ? await errorLocator.innerText() : '';
    await page.screenshot({ path: join(SHOT_DIR, 'd5-real.png') });
    expect(errorText.trim(), `大纲生成失败：${errorText}`).toBe('');

    const segments = await page.locator('.vt-outline-item').evaluateAll(nodes =>
      nodes.map(node => ({
        start: Number((node as HTMLElement).dataset.start),
        end: Number((node as HTMLElement).dataset.end),
        title: (node.querySelector('.vt-outline-name')?.textContent ?? '').trim(),
      })),
    );
    const duration = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video && Number.isFinite(video.duration) ? video.duration : 0;
    });

    console.log(
      `\n[real-outline] 耗时 ${elapsed}ms，${segments.length} 段，时长 ${Math.round(duration)}s`,
    );
    for (const segment of segments) {
      console.log(`  ${segment.start}-${segment.end} ${segment.title}`);
    }

    // P1 是 891s，按时长自适应该落在 6–10 段。
    expect(segments.length).toBeGreaterThanOrEqual(6);
    expect(segments.length).toBeLessThanOrEqual(10);
    expect(segments[0].start).toBe(0);
    // 末段补到片尾：允许 30s 误差。
    expect(Math.abs(segments[segments.length - 1].end - duration)).toBeLessThanOrEqual(30);
    // 段与段首尾相接，不留空隙、不重叠。
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].start).toBeGreaterThanOrEqual(segments[index - 1].end - 0.001);
      expect(segments[index].start - segments[index - 1].end).toBeLessThanOrEqual(1);
    }
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});
