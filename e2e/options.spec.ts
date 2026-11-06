import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { getExtensionId, launchWithExtension, SHOT_DIR } from './helpers';

test('设置页：没有落盘开关，并说明只有点「存到知识库」才写盘', async () => {
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
  await expect(page.locator('details > .hint')).toContainText('50-底稿');

  await page.locator('#companion-url').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOT_DIR, 'options-sync.png'), fullPage: false });
  await context.close();
});
