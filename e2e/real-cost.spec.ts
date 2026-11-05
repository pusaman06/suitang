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

test('真实 Key：回答带费用，账本与余额都能读出来', async () => {
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
      monthlyBudgetCny: 10,
    });

    const page = await context.newPage();
    await page.goto('https://www.bilibili.com/video/BV1sHU9BmEne/', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();
    await page.locator('.vt-input').fill('这段在讲什么？一句话。');
    await page.locator('.vt-send').click();
    await expect(page.locator('.vt-status')).toContainText('完成', { timeout: 60_000 });
    await page.waitForTimeout(1200);

    const turn = page.locator('.vt-turn').last();
    await expect(turn).toContainText('≈¥');
    await expect(page.locator('.vt-usage')).toContainText('今日 ¥');
    await page.screenshot({ path: join(SHOT_DIR, 'd10-cost-real.png') });

    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    const ledger = (await options.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return all['usage:ledger'] ?? null;
    })) as { dayCny?: number; monthCny?: number } | null;
    expect(ledger?.dayCny ?? 0).toBeGreaterThan(0);
    expect(ledger?.monthCny ?? 0).toBeGreaterThanOrEqual(ledger?.dayCny ?? 0);

    await options.locator('#refresh-balance').click();
    await expect(options.locator('#balance-value')).not.toHaveText('未读取', { timeout: 30_000 });
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});
