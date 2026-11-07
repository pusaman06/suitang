import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
let baseUrl: string;
let page: Page;
let companion: ChildProcess | null = null;
let companionBase = '';
let kbDir = '';
let workDir = '';
const ourErrors: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'vt-kbui-'));
  kbDir = mkdtempSync(join(tmpdir(), 'vt-kbui-lib-'));
  companion = spawn(
    process.execPath,
    ['companion/server.mjs', '--port', '0', '--dir', workDir, '--kb', kbDir],
    { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  companionBase = await new Promise<string>((resolvePromise, reject) => {
    let output = '';
    const timer = setTimeout(() => {
      companion?.kill();
      reject(new Error(`companion 启动超时：\n${output}`));
    }, 15_000);
    companion?.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolvePromise(`http://127.0.0.1:${match[1]}`);
      }
    });
    companion?.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
  });

  context = await launchWithExtension();
  extensionId = await getExtensionId(context);
  if (!(await hasLoginCookie(context))) {
    test.skip(true, '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）');
    return;
  }
  mock = createMockServer();
  baseUrl = await mock.listen();
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-kb',
    apiBaseUrl: baseUrl,
    textModel: 'deepseek-flash',
    // 存到知识库要求 companion 在跑；这里指向测试自己起的临时实例。
    companionUrl: companionBase,
    frameEnabled: false,
    thinking: false,
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
  await mock?.close();
  companion?.kill();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
  if (kbDir) rmSync(kbDir, { recursive: true, force: true });
});

async function openPanel(): Promise<void> {
  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();
}

/** 造一份字幕缓存，让生成大纲走「按字幕切」而不用真的转写。 */
async function seedCues(): Promise<void> {
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

async function generateOutline(): Promise<void> {
  await seedCues();
  await page.locator('.vt-outline-generate').click();
  await expect(page.locator('.vt-outline-state')).toHaveText(/^\d+ 段$/, { timeout: 60_000 });
}

test('存到知识库：预览 → 写入索引卡 + 原文底稿 → 再存是覆盖', async () => {
  await openPanel();
  await generateOutline();

  const kbOpen = page.locator('.vt-kb-open');
  await expect(kbOpen).toBeEnabled();
  await kbOpen.click();

  const box = page.locator('.vt-kb');
  await expect(box).toBeVisible();
  const preview = page.locator('.vt-kb-preview');
  const text = await preview.inputValue();
  expect(text).toContain('# 黑马程序员'); // 笔记标题
  expect(text).toContain('## 大纲');
  expect(text).toContain('## 关键词');
  expect(text).toContain('## 原文');
  expect(text).toContain('BV1sHU9BmEne-p01'); // 底稿链接带 p 号
  expect(text).toContain('测试摘要'); // mock 摘要请求的返回值
  await page.screenshot({ path: join(SHOT_DIR, 'd13-kb-preview.png') });

  await page.locator('.vt-kb-confirm').click();
  await expect(page.locator('.vt-status')).toContainText(/已存入|已覆盖/, { timeout: 20_000 });
  await expect(box).toBeHidden();

  const noteDir = join(kbDir, '20-知识笔记');
  const notes = readdirSync(noteDir).filter(name => name.endsWith('.md'));
  expect(notes).toHaveLength(1);
  // 文件名：<分 P 标题>（BV号-p01）.md，不带日期。
  expect(notes[0]).toContain('BV1sHU9BmEne-p01');
  expect(notes[0]).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  const markdown = readFileSync(join(noteDir, notes[0]), 'utf8');
  expect(markdown).toContain('type: 知识');
  expect(markdown).toContain('## 大纲');
  expect(markdown).toContain('## 原文');
  expect(markdown).toContain('50-底稿/视频原文/BV1sHU9BmEne/BV1sHU9BmEne-p01.md');

  const source = join(kbDir, '50-底稿', '视频原文', 'BV1sHU9BmEne', 'BV1sHU9BmEne-p01.md');
  const sourceText = readFileSync(source, 'utf8');
  expect(sourceText).toContain('## 字幕');
  expect(sourceText).toContain('## 大纲');
  await page.screenshot({ path: join(SHOT_DIR, 'd13-kb-saved.png') });

  // 同一个分 P 再存一次：覆盖更新，不堆第二份。
  await kbOpen.click();
  await expect(box).toBeVisible();
  await page.locator('.vt-kb-confirm').click();
  await expect(page.locator('.vt-status')).toContainText('已覆盖', { timeout: 20_000 });
  expect(readdirSync(noteDir).filter(name => name.endsWith('.md'))).toHaveLength(1);
});
