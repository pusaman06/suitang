import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { join } from 'node:path';
import { estimateCostUsd, formatCny, isPeakHour } from '../src/shared/cost';
import type { QaUsage } from '../src/shared/qa';
import {
  SHOT_DIR,
  VIDEO_URL,
  clearStorage,
  fetchSubtitlesFromOptions,
  getExtensionId,
  hasLoginCookie,
  isOursError,
  launchWithExtension,
  writeSettings,
} from './helpers';
// @ts-expect-error 本地 mock 是 .mjs，没有类型声明
import { createMockServer } from './mock-deepseek.mjs';

let context: BrowserContext;
let extensionId: string;
let mock: ReturnType<typeof createMockServer>;
let baseUrl: string;
let page: Page;
const ourErrors: string[] = [];

function watch(page: Page): void {
  page.on('console', message => {
    if (message.type() === 'error' && isOursError(message.text())) ourErrors.push(message.text());
  });
  page.on('pageerror', error => {
    if (isOursError(String(error))) ourErrors.push(String(error));
  });
}

function usage(patch: Partial<QaUsage> = {}): QaUsage {
  return {
    promptTokens: 1000,
    completionTokens: 100,
    totalTokens: 1100,
    cacheHitTokens: 200,
    cacheMissTokens: 800,
    reasoningTokens: 0,
    ...patch,
  };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  context = await launchWithExtension();
  extensionId = await getExtensionId(context);
  if (!(await hasLoginCookie(context))) {
    test.skip(true, '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）');
    return;
  }
  mock = createMockServer();
  baseUrl = await mock.listen();
  await clearStorage(context, extensionId);
  page = await context.newPage();
  watch(page);
});

test.afterAll(async () => {
  expect(ourErrors, ourErrors.join('\n')).toEqual([]);
  await context?.close();
  await mock?.close();
});

test('费用纯函数：时段边界、手算样例、小数格式', () => {
  // 2026-01-05 是周一。
  expect(isPeakHour(Date.UTC(2026, 0, 5, 1, 0))).toBe(true);
  expect(isPeakHour(Date.UTC(2026, 0, 5, 0, 59))).toBe(false);
  expect(isPeakHour(Date.UTC(2026, 0, 5, 4, 0))).toBe(false);
  expect(isPeakHour(Date.UTC(2026, 0, 5, 6, 0))).toBe(true);
  expect(isPeakHour(Date.UTC(2026, 0, 3, 2, 0))).toBe(false); // 周六
  expect(isPeakHour(Date.UTC(2026, 0, 5, 10, 0))).toBe(false);

  // peak：200 * 0.006 + 800 * 0.30 + 100 * 1.20，再除以 1M。
  const cost = estimateCostUsd(usage(), Date.UTC(2026, 0, 5, 2, 0));
  expect(cost).toBeCloseTo(361.2 / 1_000_000, 12);

  // 代理缺 cache miss 字段时，把 promptTokens 减 hit 全按 miss 算。
  const fallback = estimateCostUsd(
    usage({ cacheMissTokens: 0 }),
    Date.UTC(2026, 0, 5, 2, 0),
  );
  expect(fallback).toBeCloseTo(cost, 12);

  expect(formatCny(0)).toBe('¥0.00');
  expect(formatCny(0.0001)).toBe('¥0.0007');
  expect(formatCny(0.01)).toBe('¥0.07');
  expect(formatCny(1)).toBe('¥7.20');
});

test('回答行显示费用，面板和设置页显示用量', async () => {
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-cost',
    apiBaseUrl: baseUrl,
    textModel: 'deepseek-flash',
    maxTokens: 2048,
    thinking: false,
    contextWindowSec: 90,
    frameEnabled: false,
    monthlyBudgetCny: 10,
  });

  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();

  const subtitles = await fetchSubtitlesFromOptions(context, extensionId);
  expect(subtitles.ok, subtitles.error).toBe(true);

  // 截图要露出回答下面的费用行，答案短一点，别撑出面板。
  mock.state.answer = '结论：这段在讲变量赋值 [00:12]。\n测试全文结束。';

  await page.locator('.vt-input').fill('这段在讲什么？');
  await page.locator('.vt-send').click();
  await expect(page.locator('.vt-a').first()).toContainText('测试全文结束', {
    timeout: 20_000,
  });

  const meta = page.locator('.vt-turn-meta').first();
  await expect(meta).toContainText('tokens');
  await expect(meta).toContainText('≈¥');
  await expect(page.locator('.vt-usage')).toContainText('今日', { timeout: 5_000 });

  await page.locator('.vt-usage').click();
  await expect(page.locator('.vt-usage')).toContainText('今日', { timeout: 5_000 });

  await page.locator('.vt-answers').evaluate(element => {
    element.scrollTop = element.scrollHeight;
  });
  await page.screenshot({ path: join(SHOT_DIR, 'd10-cost.png'), fullPage: false });

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await expect(options.locator('#usage-month')).not.toHaveText('¥0.00', { timeout: 5_000 });
  await expect(options.locator('#usage-total')).not.toHaveText('¥0.00');
  await expect(options.locator('#budget-label')).toContainText('预算 ¥10.00');
  const width = await options
    .locator('#budget-fill')
    .evaluate(element => (element as HTMLElement).style.width);
  expect(width).not.toBe('0%');
  await options.close();
});
