import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { join } from 'node:path';
import {
  SHOT_DIR,
  clearStorage,
  getExtensionId,
  hasLoginCookie,
  isOursError,
  launchWithExtension,
  writeSettings,
} from './helpers';
// @ts-expect-error 本地 mock 是 .mjs，没有类型声明
import { createMockAsrServer } from './mock-asr.mjs';

/**
 * D8-A 音轨候选的 e2e：从哪条地址下载音轨、候选顺序如何、全部失败怎么提示。
 * 与 asr.spec.ts 用同一个 55 秒无字幕样本（BV1XnxP6vEdX）：打开面板、点「转写这段」，
 * 这里只断言下载链路，不关心转写出来的文本。
 */
const VIDEO_URL = 'https://www.bilibili.com/video/BV1XnxP6vEdX';

interface AudioItem {
  baseUrl?: string;
  backupUrl?: string[];
  bandwidth?: number;
}

let context: BrowserContext;
let extensionId: string;
let asr: ReturnType<typeof createMockAsrServer>;
let asrRoot: string;
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

  asr = createMockAsrServer();
  asrRoot = await asr.listen();

  page = await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error' && isOursError(message.text())) ourErrors.push(message.text());
  });
  page.on('pageerror', error => {
    if (isOursError(String(error))) ourErrors.push(String(error));
  });
  // 播放器自己的接口挡掉：字幕置空才会露出「转写这段」，playurl 不给音轨，
  // 保证音轨只来自下面注入的 __playinfo__。
  await page.route('**/x/player/v2**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { subtitle: { subtitles: [] }, view_points: [] } }),
    }),
  );
  await page.route('**/x/player/playurl**', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ code: 0, data: { dash: { audio: [] } } }),
    }),
  );
});

test.afterAll(async () => {
  expect(ourErrors, ourErrors.join('\n')).toEqual([]);
  await context?.close();
  await asr?.close();
});

test.beforeEach(() => {
  // 每个用例从干净的 mock 开始，audioRequests 只记本用例的下载。
  asr?.reset();
});

/** 打开视频面板，并把页面音轨替换成 mock 里的假地址（真实 CDN 下载不进测试）。 */
async function openPanelWith(audios: AudioItem[]): Promise<void> {
  await clearStorage(context, extensionId);
  await writeSettings(context, extensionId, {
    apiKey: 'sk-e2e-track',
    apiBaseUrl: 'http://127.0.0.1:9/v1',
    textModel: 'deepseek-flash',
    visionModel: 'deepseek-vision-e2e',
    maxTokens: 2048,
    thinking: false,
    contextWindowSec: 90,
    frameEnabled: false,
    asrApiKey: 'sk-asr-e2e',
    asrBaseUrl: `${asrRoot}/v1`,
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
  });

  await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
  await page.locator('.vt-ball').click();
  await expect(page.locator('.vt-panel')).toBeVisible();
  await expect(page.locator('.vt-outline-asr')).toBeVisible();

  // 首屏真实 __playinfo__ 指向 B 站 CDN；替换成本地 mock 地址，避免真实下载。
  await page.evaluate(items => {
    (window as unknown as { __playinfo__?: unknown }).__playinfo__ = {
      data: { dash: { audio: items } },
    };
  }, audios);
}

/** 点「转写这段」，确认走了下载链路并转写成功。 */
async function transcribeViaUi(): Promise<void> {
  const status = page.locator('.vt-outline-empty-text');
  await page.locator('.vt-outline-asr').click();
  await expect(status).toContainText('正在下载音轨', { timeout: 8_000 });
  await expect(status).toContainText('转写完成', { timeout: 30_000 });
}

/** 从 mock 记录里取实际被请求的路径（按到达顺序）。 */
function requestedPaths(): string[] {
  return asr.audioRequests.map((item: { path: string }) => item.path);
}

test('A 候选排序：标准 CDN 低码率优先，P2P 高码率排最后', async () => {
  // P2P 主机名放在 URL 片段里：产品排序对整串 URL 跑 /mcdn\.bilivideo\.cn/，会被判成
  // P2P；而请求仍落到本地 mock——万一排序回退真去试它，requestedPaths() 就会多出这条。
  const p2pHigh = `${asrRoot}/audio/p2p-high.m4a#mcdn.bilivideo.cn`;
  const standardLow = `${asrRoot}/audio/std-low-master.m4a`;
  const standardLowBackup = `${asrRoot}/audio/std-low-backup.m4a`;
  asr.state.audioDelayMs = 800;
  await openPanelWith([
    { baseUrl: p2pHigh, bandwidth: 192_000 },
    { baseUrl: standardLow, backupUrl: [standardLowBackup], bandwidth: 64_000 },
  ]);

  await transcribeViaUi();

  // 只下载标准 CDN 那条（码率更低）；P2P 高码率一次都没被试。
  // 同一条地址可能被离屏和后台直连各试一次，所以按去重后的 URL 集合断言。
  const paths = requestedPaths();
  expect(paths.length).toBeGreaterThan(0);
  expect([...new Set(paths)]).toEqual(['/audio/std-low-master.m4a']);
  expect(asr.requests).toHaveLength(1);
});

test('B 主地址 500：按顺序换到 backupUrl，转写成功', async () => {
  asr.state.audioStatus = { '/audio/std-master.m4a': 500 };
  const master = `${asrRoot}/audio/std-master.m4a`;
  const backup = `${asrRoot}/audio/std-backup.m4a`;
  asr.state.audioDelayMs = 600;
  await openPanelWith([{ baseUrl: master, backupUrl: [backup], bandwidth: 64_000 }]);

  await transcribeViaUi();

  const paths = requestedPaths();
  expect(paths).toContain('/audio/std-master.m4a');
  expect(paths).toContain('/audio/std-backup.m4a');
  // 先主地址、后备用地址；每条候选可能被离屏和后台直连各试一次，所以不锁总次数。
  expect(paths.indexOf('/audio/std-master.m4a')).toBeLessThan(
    paths.indexOf('/audio/std-backup.m4a'),
  );
  // 只真正转写一次（失败的那次下载不该发转写请求）。
  expect(asr.requests).toHaveLength(1);
});

test('C 全部候选 500：报下载失败、给重试入口、不进入转写', async () => {
  asr.state.audioStatus = {
    '/audio/all-1.m4a': 500,
    '/audio/all-2.m4a': 500,
    '/audio/all-3.m4a': 500,
  };
  await openPanelWith([
    {
      baseUrl: `${asrRoot}/audio/all-1.m4a`,
      backupUrl: [`${asrRoot}/audio/all-2.m4a`, `${asrRoot}/audio/all-3.m4a`],
      bandwidth: 64_000,
    },
  ]);

  await page.locator('.vt-outline-asr').click();
  await expect(page.locator('.vt-outline-error-text')).toContainText('下载音轨失败', {
    timeout: 30_000,
  });
  // 失败后要留重试入口，而不是只留一行红字。
  await expect(page.locator('.vt-outline-retry')).toBeVisible();
  await expect(page.locator('.vt-outline-retry-subtitles')).toBeVisible();
  // 没有一条音轨进入转写。
  expect(asr.requests).toHaveLength(0);

  // 三条候选都按顺序试过：主地址 → 第 1 个备份 → 第 2 个备份（按首次出现顺序）。
  const firstSeen: string[] = [];
  for (const item of asr.audioRequests as Array<{ path: string }>) {
    if (!firstSeen.includes(item.path)) firstSeen.push(item.path);
  }
  expect(firstSeen).toEqual(['/audio/all-1.m4a', '/audio/all-2.m4a', '/audio/all-3.m4a']);

  await page.screenshot({ path: join(SHOT_DIR, 'd8-asr-download-fail.png'), fullPage: false });
});

test('D 候选排序：P2P 码率更低也不能插队', async () => {
  const p2pLow = `${asrRoot}/audio/p2p-low.m4a#mcdn.bilivideo.cn`;
  const standardHigh = `${asrRoot}/audio/std-high.m4a`;
  asr.state.audioDelayMs = 800;
  await openPanelWith([
    { baseUrl: p2pLow, bandwidth: 48_000 },
    { baseUrl: standardHigh, bandwidth: 192_000 },
  ]);

  await transcribeViaUi();

  // 纯码率升序会让 48k 的 P2P 排第一；正确实现必须先按 P2P 分层、再比码率。
  const paths = requestedPaths();
  expect(paths.length).toBeGreaterThan(0);
  expect([...new Set(paths)]).toEqual(['/audio/std-high.m4a']);
  expect(asr.requests).toHaveLength(1);
});
