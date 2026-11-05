import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { getExtensionId, launchWithExtension, SHOT_DIR } from './helpers';

test('设置页：本地落盘默认关闭，且说明知识库是手动写入', async () => {
  const context = await launchWithExtension();
  const id = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/options/index.html`);
  await page.evaluate(() => {
    document.querySelectorAll('details').forEach(d => (d as HTMLDetailsElement).open = true);
  });

  await expect(page.locator('#sync-enabled')).not.toBeChecked();
  await expect(page.locator('#sync-enabled').locator('xpath=..')).toContainText('默认关闭');
  await expect(page.locator('details > .hint')).toContainText('看视频本身不会自动入库');

  await page.locator('#sync-enabled').locator('xpath=ancestor::label[1]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOT_DIR, 'options-sync.png'), fullPage: false });
  await context.close();
});
