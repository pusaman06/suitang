import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { getExtensionId, launchWithExtension, SHOT_DIR } from './helpers';

test('设置页：没有落盘开关，也不自动写盘', async () => {
  const context = await launchWithExtension();
  const id = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/options/index.html`);
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(d => (d as HTMLDetailsElement).open = true);
  });

  // 落盘改成按钮触发后，这个开关已经没有意义，应该彻底消失。
  await expect(page.locator('#sync-enabled')).toHaveCount(0);
  await expect(page.locator('#companion-url')).toBeVisible();
  await expect(page.locator('details > .hint')).toContainText('看视频不会自动往硬盘写任何东西');

  await page.locator('#companion-url').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOT_DIR, 'options-sync.png'), fullPage: false });
  await context.close();
});

test('设置页：显示缓存占用，一键清空', async () => {
  const context = await launchWithExtension();
  const id = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/options/index.html`);

  // 先清空，避免上一个 spec 留下的转写 / 大纲缓存影响「已缓存几个视频」。
  await page.evaluate(() => chrome.storage.local.clear());
  // 造两条缓存：一个视频的字幕 + 页面记录。
  await page.evaluate(() => {
    return chrome.storage.local.set({
      'sub:BV1aaaaaaaaa:1:111': [{ from: 0, to: 2, text: '你好' }],
      'page:BV1aaaaaaaaa:1:nocid': { bvid: 'BV1aaaaaaaaa', p: 1, segments: [], qa: [] },
    });
  });
  await expect(page.locator('#cache-summary')).toContainText('已缓存 1 个视频', { timeout: 10_000 });
  await expect(page.locator('#cache-clear')).toBeEnabled();

  await page.locator('.cache').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOT_DIR, 'options-cache.png'), fullPage: false });

  await page.locator('#cache-clear').click();
  await expect(page.locator('#cache-status')).toContainText('已清空');
  await expect(page.locator('#cache-summary')).toHaveText('还没有缓存');

  const left = await page.evaluate(() => chrome.storage.local.get(null));
  expect(Object.keys(left).filter(key => /^(qa|sub|page|outline|asr):/.test(key))).toEqual([]);

  await page.screenshot({ path: resolve(SHOT_DIR, 'options-cache-cleared.png'), fullPage: false });
  await context.close();
});
