import { expect, test, type BrowserContext, type Page } from '@playwright/test';
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
  expect(mock.requests.length).toBe(before + 1);

  const items = page.locator('.vt-outline-item');
  await expect(items).toHaveCount(9);
  await expect(items.first()).toContainText('00:00');

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
