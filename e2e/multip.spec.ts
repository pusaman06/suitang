import { expect, test } from '@playwright/test';
import { join } from 'node:path';
import {
  SHOT_DIR,
  VIDEO_URL,
  clearStorage,
  getExtensionId,
  hasLoginCookie,
  launchWithExtension,
  writeSettings,
} from './helpers';
// @ts-expect-error 本地 mock 是 .mjs，没有类型声明
import { createMockServer } from './mock-deepseek.mjs';

/**
 * 待办 3c：BV1sHU9BmEne（185P）多 P 隔离。
 * 大纲缓存键是 outlineStorageKey(bvid, p, cid)：p1 生成过，切到 p2 必须看不到 p1 的大纲。
 */
test('多 P 视频：p1 的大纲不会串到 p2', async () => {
  test.setTimeout(240_000);
  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  if (!(await hasLoginCookie(context))) {
    test.skip(true, '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）');
    return;
  }
  const mock = createMockServer();
  const baseUrl = await mock.listen();
  const page = await context.newPage();

  const openPanel = async (url: string): Promise<void> => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();
  };

  /** 给当前打开的视频页 p1 写一份字幕缓存（否则 mock 拿不到 cues，会报没字幕）。 */
  const seedCues = async (): Promise<void> => {
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
        })) as { aid?: number; pages?: Array<{ page: number; cid: number; duration: number }> } | null;
        const part = meta?.pages?.find(item => item.page === p) ?? meta?.pages?.[0];
        if (!meta?.aid || !part) throw new Error('缺少 aid/cid');
        const cues = [];
        for (let from = 0; from < Math.max(1, part.duration); from += 12) {
          cues.push({ from, to: from + 8, content: `第 ${from} 秒的内容` });
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
  };

  try {
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: 'sk-e2e-outline',
      apiBaseUrl: baseUrl,
      textModel: 'deepseek-flash',
      maxTokens: 2048,
      thinking: false,
      frameEnabled: false,
    });

    await openPanel(VIDEO_URL);
    await expect(page.locator('.vt-part')).toContainText('P1', { timeout: 30_000 });
    await seedCues();

    await page.locator('.vt-outline-generate').click();
    await expect(page.locator('.vt-outline-state')).toHaveText('9 段', { timeout: 90_000 });
    const p1Items = await page.locator('.vt-outline-item').count();
    console.log('===P1===' + p1Items + ' 段');
    await page.screenshot({ path: join(SHOT_DIR, 'd10-multip-p1.png') });

    // 切到 p2：新分 P 必须从「未生成」开始，不能显示 p1 的 9 段。
    await openPanel(`${VIDEO_URL}?p=2`);
    await expect(page.locator('.vt-part')).toContainText('P2', { timeout: 30_000 });
    await expect(page.locator('.vt-outline-state')).toHaveText('未生成', { timeout: 30_000 });
    const p2Items = await page.locator('.vt-outline-item').count();
    const p2EmptyVisible = await page.locator('.vt-outline-empty').isVisible();
    console.log(`===P2=== ${p2Items} 段，空态可见=${p2EmptyVisible}`);
    await page.screenshot({ path: join(SHOT_DIR, 'd10-multip-p2.png') });
    expect(p2Items).toBe(0);
    expect(p2EmptyVisible).toBe(true);

    // 再切回 p1：缓存里的大纲应该还在。
    await openPanel(VIDEO_URL);
    await expect(page.locator('.vt-part')).toContainText('P1', { timeout: 30_000 });
    await expect(page.locator('.vt-outline-state')).toHaveText('9 段', { timeout: 30_000 });
    const backItems = await page.locator('.vt-outline-item').count();
    console.log('===P1-BACK===' + backItems + ' 段');
    expect(backItems).toBe(9);
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
    await mock.close();
  }
});
