import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { join } from 'node:path';
import {
  SHOT_DIR,
  clearStorage,
  getExtensionId,
  hasLoginCookie,
  isOursError,
  launchWithExtension,
  writeSettings,
} from './helpers';
// @ts-expect-error 本地 mock 是 .mjs，没有类型声明
import { createMockServer } from './mock-deepseek.mjs';
// @ts-expect-error 本地 mock 是 .mjs，没有类型声明
import { createMockAsrServer } from './mock-asr.mjs';

/** 55 秒竖屏文字卡片样本：无字幕、无 UP 章节。 */
const ASR_VIDEO_URL = 'https://www.bilibili.com/video/BV1XnxP6vEdX';

let context: BrowserContext;
let extensionId: string;
let deepseek: ReturnType<typeof createMockServer>;
let deepseekUrl: string;
let asr: ReturnType<typeof createMockAsrServer>;
let asrRoot: string;
let page: Page;
const ourErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  context = await launchWithExtension();
  extensionId = await getExtensionId(context);
  if (!(await hasLoginCookie(context))) {
    test.skip(true, '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）');
    return;
  }

  deepseek = createMockServer();
  deepseekUrl = await deepseek.listen();
  asr = createMockAsrServer();
  asrRoot = await asr.listen();
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-asr',
    apiBaseUrl: deepseekUrl,
    textModel: 'deepseek-flash',
    visionModel: 'deepseek-vision-e2e',
    maxTokens: 2048,
    thinking: false,
    contextWindowSec: 90,
    frameEnabled: false,
    asrApiKey: 'sk-asr-e2e',
    asrBaseUrl: `${asrRoot}/v1`,
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
  });

  page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error' && isOursError(message.text())) ourErrors.push(message.text());
  });
  page.on('pageerror', error => {
    if (isOursError(String(error))) ourErrors.push(String(error));
  });
});

test.afterAll(async () => {
  expect(ourErrors, ourErrors.join('\n')).toEqual([]);
  await context?.close();
  await asr?.close();
  await deepseek?.close();
});

async function readVideoMeta(): Promise<{ bvid: string; aid: number; cid: number; duration: number }> {
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  try {
    return await helper.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      const tab = tabs[tabs.length - 1];
      if (!tab?.id || !tab.url) throw new Error('没有打开的视频页');
      const bvid = /\/video\/(BV[0-9A-Za-z]+)/.exec(tab.url)?.[1] ?? '';
      const p = Number(new URL(tab.url).searchParams.get('p') ?? '1') || 1;
      const meta = (await chrome.runtime.sendMessage({
        type: 'video-meta',
        bvid,
        tabId: tab.id,
      })) as {
        aid?: number;
        pages?: Array<{ page: number; cid: number; duration: number }>;
      } | null;
      const part = meta?.pages?.find(item => item.page === p) ?? meta?.pages?.[0];
      if (!meta?.aid || !part) throw new Error('缺少 aid/cid');
      return { bvid, aid: meta.aid, cid: part.cid, duration: part.duration };
    });
  } finally {
    await helper.close();
  }
}

async function readAsrCache(): Promise<{
  bvid: string;
  p: number;
  cid: number;
  segments: Array<{ start: number; end: number; text: string }>;
} | null> {
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  try {
    return await helper.evaluate(async () => {
      const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
      const key = Object.keys(all).find(item => item.startsWith('asr:'));
      return (key ? all[key] : null) as {
        bvid: string;
        p: number;
        cid: number;
        segments: Array<{ start: number; end: number; text: string }>;
      } | null;
    });
  } finally {
    await helper.close();
  }
}

test('无字幕视频：转写整段音轨、缓存时间戳，再用 ASR 字幕生成大纲', async () => {
  await page.goto(ASR_VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();

  const meta = await readVideoMeta();
  expect(meta.bvid).toBe('BV1XnxP6vEdX');
  expect(meta.duration).toBeGreaterThan(30);

  // 字幕列表与 UP 章节都置空，确保走第三/第四级兜底，而不是真实接口。
  await page.route('**/x/player/v2**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: { subtitle: { subtitles: [] }, view_points: [] },
      }),
    }),
  );
  await page.route('**/x/player/playurl**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          bvid: meta.bvid,
          aid: meta.aid,
          cid: meta.cid,
          dash: {
            audio: [{ baseUrl: `${asrRoot}/audio.m4a`, bandwidth: 128_000 }],
          },
        },
      }),
    });
  });
  // 首屏真实 __playinfo__ 会指向 B 站 CDN；这里替换成本地假音轨，避免真实下载。
  await page.evaluate(url => {
    (window as unknown as { __playinfo__?: unknown }).__playinfo__ = {
      data: { dash: { audio: [{ baseUrl: url, bandwidth: 128_000 }] } },
    };
  }, `${asrRoot}/audio.m4a`);

  await page.locator('.vt-outline-asr').click();
  await expect(page.locator('.vt-outline-empty-text')).toContainText('正在下载音轨', {
    timeout: 8_000,
  });
  await expect(page.locator('.vt-outline-empty-text')).toContainText('正在转写', {
    timeout: 12_000,
  });
  await expect(page.locator('.vt-outline-state')).toHaveText('已转写', { timeout: 20_000 });

  expect(asr.requests).toHaveLength(1);
  expect(asr.requests[0].bytes).toBeGreaterThan(1000);
  expect(asr.requests[0].contentType).toContain('multipart/form-data');

  const cached = await readAsrCache();
  expect(cached).not.toBeNull();
  expect(cached?.segments.length).toBeGreaterThanOrEqual(3);
  let previousEnd = 0;
  for (const segment of cached?.segments ?? []) {
    expect(segment.start).toBeGreaterThanOrEqual(previousEnd - 0.01);
    expect(segment.end).toBeGreaterThan(segment.start);
    expect(segment.text.trim().length).toBeGreaterThan(0);
    previousEnd = segment.end;
  }

  // 55 秒视频 4 段，避免默认 9 段被 clamp 到同一秒。
  deepseek.state.outlineAnswer = JSON.stringify([
    { start: 0, end: 14, title: '开场与目标说明' },
    { start: 14, end: 28, title: '一句话生成图片' },
    { start: 28, end: 42, title: '手机操控与语音输入' },
    { start: 42, end: 55, title: '公测信息与体验方式' },
  ]);

  await page.locator('.vt-outline-generate').click();
  await expect(page.locator('.vt-outline-item')).toHaveCount(4, { timeout: 20_000 });

  const outlineRequest = deepseek.requests[deepseek.requests.length - 1];
  const body = outlineRequest?.body as {
    messages?: Array<{ role?: string; content?: unknown }>;
  };
  const messages = body?.messages ?? [];
  const lastUser = [...messages].reverse().find(message => message.role === 'user');
  expect(typeof lastUser?.content).toBe('string');
  expect(String(lastUser?.content)).toContain('第一段转写');
  expect(JSON.stringify(body)).not.toContain('image_url');

  await page.screenshot({ path: join(SHOT_DIR, 'd8-asr.png'), fullPage: false });
});

test('转写结果信息量太低：不拿它硬切大纲，提示按画面生成', async () => {
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-asr',
    apiBaseUrl: deepseekUrl,
    textModel: 'deepseek-flash',
    visionModel: 'deepseek-vision-e2e',
    maxTokens: 2048,
    thinking: false,
    contextWindowSec: 90,
    frameEnabled: false,
    asrApiKey: 'sk-asr-e2e',
    asrBaseUrl: `${asrRoot}/v1`,
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
  });
  // 1 分 40 秒的纯画面宣传片：转写只回十几个零碎字（真实案例 BV1i24P6rEmt）。
  asr.state.texts = ['身最高分。嘟嘟。Yeah.'];

  await page.goto(ASR_VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();

  const meta = await readVideoMeta();
  await page.route('**/x/player/v2**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] }, view_points: [] } }),
    }),
  );
  await page.route('**/x/player/playurl**', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          bvid: meta.bvid,
          aid: meta.aid,
          cid: meta.cid,
          dash: { audio: [{ baseUrl: `${asrRoot}/audio.m4a`, bandwidth: 128_000 }] },
        },
      }),
    });
  });
  await page.evaluate(url => {
    (window as unknown as { __playinfo__?: unknown }).__playinfo__ = {
      data: { dash: { audio: [{ baseUrl: url, bandwidth: 128_000 }] } },
    };
  }, `${asrRoot}/audio.m4a`);

  await page.locator('.vt-outline-asr').click();
  await expect(page.locator('.vt-outline-empty-text')).toContainText('几乎没有口播', {
    timeout: 30_000,
  });
  await expect(page.locator('.vt-outline-empty-text')).toContainText('按画面生成');
  await expect(page.locator('.vt-outline-item')).toHaveCount(0);
  await expect(page.locator('.vt-outline-frames')).toBeVisible();

  // 再点「生成大纲」：命中 ASR 缓存后同样不拿噪声文本切段，也不该再花一次模型调用。
  const before = deepseek.requests.length;
  await page.locator('.vt-outline-generate').click();
  await expect(page.locator('.vt-outline-empty-text')).toContainText('几乎没有口播', {
    timeout: 20_000,
  });
  expect(deepseek.requests.length).toBe(before);
  await page.screenshot({ path: join(SHOT_DIR, 'd11-sparse-speech.png'), fullPage: false });
});
