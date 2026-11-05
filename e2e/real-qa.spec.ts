import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { join } from 'node:path';
import {
  SHOT_DIR,
  VIDEO_URL,
  clearStorage,
  fetchSubtitlesFromOptions,
  getExtensionId,
  hasLoginCookie,
  launchWithExtension,
  writeSettings,
} from './helpers';

/**
 * 真实 DeepSeek 链路（手动跑，不进默认 CI）：
 *   $env:DS_KEY='sk-...'; pnpm exec playwright test e2e/real-qa.spec.ts
 * 没有 DS_KEY 时自动跳过。
 */
const KEY = process.env.DS_KEY ?? '';
const BASE = process.env.DS_BASE ?? 'https://api.deepseek.com';

test.describe.configure({ mode: 'serial' });

let context: BrowserContext;
let extensionId: string;
let page: Page;

test.beforeAll(async () => {
  test.skip(!KEY, '需要 DS_KEY 环境变量');
  context = await launchWithExtension();
  extensionId = await getExtensionId(context);
  test.skip(!(await hasLoginCookie(context)), '需要 B 站登录态');
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, {
    apiKey: KEY,
    apiBaseUrl: BASE,
    textModel: 'deepseek-flash',
    thinking: false,
    maxTokens: 768,
    contextWindowSec: 90,
  });
  page = await context.newPage();
});

test.afterAll(async () => {
  try {
    if (context && extensionId) await clearStorage(context, extensionId);
  } catch {
    // 清理失败不影响结论
  }
  await context?.close();
});

test('真实 API：流式出字、带引用、能跳转', async () => {
  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();

  const subtitles = await fetchSubtitlesFromOptions(context, extensionId);
  expect(subtitles.ok, subtitles.error).toBe(true);

  const startedAt = Date.now();
  await page.locator('.vt-input').fill('这段在讲什么？先用一句话回答，再给一个时间戳。');
  await page.locator('.vt-send').click();

  const answer = page.locator('.vt-a').last();
  await expect(answer).not.toBeEmpty({ timeout: 10_000 });
  console.log('FIRST_CHAR_MS', Date.now() - startedAt);

  await expect(page.locator('.vt-status').last()).toContainText('完成', { timeout: 90_000 });
  console.log('TOTAL_MS', Date.now() - startedAt);

  const text = await answer.innerText();
  console.log('ANSWER_TEXT_START\n' + text + '\nANSWER_TEXT_END');
  expect(text.length).toBeGreaterThan(10);

  const cite = page.locator('a.vt-cite').first();
  const count = await page.locator('a.vt-cite').count();
  console.log('CITATION_COUNT', count);
  if (count > 0) {
    const target = await cite.getAttribute('data-t');
    console.log('FIRST_CITE_SEC', target);
    const before = await page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
    await cite.click();
    await page.waitForTimeout(1_000);
    const after = await page.evaluate(() => document.querySelector('video')?.currentTime ?? -1);
    console.log('SEEK', before, '->', after);
  }

  await page.screenshot({ path: join(SHOT_DIR, 'd3-real.png') });
});
