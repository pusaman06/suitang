import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';
import { join } from 'node:path';
import {
  NO_SUBTITLE_VIDEO_URL,
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
import { DEFAULT_ANSWER, createMockServer } from './mock-deepseek.mjs';

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

async function openPanel(target: Page, url: string): Promise<void> {
  await target.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(target.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await target.locator('.vt-ball').click();
  await expect(target.locator('.vt-panel')).toBeVisible();
}

test('请求体符合协议，回答含可点击 [mm:ss] 且能跳转', async () => {
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-test',
    apiBaseUrl: baseUrl,
    textModel: 'deepseek-flash',
    maxTokens: 2048,
    thinking: false,
    contextWindowSec: 90,
    // D3 的文本链路测试：显式关掉 D4 画面，保证 content 还是纯字符串。
    frameEnabled: false,
  });

  await openPanel(page, VIDEO_URL);
  // 先走设置页诊断同一条链路把字幕灌进缓存，问答才有「附近字幕」可发。
  const subtitles = await fetchSubtitlesFromOptions(context, extensionId);
  expect(subtitles.ok, subtitles.error).toBe(true);

  const before = mock.requests.length;
  await page.locator('.vt-input').fill('这段在讲什么？');
  const startedAt = Date.now();
  await page.locator('.vt-send').click();

  const answer = page.locator('.vt-a').first();
  await expect(answer).not.toBeEmpty({ timeout: 5_000 });
  expect(Date.now() - startedAt).toBeLessThan(5_000);

  await expect(answer).toContainText('测试全文结束', { timeout: 20_000 });
  await expect(page.locator('.vt-turn-meta').first()).toContainText('tokens');

  const rendered = (await answer.innerText()).replace(/\s+/g, '');
  expect(rendered).toBe(DEFAULT_ANSWER.replace(/\s+/g, ''));

  expect(mock.requests.length).toBe(before + 1);
  const body = mock.requests[mock.requests.length - 1]?.body as {
    model?: string;
    stream?: boolean;
    stream_options?: { include_usage?: boolean };
    thinking?: { type?: string };
    max_tokens?: number;
    temperature?: number;
    messages?: Array<{ role: string; content: string }>;
  };
  expect(body.model).toBe('deepseek-flash');
  expect(body.stream).toBe(true);
  expect(body.stream_options).toEqual({ include_usage: true });
  expect(body.thinking).toEqual({ type: 'disabled' });
  expect(body.max_tokens).toBe(2048);
  expect(body.temperature).toBeCloseTo(0.3, 5);

  const messages = body.messages ?? [];
  const system = messages.find(item => item.role === 'system');
  expect(system?.content).toContain('一起看课的学霸朋友');
  const user = messages[messages.length - 1];
  expect(user?.role).toBe('user');
  expect(user?.content).toContain('附近字幕（');
  expect(user?.content).toContain('这段在讲什么？');

  const cite = page.locator('a.vt-cite').first();
  await expect(cite).toHaveAttribute('data-t', '12');
  await expect(cite).toHaveText('[00:12]');
  await cite.click();
  await page.waitForFunction(
    () => {
      const video = document.querySelector('video');
      return !!video && video.currentTime >= 11 && video.currentTime <= 13;
    },
    null,
    { timeout: 5_000 },
  );

  await page.screenshot({ path: join(SHOT_DIR, 'd3-qa.png'), fullPage: false });
});

test('刷新后历史还在，清空后消失', async () => {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();

  const history = page.locator('.vt-turn-history');
  await expect(history).toHaveCount(1, { timeout: 5_000 });
  await expect(history.first()).toContainText('这段在讲什么？');
  await expect(history.first().locator('a.vt-cite')).toHaveCount(1);
  await expect(page.locator('.vt-clear')).toBeVisible();
  await page.screenshot({ path: join(SHOT_DIR, 'd3-history.png'), fullPage: false });

  // 第一次点变成确认态，第二次才真的清。
  await page.locator('.vt-clear').click();
  await expect(page.locator('.vt-clear')).toHaveText('再点一次确认');
  await page.locator('.vt-clear').click();
  await expect(page.locator('.vt-turn-history')).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('.vt-clear')).toBeHidden();
});

test('面板右上角的齿轮能打开设置页', async () => {
  await openPanel(page, VIDEO_URL);
  await expect(page.locator('.vt-gear')).toBeVisible();

  await page.locator('.vt-gear').click();
  await expect
    .poll(() => context.pages().some(target => target.url().includes('src/options/index.html')), {
      timeout: 5_000,
    })
    .toBe(true);

  for (const target of context.pages()) {
    if (target.url().includes('src/options/index.html')) await target.close();
  }
  await page.bringToFront();
});

test('没有 API Key 时不发请求，面板给出提示', async () => {
  await writeSettings(context, extensionId, { apiKey: '', apiBaseUrl: baseUrl });
  const before = mock.requests.length;

  await page.locator('.vt-input').fill('没有 key 的问题');
  await page.locator('.vt-send').click();

  const errorBox = page.locator('.vt-error').last();
  await expect(errorBox).toContainText('API Key', { timeout: 10_000 });
  expect(mock.requests.length).toBe(before);
});

test('401 显示鉴权失败文案', async () => {
  await writeSettings(context, extensionId, { apiKey: 'sk-bad', apiBaseUrl: baseUrl });
  mock.state.status = 401;
  try {
    await page.locator('.vt-input').fill('401 的问题');
    await page.locator('.vt-send').click();
    await expect(page.locator('.vt-error').last()).toContainText('401', { timeout: 15_000 });
  } finally {
    mock.state.status = 200;
  }
});

test('无字幕视频：不编造字幕，仍能回答', async () => {
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-test',
    apiBaseUrl: baseUrl,
    frameEnabled: false,
  });

  // 该样本有登录态时其实带字幕；把 player/v2 返回的字幕列表清空，稳定复现「无字幕」。
  const stripSubtitles = async (route: Route) => {
    const response = await route.fetch();
    const json = (await response.json()) as { data?: { subtitle?: { subtitles?: unknown[] } } };
    if (json.data?.subtitle) json.data.subtitle.subtitles = [];
    await route.fulfill({ response, json });
  };
  await context.route('**/x/player/v2**', stripSubtitles);

  const bare = await context.newPage();
  watch(bare);
  try {
    await openPanel(bare, NO_SUBTITLE_VIDEO_URL);

    await bare.locator('.vt-input').fill('这个视频讲什么？');
    await bare.locator('.vt-send').click();
    await expect(bare.locator('.vt-status')).toContainText('无字幕 · 只能按标题回答', {
      timeout: 20_000,
    });

    const answer = bare.locator('.vt-a').first();
    await expect(answer).toContainText('测试全文结束', { timeout: 20_000 });

    const body = mock.requests[mock.requests.length - 1]?.body as {
      messages?: Array<{ role: string; content: string }>;
    };
    const messages = body.messages ?? [];
    const system = messages.find(item => item.role === 'system');
    const user = messages[messages.length - 1];
    expect(system?.content).toContain('不要编造');
    expect(user?.content).not.toContain('附近字幕');
    expect(user?.content).toContain('这个视频讲什么？');
  } finally {
    await context.unroute('**/x/player/v2**', stripSubtitles);
    await bare.close();
  }
});

test('全局问题：给全片抽稀字幕，而不是附近窗口', async () => {
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-test',
    apiBaseUrl: baseUrl,
    frameEnabled: false,
    contextWindowSec: 90,
  });

  await openPanel(page, VIDEO_URL);
  const subtitles = await fetchSubtitlesFromOptions(context, extensionId);
  expect(subtitles.ok, subtitles.error).toBe(true);

  const before = mock.requests.length;
  await page.locator('.vt-input').fill('整节课一共讲了哪几个主题？');
  await page.locator('.vt-send').click();
  await expect(page.locator('.vt-a').last()).not.toBeEmpty({ timeout: 5_000 });
  await expect(page.locator('.vt-status').last()).toContainText('完成', { timeout: 20_000 });

  expect(mock.requests.length).toBe(before + 1);
  const body = mock.requests[mock.requests.length - 1]?.body as {
    messages?: Array<{ role: string; content: string }>;
  };
  const messages = body.messages ?? [];
  const system = messages.find(item => item.role === 'system');
  const user = messages[messages.length - 1];
  expect(system?.content).toContain('整体问题');
  expect(user?.content).toContain('全片字幕（抽稀');
  expect(user?.content).not.toContain('附近字幕（');
  expect(user?.content).toContain('整节课一共讲了哪几个主题？');
});

test('面板可拖动、发送后清空输入框、键盘不穿透到页面', async () => {
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-test',
    apiBaseUrl: baseUrl,
    frameEnabled: false,
  });
  await openPanel(page, VIDEO_URL);

  // 1. 拖动标题栏，面板位置要真的变。
  const panel = page.locator('.vt-panel');
  const before = await panel.boundingBox();
  const head = await page.locator('.vt-head').boundingBox();
  expect(before && head).toBeTruthy();
  await page.mouse.move(head!.x + 40, head!.y + 10);
  await page.mouse.down();
  await page.mouse.move(head!.x + 40 - 120, head!.y + 10 - 70, { steps: 6 });
  await page.mouse.up();
  const after = await panel.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(50);
  expect(before!.y - after!.y).toBeGreaterThan(30);
  await page.screenshot({ path: join(SHOT_DIR, 'd3-panel-dragged.png') });

  // 2. 面板里的按键不应该冒泡到 document（B 站快捷键就在 document 上）。
  await page.evaluate(() => {
    const scope = window as unknown as { __pageKeys?: number };
    scope.__pageKeys = 0;
    document.addEventListener('keydown', () => {
      scope.__pageKeys = (scope.__pageKeys ?? 0) + 1;
    });
  });
  await page.mouse.click(400, 300);
  await page.keyboard.press('ArrowRight');
  const outside = await page.evaluate(
    () => (window as unknown as { __pageKeys?: number }).__pageKeys ?? 0,
  );
  expect(outside).toBeGreaterThan(0);

  const input = page.locator('.vt-input');
  await input.click();
  await input.press('ArrowRight');
  const inside = await page.evaluate(
    () => (window as unknown as { __pageKeys?: number }).__pageKeys ?? 0,
  );
  expect(inside).toBe(outside);

  // 3. 发送后输入框清空。
  await input.fill('清空测试');
  await page.locator('.vt-send').click();
  await expect(input).toHaveValue('');
});
