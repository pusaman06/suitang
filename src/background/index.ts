import type {
  SubtitleCache,
  SubtitleCue,
  SubtitleResult,
  SubtitleTrack,
  VideoMeta,
} from '../shared/types';
import { normalizeSubtitleUrl, parseSubtitleBody, pickTrack, subtitleUrlMatchesCid } from '../shared/subtitles';
import { loadSettings } from '../shared/settings';
import { buildQaPrompt } from '../shared/prompt';
import { buildOutlinePrompt } from '../shared/outline-prompt';
import {
  outlineStorageKey,
  parseOutline,
  type Outline,
  type OutlineErrorCode,
  type OutlineGenerateResponse,
  type OutlineGetResponse,
} from '../shared/outline';
import { extractCitationSeconds } from '../shared/citations';
import {
  buildCoursePayload,
  buildPagePayload,
  enqueueAndFlush,
  flushQueue,
  getSyncStatus,
  readPageRecord,
  writePageRecord,
  SYNC_ALARM_NAME,
  type CompanionQa,
  type PagePayloadInput,
} from '../shared/sync';
import {
  QA_PORT_NAME,
  type QaAskPayload,
  type QaClientMessage,
  type QaErrorInfo,
  type QaFrame,
  type QaServerMessage,
  type QaUsage,
} from '../shared/qa';
import { callDeepSeek, QaAbortError, QaError } from './deepseek';
import { captureFrame } from './frame';

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



/* ------------------------- D3：vt-qa 常驻端口 ------------------------- */

interface ActiveQa {
  requestId: string;
  controller: AbortController;
  reason: 'user' | 'superseded' | 'tab-closed';
}

const activeByTab = new Map<number, ActiveQa>();

function postToPort(port: chrome.runtime.Port, message: QaServerMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // 端口已断开（页面刷新/关闭），忽略。
  }
}

async function qaCues(tabId: number, payload: QaAskPayload): Promise<SubtitleCue[]> {
  const cacheKey = payload.cid ? `sub:${payload.bvid}:${payload.p}:${payload.cid}` : '';
  const readCache = async (): Promise<SubtitleCue[]> => {
    if (!cacheKey) return [];
    const stored = await chrome.storage.local.get(cacheKey);
    const cached = stored[cacheKey] as SubtitleCache | undefined;
    return cached?.cues ?? [];
  };

  const cached = await readCache();
  if (cached.length > 0) return cached;

  // 缓存没有就顺手抓一次（和 D2 的按钮同一条路径），抓不到就按无字幕处理。
  if (!payload.aid || !payload.cid) return [];
  try {
    await loadSubtitles(tabId, {
      bvid: payload.bvid,
      aid: payload.aid,
      cid: payload.cid,
      p: payload.p,
      duration: payload.duration,
    });
  } catch (error) {
    log('qa subtitle load failed', error);
  }
  return readCache();
}

/* ------------------------- D6：本地落盘同步 ------------------------- */

const syncedCourses = new Set<string>();

async function cachedSubtitleLang(
  bvid: string,
  p: number,
  cid: number | undefined,
): Promise<string | undefined> {
  if (!cid) return undefined;
  const key = `sub:${bvid}:${p}:${cid}`;
  const stored = await chrome.storage.local.get(key);
  const cache = stored[key] as SubtitleCache | undefined;
  const lan = cache?.track?.lan;
  return typeof lan === 'string' && lan !== '' ? lan : undefined;
}

async function syncPageSnapshot(input: PagePayloadInput): Promise<void> {
  const existing = await readPageRecord(input.bvid, input.p, input.cid);
  const cid = input.cid ?? existing?.cid;
  const owner = input.owner ?? existing?.owner ?? metaCache.get(input.bvid)?.owner;
  const subtitleLang =
    input.subtitleLang ??
    (input.cues ? await cachedSubtitleLang(input.bvid, input.p, cid) : existing?.subtitle?.lang);
  const page = buildPagePayload({
    ...existing,
    ...input,
    cid,
    owner,
    subtitle: input.subtitle ?? existing?.subtitle,
    subtitleLang,
    cues: input.cues,
    outline: input.outline ?? existing?.outline,
    qa: input.qa ?? existing?.qa,
    marks: input.marks ?? existing?.marks,
  });
  await writePageRecord(page);
  await enqueueAndFlush({
    kind: 'page',
    bvid: page.bvid,
    p: page.p,
    payload: page,
  });
}

async function syncQaPage(payload: QaAskPayload, cues: SubtitleCue[], answer: string): Promise<void> {
  const existing = await readPageRecord(payload.bvid, payload.p, payload.cid);
  const qaItem: CompanionQa = {
    at: payload.at,
    q: payload.question,
    a: answer,
    citations: extractCitationSeconds(answer, payload.duration),
    createdAt: new Date().toISOString(),
  };
  const qa = [...(existing?.qa ?? []), qaItem].slice(-50);
  await syncPageSnapshot({
    bvid: payload.bvid,
    p: payload.p,
    cid: payload.cid,
    aid: payload.aid,
    title: payload.title,
    partTitle: payload.partTitle,
    pageCount: payload.pageCount,
    duration: payload.duration,
    cues,
    qa,
  });
}

function queueCourseOnce(meta: VideoMeta): void {
  if (syncedCourses.has(meta.bvid)) return;
  syncedCourses.add(meta.bvid);
  void enqueueAndFlush({
    kind: 'course',
    bvid: meta.bvid,
    payload: buildCoursePayload(meta),
  }).catch(error => log('course sync enqueue failed', error));
}

/* ------------------------- D5：大纲 ------------------------- */

interface OutlineRequest {
  bvid: string;
  p: number;
  cid?: number;
  title: string;
  duration: number;
}

class OutlineFailure extends Error {
  constructor(
    readonly code: OutlineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OutlineFailure';
  }
}

/** 同一 tab 同一 bvid+p 的进行中任务，重复点击复用同一个 Promise。 */
const outlineJobs = new Map<string, Promise<OutlineGenerateResponse>>();

async function readOutline(bvid: string, p: number, cid?: number): Promise<Outline | null> {
  const key = outlineStorageKey(bvid, p, cid);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key] as Outline | undefined;
  if (!value || !Array.isArray(value.segments) || value.segments.length === 0) return null;
  if (value.bvid !== bvid || value.p !== p) return null;
  if (!Number.isFinite(value.duration) || value.duration <= 0) return null;
  const valid = value.segments.every(
    segment =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.start >= 0 &&
      segment.end > segment.start &&
      typeof segment.title === 'string' &&
      segment.title.trim() !== '',
  );
  return valid ? value : null;
}

/** 复用 D2 的字幕缓存；缓存没有时走 loadSubtitles，读完整 cues 而不是只给前 10 条。 */
async function outlineCues(tabId: number, request: OutlineRequest): Promise<SubtitleCue[]> {
  const cacheKey = request.cid ? `sub:${request.bvid}:${request.p}:${request.cid}` : '';
  const readCache = async (): Promise<SubtitleCue[]> => {
    if (!cacheKey) return [];
    const stored = await chrome.storage.local.get(cacheKey);
    return (stored[cacheKey] as SubtitleCache | undefined)?.cues ?? [];
  };

  const cached = await readCache();
  if (cached.length > 0) return cached;
  if (!request.cid) return [];

  const meta = await readVideoMeta(tabId);
  if (!meta?.aid) return [];
  const result = await loadSubtitles(tabId, {
    bvid: request.bvid,
    aid: meta.aid,
    cid: request.cid,
    p: request.p,
    duration: request.duration,
  });
  if (!result.ok) throw new OutlineFailure('no-subtitle', result.error ?? '该视频没有字幕');
  return readCache();
}

function outlineError(error: unknown): OutlineGenerateResponse {
  if (error instanceof OutlineFailure) {
    return { ok: false, code: error.code, message: error.message };
  }
  if (error instanceof QaError) {
    const info = error.info;
    const network =
      info.code === 'network' ||
      info.code === 'server' ||
      info.code === 'rate-limit' ||
      info.code === 'timeout';
    return { ok: false, code: network ? 'network' : 'unknown', message: info.message };
  }
  if (error instanceof QaAbortError) {
    return { ok: false, code: 'unknown', message: '大纲生成已取消' };
  }
  log('outline generate failed', error);
  return {
    ok: false,
    code: 'unknown',
    message: error instanceof Error ? error.message : '大纲生成失败',
  };
}

async function generateOutline(
  tabId: number,
  request: OutlineRequest,
): Promise<OutlineGenerateResponse> {
  try {
    const settings = await loadSettings();
    if (!settings.apiKey.trim()) {
      throw new OutlineFailure('no-key', '还没有配置 DeepSeek API Key，请到设置页填写');
    }

    const cues = await outlineCues(tabId, request);
    const prompt = buildOutlinePrompt({
      title: request.title,
      duration: request.duration,
      cues,
    });
    if (!prompt) throw new OutlineFailure('no-subtitle', '该视频没有字幕');

    let text = '';
    const result = await callDeepSeek({
      apiKey: settings.apiKey,
      baseUrl: settings.apiBaseUrl,
      model: settings.textModel,
      messages: prompt.messages,
      thinking: false,
      maxTokens: Math.min(4096, Math.max(1024, prompt.range.max * 80)),
      temperature: 0.2,
      onChunk: (kind, chunk) => {
        if (kind === 'answer') text += chunk;
      },
    });

    const raw = text.trim() !== '' ? text : result.text;
    if (raw.trim() === '') {
      throw new OutlineFailure('empty', '模型没有返回内容，请重试');
    }

    const segments = parseOutline(raw, request.duration, prompt.range);
    if (!segments) {
      log('outline raw output', raw.slice(0, 1500));
      throw new OutlineFailure('bad-output', '模型输出格式不对，请重试');
    }

    const outline: Outline = {
      bvid: request.bvid,
      p: request.p,
      cid: request.cid,
      duration: request.duration,
      segments,
      createdAt: Date.now(),
      model: settings.textModel,
    };
    await chrome.storage.local.set({ [outlineStorageKey(request.bvid, request.p, request.cid)]: outline });
    // D6：大纲成功即入队落盘；失败不影响大纲返回。
    void syncPageSnapshot({
      bvid: request.bvid,
      p: request.p,
      cid: request.cid,
      title: request.title,
      duration: request.duration,
      cues,
      outline: segments,
    }).catch(error => log('outline sync failed', error));
    return { ok: true, outline };
  } catch (error) {
    return outlineError(error);
  }
}

async function runQa(port: chrome.runtime.Port, requestId: string, payload: QaAskPayload): Promise<void> {
  const tabId = port.sender?.tab?.id;
  if (tabId === undefined) {
    postToPort(port, {
      v: 1,
      type: 'qa:error',
      requestId,
      error: { code: 'no-cid', message: '找不到当前标签页', retryable: false },
    });
    return;
  }

  // 同一 tab 只保留一个活动请求，新的顶掉旧的。
  const previous = activeByTab.get(tabId);
  if (previous) {
    previous.reason = 'superseded';
    previous.controller.abort();
  }
  const active: ActiveQa = { requestId, controller: new AbortController(), reason: 'user' };
  activeByTab.set(tabId, active);
  const controller = active.controller;
  let text = '';
  let reasoning = '';

  try {
    const settings = await loadSettings();
    if (!settings.apiKey.trim()) {
      postToPort(port, {
        v: 1,
        type: 'qa:error',
        requestId,
        error: { code: 'no-key', message: '还没有配置 DeepSeek API Key，请到设置页填写', retryable: false },
      });
      return;
    }

    // 截图失败（权限/全屏/headless 黑图）不能让整个提问挂掉：降级成纯文本。
    // 放在字幕加载之前：截图要贴近暂停瞬间，别等几秒字幕拉取完画面已经变了。
    let frame: QaFrame | undefined;
    let frameError: string | undefined;
    if (settings.frameEnabled && payload.rect && payload.viewport) {
      // content 正常不带图；带了就直接用，省一次截图。
      frame = payload.frame;
      if (!frame) {
        try {
          frame = await captureFrame(
            port.sender?.tab?.windowId,
            payload.rect,
            payload.viewport,
            payload.at,
          );
        } catch (error) {
          frameError = error instanceof Error ? error.message : String(error);
          log('qa frame capture failed', frameError);
        }
      }
      if (controller.signal.aborted) {
        postToPort(port, { v: 1, type: 'qa:aborted', requestId, text, reason: active.reason });
        return;
      }
    }

    const cues = await qaCues(tabId, payload);
    if (controller.signal.aborted) {
      postToPort(port, { v: 1, type: 'qa:aborted', requestId, text, reason: active.reason });
      return;
    }

    const model = frame ? settings.visionModel : settings.textModel;

    const prompt = buildQaPrompt({
      title: payload.title,
      partTitle: payload.partTitle,
      pageCount: payload.pageCount,
      duration: payload.duration,
      at: payload.at,
      question: payload.question,
      cues,
      windowSec: settings.contextWindowSec,
      maxInputTokens: 3500,
      historyTurns: 0,
      frame: frame ? { dataUrl: frame.dataUrl } : undefined,
    });

    postToPort(port, {
      v: 1,
      type: 'qa:start',
      requestId,
      model,
      window: { ...prompt.window, hasFrame: Boolean(frame), frameError },
    });

    if (controller.signal.aborted) {
      postToPort(port, { v: 1, type: 'qa:aborted', requestId, text, reason: active.reason });
      return;
    }

    const startedAt = Date.now();
    const result = await callDeepSeek({
      apiKey: settings.apiKey,
      baseUrl: settings.apiBaseUrl,
      model,
      messages: prompt.messages,
      thinking: settings.thinking,
      maxTokens: settings.maxTokens,
      temperature: 0.3,
      signal: controller.signal,
      onChunk: (kind, chunk) => {
        if (kind === 'answer') text += chunk;
        else reasoning += chunk;
        postToPort(port, { v: 1, type: 'qa:chunk', requestId, kind, text: chunk });
      },
    });

    text = result.text;
    reasoning = result.reasoning;
    const usage: QaUsage = result.usage;

    if (text.trim() === '') {
      postToPort(port, {
        v: 1,
        type: 'qa:error',
        requestId,
        error: { code: 'empty', message: '模型没有返回内容，请重试', retryable: true },
      });
      return;
    }

    postToPort(port, {
      v: 1,
      type: 'qa:done',
      requestId,
      text,
      reasoning,
      citations: extractCitationSeconds(text, payload.duration),
      usage,
      finishReason: result.finishReason,
      elapsedMs: Date.now() - startedAt,
      // 切片 1 不落库；等 qaStore 落地后这里换成记录 id。
      recordId: '',
    });

    // D6：问答完成即入队，失败只写 lastError，不影响回答。
    void syncQaPage(payload, cues, text).catch(error => log('qa sync failed', error));
  } catch (error) {
    if (error instanceof QaAbortError) {
      postToPort(port, { v: 1, type: 'qa:aborted', requestId, text, reason: active.reason });
    } else if (error instanceof QaError) {
      postToPort(port, { v: 1, type: 'qa:error', requestId, error: error.info });
    } else {
      const info: QaErrorInfo = {
        code: 'unknown',
        message: error instanceof Error ? error.message : '未知错误',
        retryable: true,
      };
      postToPort(port, { v: 1, type: 'qa:error', requestId, error: info });
    }
  } finally {
    if (activeByTab.get(tabId) === active) activeByTab.delete(tabId);
  }
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== QA_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;

  port.onMessage.addListener(message => {
    const msg = message as QaClientMessage;
    if (!msg || msg.v !== 1) return;

    if (msg.type === 'qa:ping') {
      postToPort(port, { v: 1, type: 'qa:pong', at: Date.now() });
      return;
    }

    if (msg.type === 'qa:abort') {
      const active = tabId !== undefined ? activeByTab.get(tabId) : undefined;
      if (active && active.requestId === msg.requestId) {
        active.reason = 'user';
        active.controller.abort();
      }
      return;
    }

    if (msg.type === 'qa:ask') {
      const payload = msg.payload;
      if (!payload || typeof payload.question !== 'string' || payload.question.trim() === '') {
        postToPort(port, {
          v: 1,
          type: 'qa:error',
          requestId: msg.requestId,
          error: { code: 'bad-request', message: '问题不能为空', retryable: false },
        });
        return;
      }
      void runQa(port, msg.requestId, payload);
    }
  });

  port.onDisconnect.addListener(() => {
    const active = tabId !== undefined ? activeByTab.get(tabId) : undefined;
    if (active) {
      active.reason = 'tab-closed';
      active.controller.abort();
    }
    void chrome.runtime.lastError;
  });
});

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
      queueCourseOnce(cached);
      sendResponse(cached);
      return false;
    }
    // 设置页本身也是一个标签页，sender.tab 会指向设置页；显式 tabId 优先。
    const tabId =
      typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (tabId === undefined) {
      sendResponse(null);
      return false;
    }
    void readVideoMeta(tabId).then(meta => {
      if (meta) queueCourseOnce(meta);
      sendResponse(meta);
    });
    return true;
  }

  if (message?.type === 'subtitle:list') {
    // 设置页的诊断按钮没有视频页上下文，消息里显式带 tabId；它优先于 sender.tab
    // （否则会指向设置页自己，executeScript 会因扩展页不可注入而失败）。
    const tabId =
      typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
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

  if (message?.type === 'outline:get') {
    const bvid = typeof message.bvid === 'string' ? message.bvid : '';
    const p =
      typeof message.p === 'number' && message.p >= 1 ? Math.floor(message.p) : 0;
    const cid =
      typeof message.cid === 'number' && message.cid > 0
        ? message.cid
        : undefined;
    if (!bvid || !p) {
      sendResponse({
        ok: false,
        code: 'unknown',
        message: '缺少 bvid/p',
      } satisfies OutlineGetResponse);
      return false;
    }
    void readOutline(bvid, p, cid)
      .then(outline => sendResponse({ ok: true, outline } satisfies OutlineGetResponse))
      .catch(error =>
        sendResponse({
          ok: false,
          code: 'unknown',
          message: error instanceof Error ? error.message : '读取大纲失败',
        } satisfies OutlineGetResponse),
      );
    return true;
  }

  if (message?.type === 'outline:generate') {
    const bvid = typeof message.bvid === 'string' ? message.bvid : '';
    const p =
      typeof message.p === 'number' && message.p >= 1 ? Math.floor(message.p) : 0;
    const cid =
      typeof message.cid === 'number' && message.cid > 0
        ? message.cid
        : undefined;
    const title = typeof message.title === 'string' ? message.title.trim() : '';
    const duration =
      typeof message.duration === 'number' && Number.isFinite(message.duration)
        ? message.duration
        : 0;
    const tabId =
      typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (!bvid || !p || !title || duration <= 0) {
      sendResponse({
        ok: false,
        code: 'unknown',
        message: '缺少 bvid/p/title/duration',
      } satisfies OutlineGenerateResponse);
      return false;
    }
    if (tabId === undefined) {
      sendResponse({
        ok: false,
        code: 'unknown',
        message: '找不到当前标签页',
      } satisfies OutlineGenerateResponse);
      return false;
    }

    const request: OutlineRequest = { bvid, p, cid, title, duration };
    const jobKey = `${tabId}:${bvid}:${p}`;
    let job = outlineJobs.get(jobKey);
    if (!job) {
      job = generateOutline(tabId, request);
      outlineJobs.set(jobKey, job);
    }
    const pending = job;
    void pending
      .then(response => {
        if (outlineJobs.get(jobKey) === pending) outlineJobs.delete(jobKey);
        sendResponse(response);
      })
      .catch(error => {
        if (outlineJobs.get(jobKey) === pending) outlineJobs.delete(jobKey);
        sendResponse({
          ok: false,
          code: 'unknown',
          message: error instanceof Error ? error.message : '大纲生成失败',
        } satisfies OutlineGenerateResponse);
      });
    return true;
  }

  if (message?.type === 'sync:status') {
    void getSyncStatus()
      .then(status => sendResponse(status))
      .catch(error =>
        sendResponse({
          enabled: false,
          url: '',
          pending: 0,
          failed: 0,
          lastError: error instanceof Error ? error.message : '读取同步状态失败',
        }),
      );
    return true;
  }

  if (message?.type === 'sync:flush') {
    void flushQueue()
      .then(status => sendResponse({ ok: true, status }))
      .catch(error =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : '同步失败',
        }),
      );
    return true;
  }

  return false;
});

chrome.alarms.create(SYNC_ALARM_NAME, { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== SYNC_ALARM_NAME) return;
  void flushQueue().catch(error => log('sync alarm flush failed', error));
});
chrome.runtime.onStartup.addListener(() => {
  void flushQueue().catch(error => log('sync startup flush failed', error));
});
// service worker 每次唤醒也补一次；失败只记录，不打扰页面。
void flushQueue().catch(error => log('sync initial flush failed', error));

function sendToTab(tabId: number, message: unknown): void {
  chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
}
