import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { join } from 'node:path';
import { mergeCuesByWindow, parseOutline, segmentRange, toSeconds } from '../src/shared/outline';
import {
  SHOT_DIR,
  VIDEO_URL,
  clearStorage,
  getExtensionId,
  hasLoginCookie,
  isOursError,
  launchWithExtension,
  writeSettings,
} from './helpers';
// @ts-expect-error 本地 mock 是 .mjs，没有类型声明
import { DEFAULT_OUTLINE_ANSWER, createMockServer } from './mock-deepseek.mjs';

let context: BrowserContext;
let extensionId: string;
let mock: ReturnType<typeof createMockServer>;
let baseUrl: string;
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
  mock = createMockServer();
  baseUrl = await mock.listen();
  await clearStorage(context, extensionId);
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
  await mock?.close();
});

async function openPanel(target: Page): Promise<void> {
  await target.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(target.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await target.locator('.vt-ball').click();
  await expect(target.locator('.vt-panel')).toBeVisible();
}

async function clearOutlineCache(): Promise<void> {
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await helper.evaluate(async () => {
    const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
    const keys = Object.keys(all).filter(key => key.startsWith('outline:'));
    if (keys.length > 0) await chrome.storage.local.remove(keys);
  });
  await helper.close();
}

async function seedOutlineCues(): Promise<void> {
  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  try {
    await helper.evaluate(async () => {
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
        title?: string;
        pages?: Array<{ page: number; cid: number; duration: number }>;
      } | null;
      const part = meta?.pages?.find(item => item.page === p) ?? meta?.pages?.[0];
      if (!meta?.aid || !part) throw new Error('缺少 aid/cid');
      const duration = Math.max(1, part.duration);
      const cues = [];
      for (let from = 0; from < duration; from += 12) {
        cues.push({
          from,
          to: Math.min(duration, from + 8),
          content: `第 ${Math.floor(from / 60)} 分 ${from % 60} 秒的课程内容`,
        });
      }
      await chrome.storage.local.set({
        [`sub:${bvid}:${p}:${part.cid}`]: {
          bvid,
          p,
          cid: part.cid,
          fetchedAt: Date.now(),
          track: { lan: 'ai-zh', lan_doc: '中文', subtitle_url: '' },
          total: cues.length,
          cues,
        },
      });
    });
  } finally {
    await helper.close();
  }
}

async function outlineSettings(): Promise<void> {
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-outline',
    apiBaseUrl: baseUrl,
    textModel: 'deepseek-flash',
    visionModel: 'deepseek-vision-e2e',
    maxTokens: 2048,
    thinking: false,
    contextWindowSec: 90,
    frameEnabled: false,
  });
}

test('segmentRange 按时长分三档', () => {
  expect(segmentRange(300)).toEqual({ min: 3, max: 6 });
  expect(segmentRange(301)).toEqual({ min: 6, max: 10 });
  expect(segmentRange(1200)).toEqual({ min: 6, max: 10 });
  expect(segmentRange(1201)).toEqual({ min: 8, max: 15 });
  // 时长未知时按长视频处理，避免把长视频切得过碎。
  expect(segmentRange(Number.NaN)).toEqual({ min: 8, max: 15 });
});

test('mergeCuesByWindow 按 15s 合并，from 取窗口第一条', () => {
  const merged = mergeCuesByWindow(
    [
      { from: 16, to: 18, content: '第三句' },
      { from: 0.5, to: 2, content: '第一句' },
      { from: 3, to: 4, content: '第二句' },
      { from: 30, to: 31, content: '   ' },
    ],
    15,
  );
  expect(merged).toEqual([
    { from: 0.5, text: '第一句 第二句' },
    { from: 16, text: '第三句' },
  ]);
});

test('parseOutline 去围栏、排序、去重叠、夹越界并补齐首尾', () => {
  const text = `\`\`\`json
  [
    { "start": 250, "end": 500, "title": "后段" },
    { "start": 0, "end": 150, "title": "开头" },
    { "start": 100, "end": 260, "title": "中段" },
    { "start": 500, "end": 520, "title": "越界" },
    { "start": 300, "end": 350, "title": "" }
  ]
  \`\`\``;
  const segments = parseOutline(text, 400, { min: 3, max: 6 });
  expect(segments).not.toBeNull();
  expect(segments?.map(segment => segment.title)).toEqual(['开头', '中段', '后段']);
  expect(segments?.map(segment => [segment.start, segment.end])).toEqual([
    [0, 150],
    [150, 260],
    [260, 400],
  ]);
});

test('parseOutline 段数不足或 JSON 坏掉时返回 null', () => {
  expect(parseOutline('不是 JSON', 400, { min: 3, max: 6 })).toBeNull();
  expect(
    parseOutline('[{"start":0,"end":100,"title":"只有一段"}]', 400, { min: 3, max: 6 }),
  ).toBeNull();
});

test('parseOutline 段数过多时合并到上限，而不是整份丢掉', () => {
  // 真实案例：42 分钟的视频被模型按字幕粒度切成 27 段 → 旧逻辑直接判坏格式。
  const many = Array.from({ length: 27 }, (_, index) => ({
    start: index * 90,
    end: index * 90 + 91,
    title: `第${index + 1}段`,
  }));
  const merged = parseOutline(JSON.stringify(many), 2431, { min: 8, max: 15 });
  expect(merged).not.toBeNull();
  expect(merged!.length).toBe(15);
  expect(merged![0].start).toBe(0);
  expect(merged![merged!.length - 1].end).toBe(2431);
  for (let index = 1; index < merged!.length; index += 1) {
    expect(merged![index].start).toBeGreaterThanOrEqual(merged![index - 1].end - 0.001);
  }
});

test('toSeconds 认整数秒，也认模型常写的 mm:ss 和 h:mm:ss', () => {
  expect(toSeconds(125)).toBe(125);
  expect(toSeconds('125')).toBe(125);
  expect(toSeconds('02:05')).toBe(125);
  expect(toSeconds('2:05')).toBe(125);
  expect(toSeconds('1:02:03')).toBe(3723);
  expect(Number.isNaN(toSeconds('abc'))).toBe(true);
  expect(Number.isNaN(toSeconds(null))).toBe(true);
  // 真实模型输出了 mm:ss 字符串，这一步曾经让整份大纲被判成坏格式。
  expect(
    parseOutline(
      '[{"start":"00:00","end":"02:05","title":"开场"},' +
        '{"start":"02:05","end":"05:10","title":"环境"},' +
        '{"start":"05:10","end":"08:00","title":"语法"}]',
      480,
      { min: 3, max: 6 },
    ),
  ).toEqual([
    { start: 0, end: 125, title: '开场' },
    { start: 125, end: 310, title: '环境' },
    { start: 310, end: 480, title: '语法' },
  ]);
});

test('点生成后出现分段，点第 2 段跳到该段起点；再次打开面板走缓存', async () => {
  await outlineSettings();
  await openPanel(page);
  await seedOutlineCues();

  mock.state.delayMs = 10;
  const before = mock.requests.length;
  await page.locator('.vt-outline-generate').click();
  await expect(page.locator('.vt-outline-state')).toHaveText('9 段', { timeout: 30_000 });
  // 两次调用：先切段，再单独一次写「每章讲了什么 + 核心结论」（D16/D18）。
  expect(mock.requests.length).toBe(before + 2);

  const items = page.locator('.vt-outline-item');
  await expect(items).toHaveCount(9);
  await expect(items.first()).toContainText('00:00');
  // 测试期诊断：写了这份大纲是靠什么生成的。
  await expect(page.locator('.vt-outline-diag')).toBeVisible();
  await expect(page.locator('.vt-outline-diag')).toContainText('模型按字幕切');

  const secondStart = Number(await items.nth(1).getAttribute('data-start'));
  const secondEnd = Number(await items.nth(1).getAttribute('data-end'));
  expect(Number.isFinite(secondStart)).toBe(true);
  await items.nth(1).click();
  await page.waitForFunction(
    ([start, end]) => {
      const video = document.querySelector('video');
      return !!video && video.currentTime >= start && video.currentTime < end;
    },
    [secondStart, secondEnd],
    { timeout: 5_000 },
  );

  await page.screenshot({ path: join(SHOT_DIR, 'd5-outline.png'), fullPage: false });

  const cachedBefore = mock.requests.length;
  await page.locator('.vt-close').click();
  await expect(page.locator('.vt-panel')).toBeHidden();
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();
  await expect(page.locator('.vt-outline-state')).toHaveText('9 段');
  await expect(page.locator('.vt-outline-item')).toHaveCount(9);
  expect(mock.requests.length).toBe(cachedBefore);
});

test('点重新生成会再请求一次，并用新结果替换旧大纲', async () => {
  await clearOutlineCache();
  await outlineSettings();
  await openPanel(page);
  await seedOutlineCues();
  mock.state.delayMs = 10;
  await page.locator('.vt-outline-generate').click();
  await expect(page.locator('.vt-outline-state')).toHaveText('9 段', { timeout: 30_000 });
  await expect(page.locator('.vt-outline-refresh')).toBeVisible();

  const before = mock.requests.length;
  mock.state.outlineAnswer = JSON.stringify(
    Array.from({ length: 9 }, (_, i) => ({
      start: i * 100,
      end: (i + 1) * 100,
      title: `新分段 ${i + 1}`,
    })),
  );
  // 重新生成直接用同一种方式再跑一次。
  await page.locator('.vt-outline-refresh').click();
  await expect(page.locator('.vt-outline-item').first()).toContainText('新分段 1', {
    timeout: 30_000,
  });
  // 同第一条：切段 + 内容说明，两次调用。
  expect(mock.requests.length).toBe(before + 2);
});

test('围栏 + 乱序 + 重叠的坏格式仍渲染成有序不重叠的分段', async () => {
  await clearOutlineCache();
  mock.state.outlineAnswer = `\`\`\`json
  [
    { "start": 490, "end": 900, "title": "总结与后续建议" },
    { "start": 0, "end": 100, "title": "课程介绍与路线" },
    { "start": 290, "end": 420, "title": "函数定义与参数" },
    { "start": 90, "end": 200, "title": "开发环境与工具" },
    { "start": 390, "end": 500, "title": "实战项目结构" },
    { "start": 190, "end": 300, "title": "Python 基础语法" },
    { "start": 1200, "end": 1300, "title": "超出视频时长" }
  ]
  \`\`\``;
  mock.state.delayMs = 10;
  await outlineSettings();
  await openPanel(page);
  await seedOutlineCues();
  await page.locator('.vt-outline-generate').click();
  await expect(page.locator('.vt-outline-state')).toHaveText('6 段', { timeout: 30_000 });

  const segments = await page.locator('.vt-outline-item').evaluateAll(nodes =>
    nodes.map(node => ({
      start: Number((node as HTMLElement).dataset.start),
      end: Number((node as HTMLElement).dataset.end),
    })),
  );
  expect(segments.length).toBe(6);
  expect(segments[0].start).toBe(0);
  for (let index = 1; index < segments.length; index += 1) {
    expect(segments[index].start).toBeGreaterThanOrEqual(segments[index - 1].end);
    expect(segments[index].start).toBeLessThan(segments[index].end);
  }
});

test('mock 500 显示错误和重试，重试成功后问答仍可用', async () => {
  await clearOutlineCache();
  mock.state.outlineAnswer = DEFAULT_OUTLINE_ANSWER;
  mock.state.delayMs = 10;
  await outlineSettings();
  await openPanel(page);
  await seedOutlineCues();
  mock.state.status = 500;
  await page.locator('.vt-outline-generate').click();
  try {
    await expect(page.locator('.vt-outline-error')).toContainText('500', { timeout: 20_000 });
    await expect(page.locator('.vt-outline-retry')).toBeVisible();
  } finally {
    mock.state.status = 200;
  }

  await page.locator('.vt-outline-retry').click();
  await expect(page.locator('.vt-outline-state')).toHaveText('9 段', { timeout: 30_000 });

  await page.locator('.vt-input').fill('这段在讲什么？');
  await page.locator('.vt-send').click();
  await expect(page.locator('.vt-a').last()).toContainText('测试全文结束', { timeout: 20_000 });
});

test('无字幕无章节：抽帧送视觉模型生成大纲，结束后恢复播放位置', async () => {
  await clearStorage(context, extensionId);
  await outlineSettings();
  await clearOutlineCache();
  mock.state.outlineAnswer = DEFAULT_OUTLINE_ANSWER;
  mock.state.delayMs = 10;
  mock.state.status = 200;

  const emptyRoute = async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: { subtitle: { subtitles: [] }, view_points: [] },
      }),
    });
  };

  await context.route('**/x/player/v2**', emptyRoute);
  try {
    await openPanel(page);

    const before = await page.evaluate(async () => {
      const video = document.querySelector('video');
      if (!video) throw new Error('没有 video');
      video.pause();
      video.currentTime = 42;
      await new Promise<void>(resolve => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          video.removeEventListener('seeked', finish);
          resolve();
        };
        video.addEventListener('seeked', finish);
        window.setTimeout(finish, 3000);
      });
      // B 站播放器会在 seek 完成后尝试续播，等它稳定再暂停一次。
      await new Promise<void>(resolve => window.setTimeout(resolve, 300));
      video.pause();
      return { time: video.currentTime, paused: video.paused };
    });
    expect(before.time).toBeGreaterThan(40);
    expect(before.paused).toBe(true);

    const beforeRequests = mock.requests.length;
    await page.locator('.vt-outline-generate').click();
    // 没有中文字幕时不再自动抓帧：先给提示和「按画面生成」按钮，由用户决定。
    // 文案里带的是后台给的真实原因（这里 mock 返回「该视频没有字幕」）。
    await expect(page.locator('.vt-outline-empty-text')).toContainText('没有字幕', {
      timeout: 15_000,
    });
    const framesButton = page.locator('.vt-outline-frames');
    await expect(framesButton).toBeVisible();
    await framesButton.click();
    await expect(page.locator('.vt-outline-state')).toHaveText(/\d+ 段/, { timeout: 60_000 });

    // 抓帧结束后回到原时间；先等 seek 完成再看。
    await page.waitForFunction(
      target => {
        const video = document.querySelector('video');
        return !!video && !video.seeking && Math.abs(video.currentTime - target) < 1;
      },
      before.time,
      { timeout: 10_000 },
    );

    type MockBody = {
      model?: string;
      messages?: Array<{ role: string; content: unknown }>;
    };
    const bodies = (mock.requests as Array<{ body: MockBody }>)
      .slice(beforeRequests)
      .map((request: { body: MockBody }) => request.body);
    const body = bodies.find((item: MockBody) => {
      const last = item.messages?.[item.messages.length - 1];
      return Array.isArray(last?.content);
    });
    expect(body, '应该发出带截图的视觉请求').toBeTruthy();
    expect(body?.model).toBe('deepseek-vision-e2e');
    const last = body?.messages?.[body.messages.length - 1];
    const parts = last?.content as Array<{
      type: string;
      text?: string;
      image_url?: { url: string; detail?: string };
    }>;
    const images = parts.filter(part => part.type === 'image_url');
    expect(images.length).toBeGreaterThanOrEqual(6);
    for (const image of images) {
      expect(image.image_url?.url.startsWith('data:image/jpeg;base64,')).toBe(true);
      expect(image.image_url?.detail).toBe('low');
    }
    expect(parts.some(part => part.type === 'text' && part.text?.includes('第 1 张'))).toBe(true);

    const frameItems = page.locator('.vt-outline-item');
    await expect(frameItems.first()).toBeVisible();
    // 标题由 mock 按截图数生成，段数应等于截图数；时间戳由帧时间算，首段必为 00:00。
    expect(await frameItems.count()).toBe(images.length);
    await expect(frameItems.first()).toContainText('00:00');
    await page.screenshot({ path: join(SHOT_DIR, 'd5-frames.png'), fullPage: false });
  } finally {
    await context.unroute('**/x/player/v2**', emptyRoute);
  }
});

test('无字幕只有 UP 章节：不直接拿章节名凑数，提示先转写', async () => {
  await clearStorage(context, extensionId);
  await outlineSettings();
  await clearOutlineCache();

  const chapterRoute = async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        code: 0,
        data: {
          subtitle: { subtitles: [] },
          view_points: [
            { from: 0, to: 40, content: '开场与自我介绍' },
            { from: 40, to: 80, content: '感知机的历史' },
            { from: 80, to: 120, content: 'M-P 神经元模型' },
          ],
        },
      }),
    });
  };

  await context.route('**/x/player/v2**', chapterRoute);
  try {
    await openPanel(page);
    const before = mock.requests.length;
    await page.locator('.vt-outline-generate').click();
    // 只有章节名、没有内容说明的大纲等于没讲，宁可先要字幕。
    await expect(page.locator('.vt-outline-empty-text')).toContainText('这个视频没有字幕', {
      timeout: 20_000,
    });
    // 章节名不再能直接变成大纲。
    await expect(page.locator('.vt-outline-chapters')).toHaveCount(0);
    await expect(page.locator('.vt-outline-item')).toHaveCount(0);
    expect(mock.requests.length).toBe(before);
  } finally {
    await context.unroute('**/x/player/v2**', chapterRoute);
  }
});

test('大纲 JSON 被 max_tokens 截断时本地补全，不额外请求模型', async () => {
  mock.reset();
  await clearStorage(context, extensionId);
  await outlineSettings();
  await clearOutlineCache();
  await openPanel(page);
  await seedOutlineCues();

  mock.state.delayMs = 10;
  // 前 8 段完整，第 9 段写到一半就被截断（长视频切段时最常见）。
  const full = JSON.parse(DEFAULT_OUTLINE_ANSWER) as Array<{
    start: number;
    end: number;
    title: string;
  }>;
  const truncated =
    JSON.stringify(full.slice(0, 8)).slice(0, -1) + ',{"start":800,"end":900,"title":"总结与后';
  mock.state.outlineQueue = [truncated];

  const before = mock.requests.length;
  await page.locator('.vt-outline-generate').click();
  // 补全后还剩 8 个完整段，够长视频的下限，直接出大纲。
  await expect(page.locator('.vt-outline-state')).toHaveText('8 段', { timeout: 30_000 });
  // 切段 + 补说明各一次；本地修复是免费的，没有多花请求。
  expect(mock.requests.length).toBe(before + 2);
});

test('切段连续两次坏 JSON 时逐级重试，第三次拿到结果', async () => {
  mock.reset();
  await clearStorage(context, extensionId);
  await outlineSettings();
  await clearOutlineCache();
  await openPanel(page);
  await seedOutlineCues();

  mock.state.delayMs = 10;
  // 缺引号，本地补 ] 救不回来；前两次都坏，第三次给好答案。
  const broken =
    '[{start_line:0,end_line:100,title:第一段}, {"start":100,"end":200,"title":"第二段"}]';
  mock.state.outlineQueue = [broken, broken, DEFAULT_OUTLINE_ANSWER];

  const before = mock.requests.length;
  await page.locator('.vt-outline-generate').click();
  await expect(page.locator('.vt-outline-state')).toHaveText('9 段', { timeout: 60_000 });

  // 切段三次：原样 → 修 JSON（2048）→ 扩预算（4096）；最后再补一次说明。
  expect(mock.requests.length).toBe(before + 4);
  const outlineBodies: Array<{ max_tokens?: number }> = mock.requests
    .slice(before)
    .map((request: { body: { max_tokens?: number } }) => request.body);
  expect(outlineBodies.map(body => body?.max_tokens).slice(1)).toEqual([2048, 4096, 4096]);
  // 第二次请求带着坏输出让模型修 JSON，而不是重新生成内容。
  expect(JSON.stringify(outlineBodies[1])).toContain('坏掉的原文');
});

test('四级重试都救不回来时报格式错误，不假装成功', async () => {
  mock.reset();
  await clearStorage(context, extensionId);
  await outlineSettings();
  await clearOutlineCache();
  await openPanel(page);
  await seedOutlineCues();

  mock.state.delayMs = 10;
  const broken = '这不是 JSON，只是一段吐槽。';
  mock.state.outlineQueue = [broken];

  const before = mock.requests.length;
  await page.locator('.vt-outline-generate').click();
  // 原样 → 修 JSON → 扩预算 → 抽稀输入，四级都失败才报错。
  await expect(page.locator('.vt-outline-error-text')).toContainText('格式不对', {
    timeout: 60_000,
  });
  expect(mock.requests.length).toBe(before + 4);
});
