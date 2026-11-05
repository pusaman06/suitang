import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeCropBox } from '../src/background/frame';
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

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: string } };

interface RequestBody {
  model?: string;
  messages?: Array<{ role: string; content: string | ContentPart[] }>;
}

const FRAME_ANSWER =
  '结论：画面中是 ChatGPT 的标志，下方写着「2022.11.30」[00:12]。\n补充：没有更多内容。\n测试全文结束。';

let context: BrowserContext;
let extensionId: string;
let loggedIn = false;
let mock: ReturnType<typeof createMockServer>;
let baseUrl: string;
let page: Page;
const ourErrors: string[] = [];

function watch(target: Page): void {
  target.on('console', message => {
    if (message.type() === 'error' && isOursError(message.text())) ourErrors.push(message.text());
  });
  target.on('pageerror', error => {
    if (isOursError(String(error))) ourErrors.push(String(error));
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  context = await launchWithExtension();
  extensionId = await getExtensionId(context);
  loggedIn = await hasLoginCookie(context);
  if (!loggedIn) return;
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

/* -------- 纯函数：裁剪盒 -------- */

test('computeCropBox：正常裁剪，并按位图与视口的比例换算', () => {
  const crop = computeCropBox(
    { x: 100, y: 100, width: 400, height: 300 },
    { width: 1440, height: 900 },
    { width: 1440, height: 900 },
  );
  expect(crop).toMatchObject({ x: 100, y: 100, width: 400, height: 300 });
  expect(crop?.outputWidth).toBe(400);
  expect(crop?.outputHeight).toBe(300);

  // 2x DPR 的截图：源矩形翻倍，输出仍按 CSS 尺寸。
  const hidpi = computeCropBox(
    { x: 100, y: 100, width: 400, height: 300 },
    { width: 1440, height: 900 },
    { width: 2880, height: 1800 },
  );
  expect(hidpi).toMatchObject({ x: 200, y: 200, width: 800, height: 600 });
  expect(hidpi?.outputWidth).toBe(800);
  expect(hidpi?.outputHeight).toBe(600);
});

test('computeCropBox：rect 超出视口时 clamp 到可见区域', () => {
  const crop = computeCropBox(
    { x: 1000, y: 600, width: 500, height: 400 },
    { width: 1440, height: 900 },
    { width: 1440, height: 900 },
  );
  expect(crop).toMatchObject({ x: 1000, y: 600, width: 440, height: 300 });

  // 左上角滚出视口。
  const topLeft = computeCropBox(
    { x: -100, y: -50, width: 300, height: 300 },
    { width: 1440, height: 900 },
    { width: 1440, height: 900 },
  );
  expect(topLeft).toMatchObject({ x: 0, y: 0, width: 200, height: 250 });
});

test('computeCropBox：可见面积不足一半返回 null', () => {
  expect(
    computeCropBox(
      { x: 1400, y: 850, width: 200, height: 200 },
      { width: 1440, height: 900 },
      { width: 1440, height: 900 },
    ),
  ).toBeNull();
});

test('computeCropBox：长边超过 1280 时等比缩小', () => {
  const crop = computeCropBox(
    { x: 0, y: 0, width: 1920, height: 1080 },
    { width: 1920, height: 1080 },
    { width: 1920, height: 1080 },
  );
  expect(crop?.outputWidth).toBe(1280);
  expect(crop?.outputHeight).toBe(720);
});

/* -------- 真实链路：带画面请求体 / 关画面纯字符串 -------- */

test('带画面提问：请求 content 是 image_url 数组且 detail=high', async () => {
  test.skip(!loggedIn, '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）');
  mock.state.answer = FRAME_ANSWER;
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-test',
    apiBaseUrl: baseUrl,
    textModel: 'deepseek-flash',
    visionModel: 'deepseek-vision-e2e',
    maxTokens: 2048,
    thinking: false,
    contextWindowSec: 90,
    frameEnabled: true,
  });

  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();

  const subtitles = await fetchSubtitlesFromOptions(context, extensionId);
  expect(subtitles.ok, subtitles.error).toBe(true);

  // 暂停到有内容的帧，并让悬浮球进入暂停高亮状态。
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
  await expect(page.locator('.vt-ball')).toHaveClass(/vt-ball-paused/);

  const before = mock.requests.length;
  await page.locator('.vt-input').fill('这页写的什么？');
  await page.locator('.vt-send').click();

  const answer = page.locator('.vt-a').last();
  await expect(answer).toContainText('测试全文结束', { timeout: 30_000 });
  await expect(page.locator('.vt-frame-hint')).toHaveText('附当前画面');

  expect(mock.requests.length).toBe(before + 1);
  const body = mock.requests[mock.requests.length - 1]?.body as RequestBody;
  expect(body.model).toBe('deepseek-vision-e2e');

  const messages = body.messages ?? [];
  const system = messages.find(item => item.role === 'system');
  expect(system?.content).toContain('用户附带了当前视频画面截图');
  const user = messages[messages.length - 1];
  expect(user?.role).toBe('user');
  expect(Array.isArray(user?.content)).toBe(true);

  const parts = user?.content as ContentPart[];
  expect(parts).toHaveLength(2);
  expect(parts[0]?.type).toBe('image_url');
  const image = (parts[0] as Extract<ContentPart, { type: 'image_url' }>).image_url;
  expect(image.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  expect(image.detail).toBe('high');
  // 空图 / 纯黑图会小得离谱，这里顺带卡一下体量。
  expect(image.url.length).toBeGreaterThan(2_000);
  // 解码后确认长边 ≤1280，且画面不是纯黑（方差太低说明截到空帧）。
  const stats = await page.evaluate(async (dataUrl: string) => {
    const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return { width: bitmap.width, height: bitmap.height, variance: 0 };
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let index = 0; index < data.length; index += 4 * 97) {
      const light = (data[index] + data[index + 1] + data[index + 2]) / 3;
      sum += light;
      sumSq += light * light;
      count += 1;
    }
    bitmap.close();
    const mean = sum / count;
    return {
      width: bitmap.width,
      height: bitmap.height,
      variance: sumSq / count - mean * mean,
    };
  }, image.url);
  expect(Math.max(stats.width, stats.height)).toBeLessThanOrEqual(1280);
  expect(stats.variance).toBeGreaterThan(100);
  expect(parts[1]?.type).toBe('text');
  expect((parts[1] as Extract<ContentPart, { type: 'text' }>).text).toContain('这页写的什么');

  // 把真正发给模型的那张图落盘，方便人工核对裁剪质量和清晰度。
  const base64 = image.url.split(',')[1] ?? '';
  writeFileSync(join(SHOT_DIR, 'd4-frame-sent.jpg'), Buffer.from(base64, 'base64'));

  await page.screenshot({ path: join(SHOT_DIR, 'd4-frame.png'), fullPage: false });
});

test('关闭画面后：请求 content 仍是纯字符串', async () => {
  test.skip(!loggedIn, '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）');
  mock.state.answer = '结论：只按字幕回答 [00:12]。\n补充：没有更多内容。\n测试全文结束。';
  await writeSettings(context, extensionId, { frameEnabled: false, apiKey: 'sk-e2e-test' });

  const before = mock.requests.length;
  await page.locator('.vt-input').fill('关闭画面后的问题');
  await page.locator('.vt-send').click();

  await expect(page.locator('.vt-a').last()).toContainText('测试全文结束', { timeout: 30_000 });
  await expect(page.locator('.vt-frame-hint')).toBeHidden();

  expect(mock.requests.length).toBe(before + 1);
  const body = mock.requests[mock.requests.length - 1]?.body as RequestBody;
  const messages = body.messages ?? [];
  const system = messages.find(item => item.role === 'system');
  expect(system?.content).not.toContain('用户附带了当前视频画面截图');
  const user = messages[messages.length - 1];
  expect(typeof user?.content).toBe('string');
  expect(user?.content).toContain('关闭画面后的问题');
});
