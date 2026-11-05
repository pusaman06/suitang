import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { resolve } from 'node:path';
import {
  VIDEO_URL,
  fetchSubtitlesFromOptions,
  getExtensionId,
  hasLoginCookie,
  isOursError,
  launchWithExtension,
} from './helpers';

/**
 * D2 验收：字幕列表 → 字幕文件 → 缓存整条链路跑通。
 * 调试按钮已移到设置页，这里直接给 background 发 video-meta / subtitle:list。
 */
test.describe('D2 字幕抓取', () => {
  let context: BrowserContext;
  let page: Page;
  let extensionId = '';
  const ourErrors: string[] = [];

  test.beforeAll(async () => {
    context = await launchWithExtension();
    if (!(await hasLoginCookie(context))) {
      await context.close();
      throw new Error('未登录 B 站：先跑 `pnpm e2e:login` 扫码一次，登录态会存进 .e2e/profile');
    }
    extensionId = await getExtensionId(context);

    // 每次从冷缓存开始，确保测的是「新拉取」而不是上一轮留下的缓存。
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    await options.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      await api.storage.local.clear();
    });
    await options.close();

    page = await context.newPage();
    page.on('console', message => {
      if (message.type() === 'error' && isOursError(message.text())) ourErrors.push(message.text());
    });
    page.on('pageerror', error => {
      if (isOursError(String(error))) ourErrors.push(String(error));
    });

    await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('设置页诊断能拉到字幕并写进 chrome.storage.local', async () => {
    const host = page.locator('#video-tutor-host');
    await expect(host, '悬浮球没注入，检查 content script 是否加载').toBeAttached({ timeout: 60_000 });

    await host.locator('.vt-ball').click();
    await expect(host.locator('.vt-panel')).toBeVisible();
    await page.screenshot({ path: resolve('e2e', 'screenshots', 'd2-panel.png') });

    // 字幕文件要下载、解析，给足时间；失败原因落在返回值里。
    const result = await fetchSubtitlesFromOptions(context, extensionId);
    expect(result.ok, `字幕失败：${result.error ?? '未知错误'}`).toBe(true);
    expect(result.total ?? 0).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
    // 只校条数不够：B 站接口会偶发返回别的视频的地址，正文必须对得上。
    expect((result.cues ?? []).map(cue => cue.content).join('')).toContain('零基础学AI');

    // 缓存真的落盘了：从扩展自己的页面读 storage。
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    const keys = (await options.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      return Object.keys(await api.storage.local.get(null));
    })) as string[];

    expect(keys.filter(key => key.startsWith('sub:BV1sHU9BmEne:'))).toHaveLength(1);
    await options.close();

    expect(ourErrors, `扩展自身控制台报错：${ourErrors.join(' | ')}`).toHaveLength(0);
  });
});
