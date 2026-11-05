import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { resolve } from 'node:path';
import {
  VIDEO_URL,
  getExtensionId,
  hasLoginCookie,
  isOursError,
  launchWithExtension,
} from './helpers';

/**
 * D2 验收：真浏览器里点「测试字幕（前 10 条）」，字幕列表 → 字幕文件 → 缓存
 * 整条链路跑通。失败时截图留在 e2e/screenshots。
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

  test('点「测试字幕」能拉到字幕并写进 chrome.storage.local', async () => {
    const host = page.locator('#video-tutor-host');
    await expect(host, '悬浮球没注入，检查 content script 是否加载').toBeAttached({ timeout: 60_000 });

    await host.locator('.vt-ball').click();
    await expect(host.locator('.vt-panel')).toBeVisible();

    const log = host.locator('.vt-log');
    await host.locator('.vt-sub').click();

    // 字幕文件要下载、解析，给足时间；失败文案也会落在这里。
    await expect(log).toContainText(/共 \d+ 条/, { timeout: 90_000 });
    await expect(log, `面板报错：${await log.textContent()}`).not.toContainText('字幕失败');
    await expect(log).toContainText(/新拉取/);
    // 只校条数不够：B 站接口会偶发返回别的视频的地址，正文必须对得上。
    await expect(log).toContainText('零基础学AI');

    await page.screenshot({ path: resolve('e2e', 'screenshots', 'd2-panel.png') });

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
