import { expect, test, type Route } from '@playwright/test';
import { resolve } from 'node:path';
import { clearStorage, getExtensionId, isOursError, launchWithExtension, SHOT_DIR } from './helpers';

/**
 * D11 回归：B 站是 SPA，点「相关推荐」只改 URL、不刷新页面。
 *
 * 这条用例不碰真实 B 站接口（也不要求登录）：
 *   - 文档本身由 page.route 返回一个假视频页，页面里的 __INITIAL_STATE__ 停在第 1 个视频；
 *   - 「相关推荐」链接点击时跟 B 站前端一样 preventDefault + history.pushState；
 *   - x/web-interface/view、x/player/v2、x/player/playurl 按 bvid / cid 分路返回 mock。
 *
 * 断言的是扩展自己的行为：面板跟着换成新视频的 bvid/cid；旧 __INITIAL_STATE__ 不可信，
 * 切完后取字幕必须用新视频的 aid/cid，而不是上一个视频残留的值。
 */

const BVID_A = 'BV1aa411c7aa';
const BVID_B = 'BV1bb411c7bb';
const AID_A = 100001;
const AID_B = 100002;
const CID_A = 200001;
const CID_B = 200002;
const DURATION_A = 120;
const DURATION_B = 130;

interface MockVideoMeta {
  bvid: string;
  aid: number;
  title: string;
  duration: number;
  owner: { name: string };
  pages: Array<{ page: number; cid: number; part: string; duration: number }>;
}

const MOCK_VIDEO_META: Record<string, MockVideoMeta> = {
  [BVID_A]: {
    bvid: BVID_A,
    aid: AID_A,
    title: '视频 A（mock）',
    duration: DURATION_A,
    owner: { name: 'mock-up-a' },
    pages: [{ page: 1, cid: CID_A, part: 'A', duration: DURATION_A }],
  },
  [BVID_B]: {
    bvid: BVID_B,
    aid: AID_B,
    title: '视频 B（mock）',
    duration: DURATION_B,
    owner: { name: 'mock-up-b' },
    pages: [{ page: 1, cid: CID_B, part: 'B', duration: DURATION_B }],
  },
};

/** 假视频页：只保留扩展真正读取的东西（__INITIAL_STATE__ + 一个相关推荐链接）。 */
const MOCK_PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>视频 A（mock）_哔哩哔哩_bilibili</title>
<script>
  // 页面只加载一次：SPA 换视频时这段不会重跑，模拟 B 站 __INITIAL_STATE__ 落后的真实情况。
  window.__INITIAL_STATE__ = {
    videoData: {
      bvid: '${BVID_A}',
      aid: ${AID_A},
      title: '视频 A（mock）',
      duration: ${DURATION_A},
      owner: { name: 'mock-up-a' },
      pages: [{ page: 1, cid: ${CID_A}, part: 'A', duration: ${DURATION_A} }]
    }
  };
  window.__e2eSpaSentinel = 'alive';
</script>
</head>
<body>
<h1>视频 A（mock）</h1>
<a id="related-b" href="/video/${BVID_B}">相关推荐：视频 B</a>
<script>
  // 跟 B 站前端一样：拦掉默认跳转，只 pushState 换 URL，文档不重载。
  document.getElementById('related-b').addEventListener('click', function (event) {
    event.preventDefault();
    history.pushState({}, '', '/video/${BVID_B}');
  });
</script>
</body>
</html>`;

/** 跨域 fetch 的响应头；即便 Playwright 不强制 CORS，加了也不影响。 */
const CORS_HEADERS = {
  'access-control-allow-origin': 'https://www.bilibili.com',
  'access-control-allow-credentials': 'true',
};

interface SubtitleHit {
  bvid: string;
  aid: string;
  cid: string;
}

test('SPA 换视频：面板跟着换，取字幕用的 cid 属于新视频', async () => {
  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  await clearStorage(context, extensionId);
  const page = await context.newPage();

  const ourErrors: string[] = [];
  page.on('console', message => {
    if (message.type() === 'error' && isOursError(message.text())) ourErrors.push(message.text());
  });
  page.on('pageerror', error => {
    if (isOursError(String(error))) ourErrors.push(String(error));
  });

  // 视频接口：按 bvid 返回对应 meta，同时记下请求顺序（用来判断有没有信旧 state）。
  const viewHits: string[] = [];
  // 字幕列表接口：记下实际用的 aid/cid，断言它们属于新视频。
  const subtitleHits: SubtitleHit[] = [];

  try {
    await page.route('https://www.bilibili.com/video/**', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: MOCK_PAGE_HTML,
      });
    });

    await page.route('**/x/web-interface/view**', async (route: Route) => {
      const bvid = new URL(route.request().url()).searchParams.get('bvid') ?? '';
      viewHits.push(bvid);
      const meta = MOCK_VIDEO_META[bvid];
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: CORS_HEADERS,
        body: JSON.stringify(
          meta ? { code: 0, message: '0', data: meta } : { code: -404, message: 'mock 里没有这个视频', data: null },
        ),
      });
    });

    // 空字幕列表：不需要真的下载字幕文件，但足以证明「取字幕用的是哪个 cid」。
    await page.route('**/x/player/v2**', async (route: Route) => {
      const url = new URL(route.request().url());
      subtitleHits.push({
        bvid: url.searchParams.get('bvid') ?? '',
        aid: url.searchParams.get('aid') ?? '',
        cid: url.searchParams.get('cid') ?? '',
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: CORS_HEADERS,
        body: JSON.stringify({
          code: 0,
          message: '0',
          data: { subtitle: { subtitles: [] }, view_points: [] },
        }),
      });
    });

    // 兜底：本用例不该下音频；真被调用也返回失败，绝不落到真实 B 站。
    await page.route('**/x/player/playurl**', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: CORS_HEADERS,
        body: JSON.stringify({ code: -403, message: 'mock：不真的下音频', data: null }),
      });
    });

    await page.goto(`https://www.bilibili.com/video/${BVID_A}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    // 第 1 个视频：__INITIAL_STATE__ 与 URL 一致，面板显示 A 的 bvid/cid。
    await expect(page.locator('.vt-ids')).toHaveText(`${BVID_A} · cid ${CID_A}`, { timeout: 20_000 });

    const viewHitsBefore = viewHits.length;

    // 点「相关推荐」→ B 站式 SPA 跳转：URL 变了，但文档没有重载。
    await page.locator('#related-b').click();
    await expect
      .poll(() => page.evaluate(() => location.href), { timeout: 20_000, message: 'SPA 跳转只改 URL' })
      .toBe(`https://www.bilibili.com/video/${BVID_B}`);
    // sentinel 是文档加载时写的：还在说明页面没刷新，这是「SPA」的关键证据。
    expect(
      await page.evaluate(() => (window as unknown as { __e2eSpaSentinel?: string }).__e2eSpaSentinel),
      '点击相关推荐不应该刷新页面',
    ).toBe('alive');

    // 面板跟着换：bvid/cid 都来自新视频。
    await expect(page.locator('.vt-ids')).toHaveText(`${BVID_B} · cid ${CID_B}`, { timeout: 30_000 });
    // 旧 __INITIAL_STATE__ 的 bvid 对不上，必须走视频接口查 B，而不是继续用 A 的 cid。
    expect(viewHits.slice(viewHitsBefore), '切视频后应该按新 bvid 查过视频接口').toContain(BVID_B);

    // 切完后生成大纲：即便没有 Key，也会先拉字幕列表 —— 用这个请求验证 cid 是不是新视频的。
    subtitleHits.length = 0;
    await page.locator('.vt-outline-generate').click();
    await expect
      .poll(() => subtitleHits.length, { timeout: 20_000, message: '点了生成大纲应该先拉字幕列表' })
      .toBeGreaterThan(0);
    for (const hit of subtitleHits) {
      expect(hit.bvid, `字幕请求的 bvid 应是新视频：${JSON.stringify(hit)}`).toBe(BVID_B);
      expect(hit.aid, `字幕请求的 aid 应是新视频：${JSON.stringify(hit)}`).toBe(String(AID_B));
      expect(hit.cid, `字幕请求的 cid 应是新视频：${JSON.stringify(hit)}`).toBe(String(CID_B));
    }

    await page.screenshot({ path: resolve(SHOT_DIR, 'd11-spa-switch.png'), fullPage: false });
    expect(ourErrors, `扩展自己不该报错：\n${ourErrors.join('\n')}`).toEqual([]);
  } finally {
    await page.close();
    await context.close();
  }
});
