import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { join } from 'node:path';
import { SHOT_DIR, VIDEO_URL, clearStorage, getExtensionId, launchWithExtension, writeSettings } from './helpers';

let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  context = await launchWithExtension();
  extensionId = await getExtensionId(context);
});

test.afterAll(async () => {
  await context?.close();
});

/**
 * 这条用例盯的是「用户能不能点到」：面板上必须有「存到知识库」按钮，
 * 点完要出可编辑预览。不配 API Key，所以走的是「没有摘要的纯资料草稿」分支，
 * 不依赖网络也不花钱。
 */
test('面板上有「存到知识库」，点了出可编辑预览', async () => {
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, { apiKey: '' });

  const page: Page = await context.newPage();
  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();

  const open = page.locator('.vt-kb-open');
  await expect(open).toBeVisible();
  await expect(open).toHaveText('存到知识库');

  await open.click();
  const box = page.locator('.vt-kb');
  await expect(box).toBeVisible({ timeout: 20_000 });

  const preview = page.locator('.vt-kb-preview');
  await expect(preview).toHaveValue(/^---[\s\S]*## 基本信息[\s\S]*## 原文/);
  await expect(page.locator('.vt-kb-hint')).toContainText('.md');
  // 没配 key 时不该假装有摘要
  await expect(page.locator('.vt-kb-hint')).toContainText('没配 API Key');

  await page.screenshot({ path: join(SHOT_DIR, 'kb-panel.png') });

  await page.locator('.vt-kb-cancel').click();
  await expect(box).toBeHidden();
  await page.close();
});
