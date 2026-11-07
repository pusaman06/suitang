import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { CACHE_KEY_PREFIXES } from '../src/shared/video-record';
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

test('设置页：缓存按视频数统计，清空只删缓存、保留设置和用量', async () => {
  const context = await launchWithExtension();
  const id = await getExtensionId(context);
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/src/options/index.html`);

  // 先清空，避免上一个 spec 留下的转写 / 大纲缓存影响「已缓存几个视频」。
  await page.evaluate(() => chrome.storage.local.clear());

  const bvidA = 'BV1aaaaaaaaa';
  const bvidB = 'BV1bbbbbbbbb';
  const settings = {
    apiKey: 'sk-e2e-settings',
    // 故意用非默认地址：等于默认值时设置页会把输入框清空回显，看不出有没有保住。
    companionUrl: 'http://127.0.0.1:9999/companion',
    monthlyBudgetCny: 66,
  };
  const ledger = {
    schema: 2,
    day: '2026-11-07',
    dayCny: 0.12,
    month: '2026-11',
    monthCny: 1.34,
    totalCny: 5.67,
    updatedAt: 1_760_000_000_000,
  };
  // 两个视频、7 条缓存：统计要按视频数算（2），不能按 key 数算（7）。
  const seed = {
    settings,
    'usage:ledger': ledger,
    [`qa:${bvidA}:1`]: [{ q: '这段在讲什么？', a: '讲感知机。' }],
    [`sub:${bvidA}:1:111`]: [{ from: 0, to: 2, content: '你好' }],
    [`page:${bvidA}:1:111`]: { bvid: bvidA, p: 1, segments: [], qa: [] },
    [`outline:${bvidA}:1:111`]: { bvid: bvidA, p: 1, cid: 111, segments: [] },
    [`asr:${bvidA}:1:111`]: { bvid: bvidA, p: 1, cid: 111, segments: [] },
    [`sub:${bvidB}:1:222`]: [{ from: 0, to: 2, content: 'hello' }],
    [`outline:${bvidB}:1:222`]: { bvid: bvidB, p: 1, cid: 222, segments: [] },
  };
  const cacheKeys = Object.keys(seed).filter(key =>
    CACHE_KEY_PREFIXES.some(prefix => key.startsWith(prefix)),
  );
  expect(cacheKeys).toHaveLength(7);

  await page.evaluate(value => chrome.storage.local.set(value as Record<string, unknown>), seed);
  // 重新加载，确认页面上的设置 / 统计都是从 storage 读出来的，而不是内存里残留。
  await page.reload();

  await expect(page.locator('#cache-summary')).toContainText('已缓存 2 个视频', { timeout: 10_000 });
  // 按 key 数算会显示「7 个视频」，这里明确排除。
  expect(await page.locator('#cache-summary').innerText()).not.toContain('7 个视频');
  await expect(page.locator('#cache-clear')).toBeEnabled();

  // Key 不回填明文，只在 placeholder 里露末四位；设置值要能读回来。
  await expect(page.locator('#api-key')).toHaveValue('');
  await expect(page.locator('#api-key')).toHaveAttribute(
    'placeholder',
    new RegExp(settings.apiKey.slice(-4)),
  );
  await expect(page.locator('#companion-url')).toHaveValue(settings.companionUrl);
  await expect(page.locator('#monthly-budget')).toHaveValue(String(settings.monthlyBudgetCny));
  await expect(page.locator('#usage-month')).toHaveText('¥1.34');
  await expect(page.locator('#usage-total')).toHaveText('¥5.67');
  await expect(page.locator('#budget-label')).toContainText('预算 ¥66.00');

  await page.locator('.cache').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(SHOT_DIR, 'options-cache.png'), fullPage: false });

  await page.locator('#cache-clear').click();
  await expect(page.locator('#cache-status')).toContainText('已清空');
  await expect(page.locator('#cache-status')).toContainText(`${cacheKeys.length} 条`);
  await expect(page.locator('#cache-summary')).toHaveText('还没有缓存');

  // 清空只删缓存前缀键；设置和用量账本必须原样保留。
  const left = (await page.evaluate(() => chrome.storage.local.get(null))) as Record<string, unknown>;
  expect(
    Object.keys(left).filter(key => CACHE_KEY_PREFIXES.some(prefix => key.startsWith(prefix))),
  ).toEqual([]);
  expect(left.settings).toEqual(settings);
  expect(left['usage:ledger']).toEqual(ledger);
  // 页面上的设置值与用量显示也不能被清缓存带崩。
  await expect(page.locator('#api-key')).toHaveAttribute(
    'placeholder',
    new RegExp(settings.apiKey.slice(-4)),
  );
  await expect(page.locator('#usage-total')).toHaveText('¥5.67');

  await page.screenshot({ path: resolve(SHOT_DIR, 'options-cache-cleared.png'), fullPage: false });
  await context.close();
});
