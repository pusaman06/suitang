import type {
  SubtitleCache,
  SubtitleCue,
  SubtitleResult,
  SubtitleTrack,
  VideoMeta,
} from '../shared/types';
import { normalizeSubtitleUrl, parseSubtitleBody, pickTrack, subtitleUrlMatchesCid } from '../shared/subtitles';

const log = (...args: unknown[]) => console.log('[video-tutor]', ...args);

const metaCache = new Map<string, VideoMeta>();

async function readVideoMeta(tabId: number): Promise<VideoMeta | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const [injection] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          interface Page {
            page: number;
            cid: number;
            part: string;
            duration: number;
          }
          const state = (window as unknown as {
            __INITIAL_STATE__?: {
              p?: number;
              videoData?: {
                bvid?: string;
                aid?: number;
                title?: string;
                duration?: number;
                owner?: { name?: string };
                pages?: Page[];
              };
            };
          }).__INITIAL_STATE__;
          const video = state?.videoData;
          if (!video?.bvid) return null;
          const pages = (video.pages ?? []).map(page => ({
            page: page.page,
            cid: page.cid,
            part: page.part,
            duration: page.duration,
          }));
          return {
            bvid: video.bvid,
            aid: video.aid,
            title: video.title ?? document.title,
            owner: video.owner?.name,
            duration: video.duration,
            pages,
          };
        },
      });

      const meta = injection?.result as VideoMeta | null;
      if (meta?.pages?.length) {
        metaCache.set(meta.bvid, meta);
        return meta;
      }
    } catch {
      // 页面还没准备好时继续重试。
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return null;
}

interface PageFetch {
  status: number;
  text: string;
  error?: string;
}

/** 字幕至少要覆盖视频的大部分时长；只覆盖开头一小段的，基本是接口串了别的视频。 */
function coversVideoDuration(cues: SubtitleCue[], duration?: number): boolean {
  if (!duration || cues.length === 0) return true;
  const last = cues[cues.length - 1].to;
  return last >= duration * 0.6 && last <= duration + 60;
}

interface PlayerV2Response {
  code?: number;
  message?: string;
  data?: {
    subtitle?: {
      need_login_subtitle?: boolean;
      subtitles?: Array<{
        lan?: string;
        lan_doc?: string;
        subtitle_url?: string;
      }>;
    };
  };
}

/**
 * 字幕列表接口只能在页面主世界（www.bilibili.com）里 fetch：
 * 它要页面 Origin/Referer，扩展自己的 Origin 直连会被 412。
 */
async function fetchTextInPage(tabId: number, url: string): Promise<PageFetch> {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (target: string) => {
      try {
        const response = await fetch(target, { credentials: 'include' });
        return { status: response.status, text: await response.text() };
      } catch (error) {
        return { status: 0, text: '', error: String(error) };
      }
    },
    args: [url],
  });
  return (injection?.result as PageFetch | undefined) ?? {
    status: 0,
    text: '',
    error: '页面没有返回结果',
  };
}

/**
 * 字幕文件（aisubtitle.hdslb.com）反过来：页面主世界和内容脚本世界都会被 CORS
 * 挡住（Failed to fetch），扩展背景页带 <all_urls> 主机权限直连才 200。
 */
async function fetchSubtitleBody(raw: string): Promise<PageFetch> {
  const normalized = normalizeSubtitleUrl(raw);
  const candidates = [normalized];
  if (raw !== normalized && /^https?:\/\//i.test(raw)) candidates.push(raw);

  let last: PageFetch = { status: 0, text: '', error: '没有可用的字幕地址' };
  for (const candidate of candidates) {
    last = await fetchTextDirect(candidate);
    if (last.status === 200) return last;
  }
  return last;
}

async function fetchTextDirect(url: string): Promise<PageFetch> {
  let host = url;
  try {
    const parsed = new URL(url);
    host = `${parsed.host}${parsed.pathname.slice(0, 60)}`;
  } catch {
    // 保留原始串，方便报错。
  }

  let lastError = '';
  const attempts: Array<[string, RequestInit]> = [
    ['include', { credentials: 'include' }],
    ['omit', { credentials: 'omit' }],
    ['no-store', { cache: 'no-store' }],
  ];
  for (const [label, init] of attempts) {
    try {
      const response = await fetch(url, init);
      if (response.ok) return { status: response.status, text: await response.text() };
      lastError = `HTTP ${response.status} (${label})`;
    } catch (error) {
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      lastError = `${detail} (${label})`;
    }
  }
  return { status: 0, text: '', error: `${lastError} @ ${host}` };
}

async function loadSubtitles(
  tabId: number,
  request: { bvid: string; aid?: number; cid?: number; p: number; duration?: number },
): Promise<SubtitleResult> {
  const { bvid, aid, cid, p, duration } = request;
  if (!aid || !cid) return { ok: false, error: '缺少 aid/cid，请等页面元数据加载完再试' };

  const cacheKey = `sub:${bvid}:${p}:${cid}`;
  const stored = await chrome.storage.local.get(cacheKey);
  const cached = stored[cacheKey] as SubtitleCache | undefined;
  if (
    cached?.cues?.length &&
    subtitleUrlMatchesCid(cached.track.subtitle_url, aid, cid) &&
    coversVideoDuration(cached.cues, duration)
  ) {
    return {
      ok: true,
      cached: true,
      track: cached.track,
      total: cached.total,
      cues: cached.cues.slice(0, 10),
    };
  }

  const listUrl = `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}&bvid=${bvid}`;
  let tracks: SubtitleTrack[] = [];
  let humanTracks: SubtitleTrack[] = [];
  let needLogin = false;
  let hasUnfilledEntry = false;
  let hasMismatch = false;

  // 这个接口会随机把 subtitle_url 返回成空串，也会偶发返回别的视频的地址
  // （内容完全对不上，AI/人工字幕都中过招）；都隔 300ms 重试，优先等可校验的 AI 字幕。
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 300));

    const listFetch = await fetchTextInPage(tabId, listUrl);
    if (listFetch.error) {
      return { ok: false, error: `字幕列表请求失败：${listFetch.error}` };
    }
    if (listFetch.status !== 200) {
      return { ok: false, error: `字幕列表 HTTP ${listFetch.status}` };
    }

    let list: PlayerV2Response;
    try {
      list = JSON.parse(listFetch.text) as PlayerV2Response;
    } catch {
      return { ok: false, error: '字幕列表不是合法 JSON' };
    }
    if (list.code !== 0) {
      return { ok: false, error: `字幕接口 ${list.code}：${list.message ?? '未知错误'}` };
    }

    const subtitle = list.data?.subtitle;
    const raw = subtitle?.subtitles ?? [];
    needLogin = needLogin || Boolean(subtitle?.need_login_subtitle);
    hasUnfilledEntry = raw.some(item => Boolean(item.lan) && !item.subtitle_url);
    const fetched = raw
      .filter(item => typeof item.subtitle_url === 'string' && item.subtitle_url.length > 0)
      .map(item => ({
        lan: item.lan ?? '',
        lan_doc: item.lan_doc ?? '',
        subtitle_url: item.subtitle_url as string,
      }));
    const valid = fetched.filter(item => subtitleUrlMatchesCid(item.subtitle_url, aid, cid));
    humanTracks = valid.filter(item => !item.subtitle_url.includes('/prod/'));
    tracks = valid.filter(item => item.subtitle_url.includes('/prod/'));
    hasMismatch = fetched.length > 0 && valid.length === 0;

    // 有可校验的 AI 字幕就收工；只有人工字幕时继续重试，等 AI 字幕；
    // 接口明确返回空列表时不用再等。
    if (tracks.length > 0 || (fetched.length === 0 && !hasUnfilledEntry)) break;
  }

  if (tracks.length === 0) tracks = humanTracks;

  if (tracks.length === 0) {
    if (hasMismatch) {
      return { ok: false, error: '字幕接口返回了别的视频的字幕地址（B 站接口缓存错乱），请重试' };
    }
    return {
      ok: false,
      needLogin,
      error: needLogin ? '没有可用字幕：需要登录 B 站' : '该视频没有字幕',
    };
  }

  const track = pickTrack(tracks);
  if (!track) return { ok: false, error: '没有可用字幕轨道' };

  const bodyFetch = await fetchSubtitleBody(track.subtitle_url);
  if (bodyFetch.error) return { ok: false, error: `字幕文件请求失败：${bodyFetch.error}` };
  if (bodyFetch.status !== 200) return { ok: false, error: `字幕文件 HTTP ${bodyFetch.status}` };

  let cues: SubtitleCue[];
  try {
    cues = parseSubtitleBody(bodyFetch.text);
  } catch {
    return { ok: false, error: '字幕文件不是合法 JSON' };
  }
  if (cues.length === 0) return { ok: false, error: '字幕文件里没有有效句子' };
  if (!coversVideoDuration(cues, duration)) {
    return { ok: false, error: '字幕内容和视频时长对不上（B 站接口缓存错乱），请重试' };
  }

  const cache: SubtitleCache = {
    bvid,
    p,
    cid,
    fetchedAt: Date.now(),
    track,
    total: cues.length,
    cues,
  };
  await chrome.storage.local.set({ [cacheKey]: cache });

  return {
    ok: true,
    cached: false,
    track,
    total: cues.length,
    cues: cues.slice(0, 10),
  };
}



chrome.runtime.onInstalled.addListener(() => log('installed'));

chrome.action.onClicked.addListener(tab => {
  if (tab.id !== undefined) sendToTab(tab.id, { type: 'toggle-panel' });
});

chrome.commands.onCommand.addListener(command => {
  if (command !== 'ask') return;
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tabId = tabs[0]?.id;
    if (tabId !== undefined) sendToTab(tabId, { type: 'toggle-panel' });
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ping') {
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      at: Date.now(),
    });
    return true;
  }

  if (message?.type === 'video-meta' && typeof message.bvid === 'string') {
    const cached = metaCache.get(message.bvid);
    if (cached) {
      sendResponse(cached);
      return false;
    }
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse(null);
      return false;
    }
    void readVideoMeta(tabId).then(meta => sendResponse(meta));
    return true;
  }

  if (message?.type === 'subtitle:list') {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ ok: false, error: '找不到当前标签页' } satisfies SubtitleResult);
      return false;
    }
    const bvid = typeof message.bvid === 'string' ? message.bvid : '';
    const aid = typeof message.aid === 'number' ? message.aid : undefined;
    const cid = typeof message.cid === 'number' ? message.cid : undefined;
    const p =
      typeof message.p === 'number' && message.p >= 1 ? Math.floor(message.p) : 1;
    const duration =
      typeof message.duration === 'number' && message.duration > 0
        ? message.duration
        : undefined;
    if (!bvid || !aid || !cid) {
      sendResponse({ ok: false, error: '缺少 bvid/aid/cid' } satisfies SubtitleResult);
      return false;
    }
    void loadSubtitles(tabId, { bvid, aid, cid, p, duration })
      .then(result => sendResponse(result))
      .catch(error =>
        sendResponse({ ok: false, error: String(error) } satisfies SubtitleResult),
      );
    return true;
  }

  return false;
});

function sendToTab(tabId: number, message: unknown): void {
  chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
}
