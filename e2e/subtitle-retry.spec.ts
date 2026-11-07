/**
 * 字幕链路 e2e（全 mock，不碰真实 B 站 / 真实 Key）：
 * 1. 重试链：人工轨 → 空地址 AI 轨 → 有效 AI 轨，第三次成功，最终缓存 track 是 AI 轨。
 * 2. 串视频地址：12 次重试后报可读错误、不落缓存；再走大纲快速失败且不写大纲缓存。
 * 3. 陈旧缓存：track 指向别的视频 / 只覆盖前 10 秒会被丢弃重拉；合法缓存零请求。
 *
 * 页面用 context.route 直接发一份带 __INITIAL_STATE__ 的 HTML，readVideoMeta 走页面状态，
 * 不打真实 B 站接口；字幕列表由 context.route 按调用次数返回；字幕正文由本地 http server
 * 提供（后台页 fetchTextDirect 直连，page.route 拦不到）。
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { outlineStorageKey, type OutlineGenerateResponse } from '../src/shared/outline';
import type {
  SubtitleCache,
  SubtitleCue,
  SubtitleResult,
  SubtitleTrack,
} from '../src/shared/types';
import { clearStorage, getExtensionId, launchWithExtension, writeSettings } from './helpers';

const BVID = 'BV1MockSub01';
const AID = 350001;
const CID = 980001;
const P = 1;
const DURATION = 600;
const MOCK_TITLE = 'Mock 课程';
const VIDEO_URL = `https://www.bilibili.com/video/${BVID}`;
/** 同一个 aid、另一个 cid：拼出「别的视频的 AI 字幕地址」（校验按 aid+cid 拼接比对前缀）。 */
const OTHER_CID = 980002;
const SUB_CACHE_KEY = `sub:${BVID}:${P}:${CID}`;
const OUTLINE_KEY = outlineStorageKey(BVID, P, CID);
/** duration*0.6，coversVideoDuration 的下界。 */
const MIN_COVER_SECONDS = DURATION * 0.6;

const API_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // 列表接口是在页面主世界（www.bilibili.com）里 fetch 的跨域请求，且带 credentials，
  // 必须回显精确 Origin；否则浏览器按 CORS 拦截，测试会以为是接口失败。
  'access-control-allow-origin': 'https://www.bilibili.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

interface VideoPageTarget {
  tabId: number;
  bvid: string;
  p: number;
  aid: number;
  cid: number;
  duration: number;
}

let context: BrowserContext;
let extensionId: string;
let videoPage: Page;
let optionsPage: Page | null = null;
let target: VideoPageTarget;
let subtitleServer: ReturnType<typeof createSubtitleServer>;
let baseUrl = '';

/** 字幕列表接口被调用的次数（route 里同步自增，响应返回时计数已稳定）。 */
let playerCalls = 0;
/** 第 n 次（从 1 开始）请求该返回哪些轨道。 */
let playerReply: (call: number) => SubtitleTrack[] = () => [];

test.describe.configure({ mode: 'serial' });

/* ------------------------------ 本地字幕文件 server ------------------------------ */

function buildCues(label: string, end = DURATION): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const step = 30;
  for (let from = 0; from < end; from += step) {
    cues.push({
      from,
      to: Math.min(end, from + step),
      content: `${label}第 ${from / step + 1} 句`,
    });
  }
  return cues;
}

/** 20 句、覆盖 0–600s 的字幕正文；AI/人工用不同文案区分。 */
function createSubtitleServer(): {
  listen: () => Promise<string>;
  close: () => Promise<void>;
} {
  const aiCues = buildCues('AI 字幕');
  const humanCues = buildCues('人工字幕');
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (path.startsWith(`/prod/${AID}${CID}`)) {
      res.end(JSON.stringify({ body: aiCues }));
      return;
    }
    if (path.startsWith('/human')) {
      res.end(JSON.stringify({ body: humanCues }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ body: [] }));
  });
  // 后台页会先按 normalizeSubtitleUrl 把 http 改成 https 试一次，TLS 握手会打到这个
  // 明文 server 上；销毁 socket 即可，让后台走到 http 候选。
  server.on('clientError', (_error, socket) => socket.destroy());
  return {
    listen: () =>
      new Promise<string>(resolve => {
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port = typeof address === 'object' && address ? address.port : 0;
          resolve(`http://127.0.0.1:${port}`);
        });
      }),
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => resolve());
      }),
  };
}

function aiTrack(): SubtitleTrack {
  // 19 位起点：<aid><cid>0000000，subtitleUrlMatchesCid 校验这个前缀。
  return { lan: 'ai-zh', lan_doc: 'AI 中文', subtitle_url: `${baseUrl}/prod/${AID}${CID}0000000` };
}

function humanTrack(): SubtitleTrack {
  return { lan: 'zh-CN', lan_doc: '中文（人工）', subtitle_url: `${baseUrl}/human.json` };
}

function otherVideoAiTrack(): SubtitleTrack {
  return {
    lan: 'ai-zh',
    lan_doc: 'AI 中文',
    subtitle_url: `${baseUrl}/prod/${AID}${OTHER_CID}0000000`,
  };
}

function makeCache(track: SubtitleTrack, cues: SubtitleCue[]): SubtitleCache {
  return { bvid: BVID, p: P, cid: CID, fetchedAt: Date.now(), track, total: cues.length, cues };
}

/* ------------------------------ mock 页面 / 轨道应答 ------------------------------ */

function mockVideoData(): Record<string, unknown> {
  return {
    bvid: BVID,
    aid: AID,
    title: MOCK_TITLE,
    duration: DURATION,
    owner: { name: 'mock' },
    pages: [{ page: P, cid: CID, part: 'P1', duration: DURATION }],
  };
}

function mockPageHtml(): string {
  return [
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">',
    `<title>${MOCK_TITLE}_哔哩哔哩_bilibili</title></head><body>`,
    `<script>window.__INITIAL_STATE__ = ${JSON.stringify({ videoData: mockVideoData() })};</script>`,
    '</body></html>',
  ].join('');
}

function videoViewJson(): string {
  return JSON.stringify({ code: 0, message: '0', data: mockVideoData() });
}

/** 第 call 次请求用哪组应答；最后一组会一直复用。 */
function usePlayerReplies(replies: Array<() => SubtitleTrack[]>): void {
  playerCalls = 0;
  playerReply = call => {
    const index = Math.min(call, replies.length) - 1;
    return replies[index]?.() ?? replies[replies.length - 1]?.() ?? [];
  };
}

/* ------------------------------ 浏览器侧辅助 ------------------------------ */

async function ensureOptionsPage(): Promise<Page> {
  if (optionsPage && !optionsPage.isClosed()) return optionsPage;
  optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  return optionsPage;
}

/** 从设置页读当前视频 tab 的 meta：拿 tabId / aid / cid 走同一条消息链路。 */
async function readVideoPageTarget(): Promise<VideoPageTarget> {
  const options = await ensureOptionsPage();
  return (await options.evaluate(async () => {
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
    return {
      tabId: tab.id,
      bvid,
      p: part.page,
      aid: meta.aid,
      cid: part.cid,
      duration: part.duration,
    };
  })) as VideoPageTarget;
}

async function fetchSubtitleList(input: VideoPageTarget): Promise<SubtitleResult> {
  const options = await ensureOptionsPage();
  return (await options.evaluate(
    async (pageTarget: VideoPageTarget) =>
      (await chrome.runtime.sendMessage({
        type: 'subtitle:list',
        bvid: pageTarget.bvid,
        aid: pageTarget.aid,
        cid: pageTarget.cid,
        p: pageTarget.p,
        duration: pageTarget.duration,
        tabId: pageTarget.tabId,
      })) as SubtitleResult,
    input,
  )) as SubtitleResult;
}

async function generateOutlineViaMessage(
  input: VideoPageTarget,
): Promise<OutlineGenerateResponse> {
  const options = await ensureOptionsPage();
  return (await options.evaluate(
    async (pageTarget: {
      tabId: number;
      bvid: string;
      p: number;
      cid: number;
      title: string;
      duration: number;
    }) =>
      (await chrome.runtime.sendMessage({
        type: 'outline:generate',
        bvid: pageTarget.bvid,
        p: pageTarget.p,
        cid: pageTarget.cid,
        title: pageTarget.title,
        duration: pageTarget.duration,
        tabId: pageTarget.tabId,
      })) as OutlineGenerateResponse,
    {
      tabId: input.tabId,
      bvid: input.bvid,
      p: input.p,
      cid: input.cid,
      title: MOCK_TITLE,
      duration: input.duration,
    },
  )) as OutlineGenerateResponse;
}

async function readCache<T>(key: string): Promise<T | undefined> {
  const options = await ensureOptionsPage();
  return (await options.evaluate(
    async (storageKey: string) => {
      const stored = await chrome.storage.local.get(storageKey);
      return stored[storageKey] as unknown;
    },
    key,
  )) as T | undefined;
}

async function writeCache(key: string, value: unknown): Promise<void> {
  const options = await ensureOptionsPage();
  await options.evaluate(
    async (payload: { key: string; value: unknown }) => {
      await chrome.storage.local.set({ [payload.key]: payload.value });
    },
    { key, value },
  );
}

async function removeStorageKeys(keys: string[]): Promise<void> {
  const options = await ensureOptionsPage();
  await options.evaluate(async (storageKeys: string[]) => {
    await chrome.storage.local.remove(storageKeys);
  }, keys);
}

/* ------------------------------ 生命周期 ------------------------------ */

test.beforeAll(async () => {
  subtitleServer = createSubtitleServer();
  baseUrl = await subtitleServer.listen();
  context = await launchWithExtension();
  extensionId = await getExtensionId(context);
  await clearStorage(context, extensionId);

  // 视频页：直接发一份 mock HTML，避免真实网络；非视频页请求（favicon 等）返回空。
  await context.route('https://www.bilibili.com/**', async route => {
    if (route.request().url().startsWith(VIDEO_URL)) {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: mockPageHtml(),
      });
      return;
    }
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/plain' }, body: '' });
  });

  // 兜底：万一 __INITIAL_STATE__ 没读到，readVideoMeta 会退回视频信息接口，
  // 这里也 mock 掉，保证不出真实网络。
  await context.route('**/x/web-interface/view**', route =>
    route.fulfill({ status: 200, headers: API_HEADERS, body: videoViewJson() }),
  );

  // 字幕列表接口：按调用次数返回，用来断言重试链。
  await context.route('**/x/player/v2**', async route => {
    playerCalls += 1;
    const subtitles = playerReply(playerCalls);
    await route.fulfill({
      status: 200,
      headers: API_HEADERS,
      body: JSON.stringify({
        code: 0,
        message: '0',
        data: { subtitle: { need_login_subtitle: false, subtitles } },
      }),
    });
  });

  usePlayerReplies([() => [aiTrack()]]);
  videoPage = await context.newPage();
  await videoPage.goto(VIDEO_URL, { waitUntil: 'load' });
  target = await readVideoPageTarget();
});

test.afterAll(async () => {
  await context?.close();
  await subtitleServer?.close();
});

/* ------------------------------ 用例 ------------------------------ */

test('重试链：人工轨 → 空地址 AI 轨 → 有效 AI 轨，第三次拉取成功后缓存 AI 轨', async () => {
  // 第 1 次：只有人工中文字幕（不含 /prod/，过不了 AI 轨筛选）；
  // 第 2 次：有一条 ai-zh 但 subtitle_url 是空串（B 站接口偶发，hasUnfilledEntry=true）；
  // 第 3 次：可用的 AI 中文字幕（/prod/ 地址前缀和 aid/cid 对得上）。
  usePlayerReplies([
    () => [humanTrack()],
    () => [{ lan: 'ai-zh', lan_doc: 'AI 中文', subtitle_url: '' }],
    () => [aiTrack()],
  ]);
  await removeStorageKeys([SUB_CACHE_KEY]);

  const result = await fetchSubtitleList(target);

  // 不带固定 sleep：subtitle:list 的响应返回时，12 次重试链已经结束，计数稳定。
  expect(playerCalls).toBe(3);
  expect(result.ok).toBe(true);
  expect(result.cached).toBe(false);
  expect(result.track?.lan).toBe('ai-zh');
  expect(result.track?.subtitle_url).toContain(`/prod/${AID}${CID}`);
  expect(result.total).toBe(20);
  // 返回的是前 10 条，全部来自 AI 字幕（没有混进第 1 次的人工字幕）。
  const contents = (result.cues ?? []).map(cue => cue.content);
  expect(contents).toHaveLength(10);
  expect(contents.every(content => content.includes('AI 字幕'))).toBe(true);

  const cached = await readCache<SubtitleCache>(SUB_CACHE_KEY);
  expect(cached?.track.lan).toBe('ai-zh');
  expect(cached?.track.subtitle_url).toContain(`/prod/${AID}${CID}`);
  expect(cached?.cues).toHaveLength(20);
  expect(cached?.cues.every(cue => cue.content.includes('AI 字幕'))).toBe(true);
});

test('串视频地址：12 次重试后报可读错误，不落字幕缓存、也不生成大纲', async () => {
  // 每次返回的都是「别的视频」的 AI 轨：有 /prod/ 但前缀对不上 aid+cid。
  // 注意：非 /prod/ 的人工轨永远过校验，所以串视频只有 AI 轨能构造出来。
  usePlayerReplies([() => [otherVideoAiTrack()]]);
  await removeStorageKeys([SUB_CACHE_KEY, OUTLINE_KEY]);
  // 大纲用例需要 apiKey 非空：generateOutline 先查 apiKey 再查 cues，空 Key 会先报 no-key。
  await writeSettings(context, extensionId, { apiKey: 'sk-e2e-outline' });

  const list = await fetchSubtitleList(target);

  expect(playerCalls).toBe(12);
  expect(list.ok).toBe(false);
  expect(list.error).toContain('别的视频');
  expect(list.error).toContain('缓存错乱');
  expect(await readCache(SUB_CACHE_KEY)).toBeUndefined();

  const outline = await generateOutlineViaMessage(target);

  // 错误文案可读，且没写大纲缓存。字幕链路失败后大纲会再试一轮字幕（1s 等待 + 两次
  // 12 次重试），所以这里只断言「比第一次多打了请求」，不绑定具体的内部重试次数。
  expect(playerCalls).toBeGreaterThan(12);
  if (outline.ok) throw new Error('串视频地址不应该生成大纲');
  expect(outline.code).toBe('no-subtitle');
  expect(outline.message).toContain('别的视频');
  expect(await readCache(OUTLINE_KEY)).toBeUndefined();
});

test('陈旧缓存：track 指向别的视频 → 丢弃并重新拉取', async () => {
  usePlayerReplies([() => [aiTrack()]]);
  await removeStorageKeys([SUB_CACHE_KEY]);
  // 时间覆盖完整，但 AI 轨地址是另一个 cid（前缀和 aid+cid 拼接对不上）：判为不可信。
  await writeCache(SUB_CACHE_KEY, makeCache(otherVideoAiTrack(), buildCues('旧缓存')));

  const result = await fetchSubtitleList(target);

  expect(playerCalls).toBe(1);
  expect(result.ok).toBe(true);
  expect(result.cached).toBe(false);

  const cached = await readCache<SubtitleCache>(SUB_CACHE_KEY);
  expect(cached?.track.subtitle_url).toContain(`/prod/${AID}${CID}`);
  expect(cached?.cues.every(cue => cue.content.includes('AI 字幕'))).toBe(true);
});

test('陈旧缓存：只覆盖前 10 秒 → 丢弃并重新拉取', async () => {
  usePlayerReplies([() => [aiTrack()]]);
  await removeStorageKeys([SUB_CACHE_KEY]);
  // 地址合法，但字幕只到 10s，远低于 duration*0.6（360s）：coversVideoDuration 判为失效。
  await writeCache(
    SUB_CACHE_KEY,
    makeCache(aiTrack(), [{ from: 0, to: 10, content: '旧缓存只覆盖开头' }]),
  );

  const result = await fetchSubtitleList(target);

  expect(playerCalls).toBe(1);
  expect(result.ok).toBe(true);
  expect(result.cached).toBe(false);

  const cached = await readCache<SubtitleCache>(SUB_CACHE_KEY);
  expect(cached?.cues).toHaveLength(20);
  expect(cached?.cues.at(-1)?.to).toBeGreaterThanOrEqual(MIN_COVER_SECONDS);
});

test('合法缓存：一次字幕接口都不请求', async () => {
  usePlayerReplies([() => [aiTrack()]]);
  await removeStorageKeys([SUB_CACHE_KEY]);
  await writeCache(SUB_CACHE_KEY, makeCache(aiTrack(), buildCues('缓存命中字幕')));

  const result = await fetchSubtitleList(target);

  // loadSubtitles 命中缓存后直接返回，不会走到列表接口；响应返回时计数已稳定。
  expect(playerCalls).toBe(0);
  expect(result.ok).toBe(true);
  expect(result.cached).toBe(true);
  expect(result.total).toBe(20);
  expect(result.cues?.every(cue => cue.content.includes('缓存命中字幕'))).toBe(true);
});
