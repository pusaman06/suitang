import { expect, test } from '@playwright/test';
import {
  clearStorage,
  getExtensionId,
  hasLoginCookie,
  launchWithExtension,
  writeSettings,
} from './helpers';

/**
 * 480 秒、有讲解语音的无字幕样本。
 * 原定的 BV1XnxP6vEdX（55 秒画面卡片）实测音轨只有背景音乐，
 * SenseVoice 只返回一个 🎼，无法验证「至少 3 句」。
 */
const ASR_VIDEO_URL = 'https://www.bilibili.com/video/BV14FHP6LEJE';
const KEY = process.env.SILICONFLOW_KEY ?? '';

test('真实 SiliconFlow：480 秒视频转写出至少 3 句', async () => {
  test.skip(!KEY, '没有设置 SILICONFLOW_KEY，跳过真实转写用例');

  const context = await launchWithExtension();
  try {
    const extensionId = await getExtensionId(context);
    if (!(await hasLoginCookie(context))) {
      test.skip(true, '需要先在 .e2e/profile 里登录 B 站（pnpm e2e:login）');
      return;
    }
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      asrApiKey: KEY,
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
    });

    const page = await context.newPage();
    await page.goto(ASR_VIDEO_URL, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    await page.locator('.vt-outline-asr').click();
    await expect(page.locator('.vt-outline-state')).toHaveText('已转写', { timeout: 120_000 });

    const helper = await context.newPage();
    await helper.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    const segments = await helper.evaluate(async () => {
      const all = (await chrome.storage.local.get(null)) as Record<string, unknown>;
      const key = Object.keys(all).find(item => item.startsWith('asr:'));
      const record = key ? (all[key] as { segments?: Array<{ text?: string }> }) : null;
      return (record?.segments ?? []).filter(segment => (segment.text ?? '').trim() !== '').length;
    });
    await helper.close();
    expect(segments).toBeGreaterThanOrEqual(3);
  } finally {
    await context.close();
  }
});
