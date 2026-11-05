import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { createMockServer } from './mock-deepseek.mjs';

let context: BrowserContext;
let extensionId: string;
let mock: ReturnType<typeof createMockServer>;
let mockBaseUrl: string;
let page: Page;
let companion: ChildProcess;
let companionPort = 0;
let companionDir = '';
const ourErrors: string[] = [];

function watch(target: Page): void {
  target.on('console', message => {
    if (message.type() === 'error' && isOursError(message.text())) ourErrors.push(message.text());
  });
  target.on('pageerror', error => {
    if (isOursError(String(error))) ourErrors.push(String(error));
  });
}

function startCompanion(port: string, dir: string): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['companion/server.mjs', '--port', port, '--dir', dir],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let started = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`companion 启动超时：\n${output}`));
    }, 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        started = true;
        companionPort = Number(match[1]);
        resolvePromise(child);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      if (!started && code !== null) {
        clearTimeout(timer);
        reject(new Error(`companion 退出 ${code}：\n${output}`));
      }
    });
  });
}

async function stopCompanion(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolvePromise => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // 还没起来。
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
  }
  throw new Error(`companion /health 不可用：${baseUrl}`);
}

async function sendRuntime<T>(target: Page, message: unknown): Promise<T> {
  return (await target.evaluate(async value => {
    return (await chrome.runtime.sendMessage(value)) as unknown;
  }, message)) as T;
}

async function openPanel(target: Page, url: string): Promise<void> {
  await target.goto(url, { waitUntil: 'domcontentloaded' });
  await expect(target.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await target.locator('.vt-ball').click();
  await expect(target.locator('.vt-panel')).toBeVisible();
}

async function seedSubtitleCache(): Promise<void> {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  try {
    await options.evaluate(async () => {
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
      const cues = Array.from({ length: 40 }, (_, index) => ({
        from: index * 12,
        to: index * 12 + 10,
        content: `第 ${index + 1} 条测试字幕，讲的是第 ${index + 1} 个知识点。`,
      }));
      const key = `sub:${bvid}:${p}:${part.cid}`;
      await chrome.storage.local.set({
        [key]: {
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
    await options.close();
  }
}

async function readPageJson(): Promise<Record<string, unknown>> {
  const file = resolve(companionDir, 'videos', 'BV1sHU9BmEne', 'p1.json');
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error(`p1.json 未生成：${file}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  context = await launchWithExtension();
  extensionId = await getExtensionId(context);
  if (!(await hasLoginCookie(context))) {
    test.skip(true, '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）');
    return;
  }
  companionDir = resolve('test-results', `companion-${Date.now()}`);
  mkdirSync(companionDir, { recursive: true });
  companion = await startCompanion('0', companionDir);
  mock = createMockServer();
  mockBaseUrl = await mock.listen();
  await clearStorage(context, extensionId);
  page = await context.newPage();
  watch(page);
});

test.afterAll(async () => {
  expect(ourErrors, ourErrors.join('\n')).toEqual([]);
  await stopCompanion(companion);
  await context?.close();
  await mock?.close();
});

test('health 字段齐全，视频列表初始为空', async () => {
  const health = (await (await fetch(`http://127.0.0.1:${companionPort}/health`)).json()) as {
    ok: boolean;
    version: string;
    dir: string;
    uptimeSec: number;
  };
  expect(health.ok).toBe(true);
  expect(health.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(health.dir).toBe(companionDir);
  expect(Number.isFinite(health.uptimeSec)).toBe(true);

  const list = (await (
    await fetch(`http://127.0.0.1:${companionPort}/api/videos`)
  ).json()) as { ok: boolean; videos: unknown[] };
  expect(list.ok).toBe(true);
  expect(list.videos).toEqual([]);
});

test('companion 拒绝外部 Origin 和非法 bvid', async () => {
  const evil = await fetch(`http://127.0.0.1:${companionPort}/api/videos/BV1sHU9BmEne`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
    body: '{}',
  });
  expect(evil.status).toBe(403);
  const evilBody = (await evil.json()) as { code: string };
  expect(evilBody.code).toBe('forbidden-origin');

  const bad = await fetch(`http://127.0.0.1:${companionPort}/api/videos/not-a-bvid/p/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(bad.status).toBe(400);
  const badBody = (await bad.json()) as { code: string };
  expect(badBody.code).toBe('bad-request');

  const preflight = await fetch(`http://127.0.0.1:${companionPort}/api/videos/BV1sHU9BmEne`, {
    method: 'OPTIONS',
    headers: {
      origin: 'chrome-extension://e2e-test',
      'access-control-request-method': 'PUT',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('chrome-extension://e2e-test');
  expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
  expect(preflight.headers.get('access-control-max-age')).toBe('600');
});

test('提问后 p1.json / p1.md 落盘，subtitle 和 qa 都有内容', async () => {
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-test',
    apiBaseUrl: mockBaseUrl,
    textModel: 'deepseek-flash',
    maxTokens: 2048,
    thinking: false,
    contextWindowSec: 90,
    frameEnabled: false,
    companionUrl: `http://127.0.0.1:${companionPort}`,
    syncEnabled: true,
  });

  await openPanel(page, VIDEO_URL);
  await seedSubtitleCache();

  const question = '这一页讲了什么？';
  await page.locator('.vt-input').fill(question);
  await page.locator('.vt-send').click();
  await expect(page.locator('.vt-a').first()).toContainText('测试全文结束', { timeout: 20_000 });

  const pageJson = await readPageJson();
  expect(pageJson.bvid).toBe('BV1sHU9BmEne');
  expect(pageJson.p).toBe(1);
  const subtitle = pageJson.subtitle as {
    lang?: string;
    segments?: Array<{ from: number; text: string }>;
  };
  expect(subtitle.lang).toBe('ai-zh');
  expect(subtitle.segments?.length ?? 0).toBeGreaterThan(0);
  const qa = pageJson.qa as Array<{ q?: string; a?: string }>;
  expect(qa[0]?.q).toBe(question);
  expect(qa[0]?.a).toContain('测试全文结束');

  const md = readFileSync(resolve(companionDir, 'videos', 'BV1sHU9BmEne', 'p1.md'), 'utf8');
  expect(md.split('\n')[0]).toMatch(/^# .+/);
  expect(md).toContain('## 基本信息');
  expect(md).toContain('## 字幕');
  expect(md).toContain('## 问答');
  expect(md).toMatch(/\[\d{2}:\d{2}\]/);
  expect(md).toContain('这一页讲了什么？');

  const courseResponse = await fetch(
    `http://127.0.0.1:${companionPort}/api/videos/BV1sHU9BmEne`,
  );
  expect(courseResponse.status).toBe(200);
  const course = (await courseResponse.json()) as {
    bvid: string;
    pages: Array<{ p: number }>;
  };
  expect(course.bvid).toBe('BV1sHU9BmEne');
  expect(course.pages.length).toBeGreaterThan(0);

  const listResponse = await fetch(`http://127.0.0.1:${companionPort}/api/videos`);
  const list = (await listResponse.json()) as { videos: Array<{ bvid: string }> };
  expect(list.videos[0]?.bvid).toBe('BV1sHU9BmEne');

  const pageResponse = await fetch(
    `http://127.0.0.1:${companionPort}/api/videos/BV1sHU9BmEne/p/1`,
  );
  expect(pageResponse.status).toBe(200);
  const pageBody = (await pageResponse.json()) as { qa?: Array<{ q?: string }> };
  expect(pageBody.qa?.[0]?.q).toBe(question);

  const courseMd = readFileSync(
    resolve(companionDir, 'videos', 'BV1sHU9BmEne', 'course.md'),
    'utf8',
  );
  expect(courseMd).toContain('## 分 P');
  expect(courseMd).toContain('- P1 ');

  await expect(page.locator('.vt-sync')).toContainText('已同步', { timeout: 10_000 });
});

test('companion 关闭时提问仍成功，队列保留 pending', async () => {
  await stopCompanion(companion);
  companion = undefined as unknown as ChildProcess;

  const question = '离线时还能回答吗？';
  await page.locator('.vt-input').fill(question);
  await page.locator('.vt-send').click();
  await expect(page.locator('.vt-a').nth(1)).toContainText('测试全文结束', { timeout: 20_000 });

  await expect(page.locator('.vt-sync')).toContainText('待同步', { timeout: 10_000 });
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  try {
    const status = await sendRuntime<{
      pending: number;
      failed: number;
      lastError?: string;
    }>(options, { type: 'sync:status' });
    expect(status.pending).toBeGreaterThanOrEqual(1);
    expect(status.lastError).toBeTruthy();
  } finally {
    await options.close();
  }
});

test('重启 companion 后手动 flush，文件更新且 pending 归零', async () => {
  companion = await startCompanion(String(companionPort), companionDir);
  await waitForHealth(`http://127.0.0.1:${companionPort}`);

  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  try {
    let status: { pending: number; failed: number } = { pending: 1, failed: 0 };
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const result = await sendRuntime<{ ok: boolean }>(options, { type: 'sync:flush' });
      expect(result.ok).toBe(true);
      status = await sendRuntime<{ pending: number; failed: number }>(options, {
        type: 'sync:status',
      });
      if (status.pending === 0) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    expect(status.pending).toBe(0);
    expect(status.failed).toBe(0);
  } finally {
    await options.close();
  }

  const pageJson = await readPageJson();
  const qa = pageJson.qa as Array<{ q?: string }>;
  expect(qa.map(item => item.q)).toContain('离线时还能回答吗？');

  await page.locator('.vt-sync').click();
  await expect(page.locator('.vt-sync')).toContainText('已同步', { timeout: 10_000 });
  await page.screenshot({ path: resolve(SHOT_DIR, 'd6-sync.png'), fullPage: false });
});

test('失败队列里的条目，点一下「同步失败 N 条」就放回队列重试', async () => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  try {
    // 造一条已判死刑的条目：相当于 companion 长时间没开、重试 3 次后被移进失败队列。
    await options.evaluate(async () => {
      await chrome.storage.local.set({
        'sync:failed': [
          {
            id: 's-retry-1',
            kind: 'page',
            bvid: 'BV1sHU9BmEne',
            p: 1,
            payload: { bvid: 'BV1sHU9BmEne', p: 1 },
            attempts: 3,
            queuedAt: Date.now(),
            failedAt: Date.now(),
            lastError: 'Failed to fetch',
          },
        ],
        'sync:queue': [],
      });
    });

    const before = await sendRuntime<{ pending: number; failed: number }>(options, {
      type: 'sync:status',
    });
    expect(before.failed).toBe(1);
    expect(before.pending).toBe(0);

    const flushed = await sendRuntime<{ ok: boolean }>(options, { type: 'sync:flush' });
    expect(flushed.ok).toBe(true);

    const after = await sendRuntime<{ pending: number; failed: number }>(options, {
      type: 'sync:status',
    });
    expect(after.failed).toBe(0);
  } finally {
    await options.close();
  }
});
