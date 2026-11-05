import { chromium, type BrowserContext } from '@playwright/test';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

export const EXTENSION_PATH = resolve(process.cwd(), 'dist');
export const PROFILE_DIR = resolve(process.cwd(), '.e2e', 'profile');
export const SHOT_DIR = resolve(process.cwd(), 'e2e', 'screenshots');

/** D2 的验证样本：185P 合集，B 站对它返回 need_login_subtitle。 */
export const VIDEO_URL = 'https://www.bilibili.com/video/BV1sHU9BmEne';

/** D3 无字幕样本：subtitle.list 为空数组。 */
export const NO_SUBTITLE_VIDEO_URL = 'https://www.bilibili.com/video/BV1Ud436mEKp';

/**
 * 扩展只能在有头 Chromium 里跑；用持久化 profile 让登录态跨次复用。
 * profile 存在 .e2e/profile，登录一次之后每次测试都自动带 Cookie。
 */
export async function launchWithExtension(): Promise<BrowserContext> {
  mkdirSync(PROFILE_DIR, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  // 未打包扩展会被 Chromium 缓存脚本；不清掉会跑到上一版 background.js。
  for (const dir of ['Service Worker', 'Code Cache']) {
    rmSync(resolve(PROFILE_DIR, 'Default', dir), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
  return chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chromium',
    headless: false,
    viewport: { width: 1440, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      // D6：允许扩展从页面访问 127.0.0.1 的 companion。
      '--disable-features=BlockInsecurePrivateNetworkRequests',
    ],
  });
}

export async function getExtensionId(context: BrowserContext): Promise<string> {
  const existing = context.serviceWorkers();
  const worker = existing.length
    ? existing[0]
    : await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const id = worker.url().split('/')[2];
  if (!id) throw new Error(`拿不到扩展 ID：${worker.url()}`);
  return id;
}

export async function hasLoginCookie(context: BrowserContext): Promise<boolean> {
  const cookies = await context.cookies('https://www.bilibili.com');
  return cookies.some(cookie => cookie.name === 'SESSDATA' && cookie.value.length > 0);
}

/** 只收集我们自己代码的报错；B 站页面自身的广告/埋点噪音不算。 */
export function isOursError(text: string): boolean {
  return /video-tutor|chrome-extension:\/\//.test(text);
}

export async function clearStorage(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await page.evaluate(() => chrome.storage.local.clear());
  await page.close();
}

/** 直接写 storage，绕开设置页表单（e2e 只关心设置生效）。 */
export async function writeSettings(
  context: BrowserContext,
  extensionId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await page.evaluate(async value => {
    const stored = await chrome.storage.local.get('settings');
    const current = (stored.settings ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({ settings: { ...current, ...value } });
  }, patch);
  await page.close();
}

export interface SubtitleDiagnosticsResult {
  ok: boolean;
  total?: number;
  cached?: boolean;
  error?: string;
  needLogin?: boolean;
  track?: { lan?: string; lan_doc?: string };
  cues?: Array<{ from: number; to: number; content: string }>;
}

/**
 * 走设置页诊断同一条链路：video-meta → subtitle:list（显式 tabId）。
 * D2 面板里的调试按钮已经移到设置页，用例不再依赖内容面板 UI。
 */
export async function fetchSubtitlesFromOptions(
  context: BrowserContext,
  extensionId: string,
): Promise<SubtitleDiagnosticsResult> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  try {
    let last: SubtitleDiagnosticsResult = { ok: false, error: '没有执行' };
    // B 站的 x/player/v2 偶尔返回空字幕列表（不是真没字幕），重试几次再判失败。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await page.waitForTimeout(800);
      last = (await page.evaluate(async () => {
      const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
      const tab = tabs[tabs.length - 1];
      if (!tab?.id || !tab.url) return { ok: false, error: '没有打开的视频页' };
      const bvid = /\/video\/(BV[0-9A-Za-z]+)/.exec(tab.url)?.[1] ?? '';
      const p = Number(new URL(tab.url).searchParams.get('p') ?? '1') || 1;
      const meta = (await chrome.runtime.sendMessage({
        type: 'video-meta',
        bvid,
        tabId: tab.id,
      })) as { aid?: number; pages?: Array<{ page: number; cid: number; duration: number }> } | null;
      const part = meta?.pages?.find(item => item.page === p) ?? meta?.pages?.[0];
      if (!meta?.aid || !part) return { ok: false, error: '缺少 aid/cid' };
      return (await chrome.runtime.sendMessage({
        type: 'subtitle:list',
        bvid,
        aid: meta.aid,
        cid: part.cid,
        p: part.page,
        duration: part.duration,
        tabId: tab.id,
      })) as SubtitleDiagnosticsResult;
      })) as SubtitleDiagnosticsResult;
      if (last.ok) return last;
    }
    return last;
  } finally {
    await page.close();
  }
}
