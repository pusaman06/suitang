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
 * 真实链路「问题质量」探针（手动跑，不进默认 CI）：
 *   $env:DS_KEY='sk-...'; pnpm exec playwright test e2e/real-quality.spec.ts --reporter=line
 * 用五个难度递增的问题看当前切片 1 的真实能力边界。
 */
const KEY = process.env.DS_KEY ?? '';
const BASE = process.env.DS_BASE ?? 'https://api.deepseek.com';

const QUESTIONS = [
  '课程开头 12 秒左右，画面里显示的是什么？给一个时间戳。',
  '课程里提到 DeepSeek 时是怎么说的？只依据字幕回答。',
  '整节课 891 秒，按时间顺序列出它讲了哪几个主题。',
  '那你建议初学者先学哪个主题？',
  '老师有没有讲过 Python 的装饰器？讲过就指出时间，没讲就直说没讲。',
];

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
    maxTokens: 512,
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

test('五个问题的真实回答', async () => {
  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();

  const subtitles = await fetchSubtitlesFromOptions(context, extensionId);
  expect(subtitles.ok, subtitles.error).toBe(true);
  const cues = (subtitles as unknown as { cues?: Array<{ from: number; to: number }> }).cues ?? [];
  console.log(
    'SUBTITLE_RANGE',
    cues.length,
    cues[0]?.from ?? null,
    cues[cues.length - 1]?.to ?? null,
  );

  // 停在 12 秒，模拟「看到这里暂停提问」
  await page.evaluate(() => {
    const video = document.querySelector('video');
    if (video) {
      video.pause();
      video.currentTime = 12;
    }
  });
  await page.waitForTimeout(800);

  const rows: Array<{ q: string; ms: number; status: string; answer: string }> = [];
  for (const question of QUESTIONS) {
    const startedAt = Date.now();
    await page.locator('.vt-input').fill(question);
    await page.locator('.vt-send').click();

    const answer = page.locator('.vt-a').last();
    await expect(answer).not.toBeEmpty({ timeout: 15_000 });
    await expect(page.locator('.vt-status').last()).toContainText(/完成|失败|错误/, {
      timeout: 120_000,
    });
    const status = await page.locator('.vt-status').last().innerText();
    const text = await answer.innerText();
    rows.push({ q: question, ms: Date.now() - startedAt, status, answer: text });
    await page.waitForTimeout(500);
  }

  console.log('QUALITY_RESULT_START');
  console.log(JSON.stringify(rows, null, 2));
  console.log('QUALITY_RESULT_END');

  await page.screenshot({ path: join(SHOT_DIR, 'quality-probe.png'), fullPage: false });
  expect(rows).toHaveLength(QUESTIONS.length);
});
