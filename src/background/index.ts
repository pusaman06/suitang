import type {
  SubtitleCache,
  SubtitleCue,
  SubtitleResult,
  SubtitleTrack,
  VideoInfo,
  VideoMeta,
} from '../shared/types';
import { normalizeSubtitleUrl, parseSubtitleBody, pickTrack, subtitleUrlMatchesCid } from '../shared/subtitles';
import { loadSettings, type Settings } from '../shared/settings';
import { buildQaPrompt, isGlobalQuestion } from '../shared/prompt';
import { buildFrameOutlinePrompt, buildOutlinePrompt } from '../shared/outline-prompt';
import {
  coalesceSegments,
  framesToSegments,
  outlineStorageKey,
  parseFrameTitles,
  parseOutline,
  type Outline,
  type OutlineErrorCode,
  type OutlineGenerateResponse,
  type OutlineGetResponse,
  type OutlineSegment,
} from '../shared/outline';
import {
  buildKbMarkdown,
  buildKbSummaryPrompt,
  kbFileName,
  parseKbSummary,
  type KbQaPair,
} from '../shared/kb';
import { extractCitationSeconds } from '../shared/citations';
import {
  buildCoursePayload,
  buildPagePayload,
  clearFailed,
  enqueueAndFlush,
  flushQueue,
  getSyncStatus,
  readPageRecord,
  retryFailed,
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
  type QaRect,
  type QaServerMessage,
  type QaViewport,
  type QaUsage,
} from '../shared/qa';
import { callDeepSeek, QaAbortError, QaError } from './deepseek';
import { captureFrame } from './frame';
import {
  ASR_MAX_AUDIO_BYTES,
  ASR_MAX_AUDIO_SECONDS,
  ASR_REFERER_RULE_ID,
  AsrFailure,
  downloadAudio,
  getAudioTrack,
  transcribeAudio,
} from './asr';
import {
  ASR_SCHEMA,
  asrStorageKey,
  mergeAsrSegments,
  splitIntoSentences,
  type AsrError,
  type AsrErrorCode,
  type AsrProgress,
  type AsrResult,
  type AsrTranscribeResponse,
} from '../shared/asr';
import { appendQaRecord, clearQaStore, readQaStore } from '../shared/qa-store';
import { estimateCostCny } from '../shared/cost';
import { readLedger, recordUsage } from '../shared/usage-store';

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

/**
 * 追问用的最近几轮问答现在存在 qaStore（`qa:<bvid>:<p>`）里，
 * service worker 重启、页面刷新都不会丢。
 */

function postToPort(port: chrome.runtime.Port, message: QaServerMessage): void {
  try {
    port.postMessage(message);
  } catch {
    // 端口已断开（页面刷新/关闭），忽略。
  }
}

/** 全局问题才需要：读已生成的大纲，给模型一个全片骨架。读不到就返回 undefined。 */
async function outlineForQuestion(payload: QaAskPayload): Promise<Outline['segments'] | undefined> {
  try {
    const key = outlineStorageKey(payload.bvid, payload.p, payload.cid);
    const stored = await chrome.storage.local.get(key);
    const record = stored[key] as Outline | undefined;
    return record?.segments && record.segments.length > 0 ? record.segments : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------- D8：ASR 兜底 ------------------------- */

interface AsrRequest {
  bvid: string;
  p: number;
  cid?: number;
  title?: string;
  duration?: number;
}

const asrJobs = new Map<string, Promise<AsrResult>>();

function asrCues(result: AsrResult): SubtitleCue[] {
  return result.segments.map(segment => ({
    from: segment.start,
    to: segment.end,
    content: segment.text,
  }));
}

async function readAsrResult(bvid: string, p: number, cid?: number): Promise<AsrResult | null> {
  if (!cid) return null;
  const key = asrStorageKey(bvid, p, cid);
  const stored = await chrome.storage.local.get(key);
  const record = stored[key] as (AsrResult & { schema?: number }) | undefined;
  if (!record || !Array.isArray(record.segments) || record.segments.length === 0) return null;
  if (record.bvid !== bvid || record.p !== p || record.cid !== cid) return null;
  if (record.schema !== undefined && record.schema !== ASR_SCHEMA) return null;
  const valid = record.segments.every(
    segment =>
      Number.isFinite(segment.start) &&
      Number.isFinite(segment.end) &&
      segment.end > segment.start &&
      typeof segment.text === 'string' &&
      segment.text.trim() !== '',
  );
  return valid ? record : null;
}

function sendAsrProgress(tabId: number, request: AsrRequest, progress: AsrProgress): void {
  sendToTab(tabId, {
    type: 'asr:progress',
    bvid: request.bvid,
    p: request.p,
    cid: request.cid,
    ...progress,
  });
}

function asrError(error: unknown): AsrError {
  if (error instanceof AsrFailure) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'unknown' as AsrErrorCode,
    message: error instanceof Error ? error.message : '转写失败',
  };
}

async function transcribeAsr(tabId: number, request: AsrRequest): Promise<AsrResult> {
  const settings = await loadSettings();
  if (!settings.asrApiKey.trim()) {
    throw new AsrFailure(
      'no-key',
      '还没有配置语音转写 Key，请到设置页填写（支持 SiliconFlow）',
    );
  }

  const meta = await readVideoMeta(tabId);
  if (!meta?.aid) throw new AsrFailure('no-audio', '读取不到视频信息');
  const page = meta.pages.find(item => item.page === request.p) ?? meta.pages[request.p - 1];
  const cid = request.cid ?? page?.cid;
  if (!cid) throw new AsrFailure('no-audio', '读取不到当前分 P 的 cid');
  const duration =
    request.duration && request.duration > 0
      ? request.duration
      : page?.duration ?? meta.duration;
  if (!duration || duration <= 0) throw new AsrFailure('unknown', '读取不到视频时长');

  const cached = await readAsrResult(request.bvid, request.p, cid);
  if (cached) return cached;

  const track = await getAudioTrack(tabId, meta.aid, cid, request.bvid);
  sendAsrProgress(tabId, { ...request, cid }, { stage: 'download', done: 0, total: 1 });
  const buffer = await downloadAudio(track.url);
  sendAsrProgress(tabId, { ...request, cid }, { stage: 'download', done: 1, total: 1 });

  if (buffer.byteLength > ASR_MAX_AUDIO_BYTES || duration > ASR_MAX_AUDIO_SECONDS) {
    throw new AsrFailure(
      'too-long',
      '这段音频太长，暂不支持整段转写（A 路径上限约 45MB / 1 小时）',
    );
  }

  sendAsrProgress(tabId, { ...request, cid }, { stage: 'transcribe', done: 0, total: 1 });
  const text = await transcribeAudio(
    buffer,
    settings.asrApiKey,
    settings.asrBaseUrl,
    settings.asrModel,
  );
  sendAsrProgress(tabId, { ...request, cid }, { stage: 'transcribe', done: 1, total: 1 });

  const segments = mergeAsrSegments(splitIntoSentences(text, 0, duration));
  if (segments.length === 0) {
    throw new AsrFailure('empty', '转写结果为空，请重试');
  }

  const result: AsrResult = {
    bvid: request.bvid,
    p: request.p,
    cid,
    duration,
    segments,
    model: settings.asrModel,
    createdAt: Date.now(),
  };
  await chrome.storage.local.set({
    [asrStorageKey(request.bvid, request.p, cid)]: { schema: ASR_SCHEMA, ...result },
  });
  return result;
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
  const afterLoad = await readCache();
  if (afterLoad.length > 0) return afterLoad;

  // 无字幕视频：如果用户已经转写过，就用 ASR 字幕回答。
  const asr = await readAsrResult(payload.bvid, payload.p, payload.cid);
  return asr ? asrCues(asr) : [];
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
  /** 无字幕兜底：content 已按时间抽好的截图；有值时直接走视觉分支。 */
  frames?: QaFrame[];
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

type ViewPoint = { from: number; to: number; content: string };

/** B 站 UP 手标章节（x/player/v2 的 view_points），无字幕视频的兜底大纲来源。 */
async function fetchViewPoints(
  tabId: number,
  aid: number,
  cid: number,
  bvid: string,
): Promise<ViewPoint[]> {
  const url = `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}&bvid=${bvid}`;
  const response = await fetchTextInPage(tabId, url);
  if (response.error || response.status !== 200) return [];
  try {
    const parsed = JSON.parse(response.text) as {
      code?: number;
      data?: { view_points?: ViewPoint[] };
    };
    if (parsed.code !== 0) return [];
    return (parsed.data?.view_points ?? []).filter(
      item => Number.isFinite(item.from) && Number.isFinite(item.to) && item.to > item.from,
    );
  } catch {
    return [];
  }
}

function chaptersToSegments(points: ViewPoint[], duration?: number): OutlineSegment[] {
  const total = duration && duration > 0 ? duration : (points[points.length - 1]?.to ?? 0);
  const segments = points
    .map(item => ({
      start: Math.max(0, Math.floor(item.from)),
      end: Math.ceil(item.to),
      title: item.content.trim(),
    }))
    .filter(item => item.title !== '' && item.end > item.start)
    .sort((a, b) => a.start - b.start);
  if (segments.length === 0) return [];

  segments[0].start = 0;
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].start > segments[index - 1].end) {
      segments[index - 1].end = segments[index].start;
    }
  }
  if (total > 0) segments[segments.length - 1].end = total;
  return coalesceSegments(segments, 15);
}

/** 只接受 content 抓帧链路产出的 JPEG dataURL，防止任意大图/坏数据进模型。 */
function isQaFrame(value: unknown): value is QaFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Partial<QaFrame>;
  return (
    typeof frame.dataUrl === 'string' &&
    frame.dataUrl.startsWith('data:image/jpeg;base64,') &&
    typeof frame.width === 'number' &&
    Number.isFinite(frame.width) &&
    frame.width > 0 &&
    typeof frame.height === 'number' &&
    Number.isFinite(frame.height) &&
    frame.height > 0 &&
    typeof frame.at === 'number' &&
    Number.isFinite(frame.at)
  );
}

function readOutlineFrames(value: unknown): QaFrame[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isQaFrame).slice(0, 10);
}

function readKbInfo(value: unknown): VideoInfo | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const bvid = typeof raw.bvid === 'string' ? raw.bvid.trim() : '';
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const p = typeof raw.p === 'number' && raw.p >= 1 ? Math.floor(raw.p) : 0;
  if (bvid === '' || title === '' || p === 0) return null;
  return {
    bvid,
    title,
    p,
    aid: typeof raw.aid === 'number' ? raw.aid : undefined,
    cid: typeof raw.cid === 'number' ? raw.cid : undefined,
    partTitle: typeof raw.partTitle === 'string' ? raw.partTitle : undefined,
    owner: typeof raw.owner === 'string' ? raw.owner : undefined,
    duration: typeof raw.duration === 'number' && raw.duration > 0 ? raw.duration : undefined,
    pageCount: typeof raw.pageCount === 'number' ? raw.pageCount : undefined,
  };
}

function readKbSegments(value: unknown): OutlineSegment[] {
  if (!Array.isArray(value)) return [];
  const out: OutlineSegment[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const start = typeof raw.start === 'number' ? raw.start : Number.NaN;
    const end = typeof raw.end === 'number' ? raw.end : Number.NaN;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    if (!Number.isFinite(start) || !Number.isFinite(end) || title === '') continue;
    out.push({ start, end, title });
  }
  return out;
}

function readKbQa(value: unknown): KbQaPair[] {
  if (!Array.isArray(value)) return [];
  const out: KbQaPair[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    const answer = typeof raw.answer === 'string' ? raw.answer.trim() : '';
    if (question === '' || answer === '') continue;
    out.push({ question, answer });
  }
  return out;
}

function readCaptureRect(value: unknown): QaRect | null {
  if (!value || typeof value !== 'object') return null;
  const rect = value as Partial<QaRect>;
  if (
    typeof rect.x !== 'number' ||
    typeof rect.y !== 'number' ||
    typeof rect.width !== 'number' ||
    typeof rect.height !== 'number' ||
    !Number.isFinite(rect.x) ||
    !Number.isFinite(rect.y) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function readCaptureViewport(value: unknown): QaViewport | null {
  if (!value || typeof value !== 'object') return null;
  const viewport = value as Partial<QaViewport>;
  if (
    typeof viewport.width !== 'number' ||
    typeof viewport.height !== 'number' ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return null;
  }
  return { width: viewport.width, height: viewport.height };
}

/** 无字幕兜底：全部截图一次请求视觉模型，再走和文本大纲相同的解析/缓存。 */
async function generateFrameOutline(
  settings: Settings,
  request: OutlineRequest,
  frames: QaFrame[],
): Promise<Outline> {
  const prompt = buildFrameOutlinePrompt({
    title: request.title,
    duration: request.duration,
    frames,
  });
  if (!prompt) throw new OutlineFailure('no-subtitle', '该视频没有字幕');

  let text = '';
  const startedAt = Date.now();
  const result = await callDeepSeek({
    apiKey: settings.apiKey,
    baseUrl: settings.apiBaseUrl,
    model: settings.visionModel,
    messages: prompt.messages,
    thinking: false,
    maxTokens: Math.min(2048, Math.max(512, frames.length * 60)),
    temperature: 0.2,
    onChunk: (kind, chunk) => {
      if (kind === 'answer') text += chunk;
    },
  });
  // 抽帧大纲也是一次 DeepSeek 调用，成功即记一笔；记账失败不影响大纲。
  await recordUsage(estimateCostCny(result.usage, startedAt), startedAt).catch(error =>
    log('frame outline usage failed', error),
  );

  const raw = text.trim() !== '' ? text : result.text;
  if (raw.trim() === '') {
    throw new OutlineFailure('empty', '模型没有返回内容，请重试');
  }

  // 只信模型给的标题；时间戳由帧时间算，避免整份大纲错位一个帧间隔。
  const times = frames
    .filter(frame => Number.isFinite(frame.at))
    .map(frame => frame.at);
  const titles = parseFrameTitles(raw, times.length);
  if (!titles) {
    log('frame outline raw output', raw.slice(0, 1500));
    throw new OutlineFailure('bad-output', '模型输出格式不对，请重试');
  }

  const segments = framesToSegments(times, titles, request.duration);
  if (segments.length === 0) {
    throw new OutlineFailure('bad-output', '模型输出格式不对，请重试');
  }

  const outline: Outline = {
    bvid: request.bvid,
    p: request.p,
    cid: request.cid,
    duration: request.duration,
    segments,
    createdAt: Date.now(),
    model: 'frames-vision',
  };
  await chrome.storage.local.set({
    [outlineStorageKey(request.bvid, request.p, request.cid)]: outline,
  });
  void syncPageSnapshot({
    bvid: request.bvid,
    p: request.p,
    cid: request.cid,
    title: request.title,
    duration: request.duration,
    cues: [],
    outline: segments,
  }).catch(error => log('outline sync failed', error));
  return outline;
}

async function generateOutline(
  tabId: number,
  request: OutlineRequest,
): Promise<OutlineGenerateResponse> {
  try {
    const settings = await loadSettings();

    // 视觉兜底：content 已经抽好帧，不再碰字幕/章节，直接一次视觉请求。
    const frames = request.frames ?? [];
    if (frames.length > 0) {
      if (!settings.apiKey.trim()) {
        throw new OutlineFailure('no-key', '还没有配置 DeepSeek API Key，请到设置页填写');
      }
      return { ok: true, outline: await generateFrameOutline(settings, request, frames) };
    }

    let cues: SubtitleCue[] = [];
    let chapters: OutlineSegment[] = [];
    try {
      cues = await outlineCues(tabId, request);
    } catch (error) {
      if (!(error instanceof OutlineFailure) || error.code !== 'no-subtitle') throw error;
      const meta = await readVideoMeta(tabId);
      if (meta?.aid && request.cid) {
        const points = await fetchViewPoints(tabId, meta.aid, request.cid, request.bvid);
        chapters = chaptersToSegments(points, request.duration);
      }
      if (chapters.length < 2) {
        // 第三级兜底优先用已缓存的 ASR；没有缓存才把 no-subtitle 抛回 UI 去抽帧。
        const asr = await readAsrResult(request.bvid, request.p, request.cid);
        if (asr) cues = asrCues(asr);
        else throw error;
      }
    }

    // 有 UP 章节就不必调模型：章节本身就是人写好的大纲。
    if (chapters.length >= 2) {
      const outline: Outline = {
        bvid: request.bvid,
        p: request.p,
        cid: request.cid,
        duration: request.duration,
        segments: chapters,
        createdAt: Date.now(),
        model: 'bilibili-chapters',
      };
      await chrome.storage.local.set({
        [outlineStorageKey(request.bvid, request.p, request.cid)]: outline,
      });
      void syncPageSnapshot({
        bvid: request.bvid,
        p: request.p,
        cid: request.cid,
        title: request.title,
        duration: request.duration,
        cues: [],
        outline: chapters,
      }).catch(error => log('outline sync failed', error));
      return { ok: true, outline };
    }

    if (!settings.apiKey.trim()) {
      throw new OutlineFailure('no-key', '还没有配置 DeepSeek API Key，请到设置页填写');
    }

    const prompt = buildOutlinePrompt({
      title: request.title,
      duration: request.duration,
      cues,
    });
    if (!prompt) throw new OutlineFailure('no-subtitle', '该视频没有字幕');

    let text = '';
    const startedAt = Date.now();
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
    await recordUsage(estimateCostCny(result.usage, startedAt), startedAt).catch(error =>
      log('outline usage failed', error),
    );

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
      // 图已经拿到，通知页面可以恢复播放（视频是被 content 为了截图暂停的）。
      postToPort(port, { v: 1, type: 'qa:frame', requestId });
    }

    const cues = await qaCues(tabId, payload);
    if (controller.signal.aborted) {
      postToPort(port, { v: 1, type: 'qa:aborted', requestId, text, reason: active.reason });
      return;
    }

    const model = frame ? settings.visionModel : settings.textModel;

    // 「整节课讲了什么」这类问题只给 ±90 秒答不了：改成全片抽稀字幕 + 已生成大纲。
    const globalQuestion = isGlobalQuestion(payload.question);
    const outline = globalQuestion ? await outlineForQuestion(payload) : undefined;
    const wantedTurns = Math.max(0, Math.min(5, Math.floor(settings.historyTurns)));
    // 刷新页面 / SW 重启后仍能接上「那你…」：历史从 qaStore 读，不再用内存 Map。
    const storedQa = await readQaStore(payload.bvid, payload.p);
    const history =
      wantedTurns === 0
        ? []
        : storedQa.records.slice(-wantedTurns).map(record => ({
            q: record.question,
            a: record.answer,
          }));

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
      historyTurns: settings.historyTurns,
      history,
      mode: globalQuestion ? 'global' : 'auto',
      outline,
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
    const costCny = estimateCostCny(usage, startedAt);
    // 只要模型调用返回了 usage 就记账，空回答/解析失败也已经消耗 token。
    await recordUsage(costCny, startedAt).catch(error => log('qa usage failed', error));

    if (text.trim() === '') {
      postToPort(port, {
        v: 1,
        type: 'qa:error',
        requestId,
        error: { code: 'empty', message: '模型没有返回内容，请重试', retryable: true },
      });
      return;
    }

    // 只有成功的回答才落库；失败或中断的半截不写，免得污染下一轮追问的指代。
    const citations = extractCitationSeconds(text, payload.duration);
    const record = await appendQaRecord(payload.bvid, payload.p, {
      at: payload.at,
      question: payload.question,
      answer: text,
      citations,
      model,
      usage,
    });

    postToPort(port, {
      v: 1,
      type: 'qa:done',
      requestId,
      text,
      reasoning,
      citations,
      usage,
      costCny,
      finishReason: result.finishReason,
      elapsedMs: Date.now() - startedAt,
      recordId: record.id,
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

interface DeepSeekBalance {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

async function fetchDeepSeekBalance(
  apiKey: string,
): Promise<{ ok: true; balances: DeepSeekBalance[] } | { ok: false; message: string }> {
  if (!apiKey.trim()) return { ok: false, message: '还没填 DeepSeek Key' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: `Bearer ${apiKey.trim()}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => null)) as
      | { balance_infos?: DeepSeekBalance[]; error?: { message?: string } }
      | null;
    if (!response.ok) {
      return {
        ok: false,
        message: body?.error?.message ?? `余额接口返回 ${response.status}`,
      };
    }
    return { ok: true, balances: Array.isArray(body?.balance_infos) ? body.balance_infos : [] };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error && error.name === 'AbortError'
        ? '余额请求超时'
        : error instanceof Error
          ? error.message
          : '读取余额失败',
    };
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'ping') {
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      at: Date.now(),
    });
    return true;
  }

  if (message?.type === 'usage:get') {
    void readLedger()
      .then(ledger => sendResponse({ ok: true, ledger }))
      .catch(error =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : '读取用量失败',
        }),
      );
    return true;
  }

  if (message?.type === 'usage:balance') {
    void loadSettings()
      .then(settings => fetchDeepSeekBalance(settings.apiKey))
      .then(result => sendResponse(result))
      .catch(error =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : '读取余额失败',
        }),
      );
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

  if (message?.type === 'options:open') {
    // content script 拿不到 openOptionsPage，这里代它打开设置页。
    void chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === 'qa:history') {
    const bvid = typeof message.bvid === 'string' ? message.bvid : '';
    const p = typeof message.p === 'number' && message.p >= 1 ? Math.floor(message.p) : 0;
    if (!bvid || !p) {
      sendResponse({ ok: false, records: [], message: '缺少 bvid/p' });
      return false;
    }
    void readQaStore(bvid, p)
      .then(store => sendResponse({ ok: true, records: store.records }))
      .catch(error =>
        sendResponse({
          ok: false,
          records: [],
          message: error instanceof Error ? error.message : '读取问答记录失败',
        }),
      );
    return true;
  }

  if (message?.type === 'qa:clear') {
    const bvid = typeof message.bvid === 'string' ? message.bvid : '';
    const p = typeof message.p === 'number' && message.p >= 1 ? Math.floor(message.p) : 0;
    if (!bvid || !p) {
      sendResponse({ ok: false, message: '缺少 bvid/p' });
      return false;
    }
    void clearQaStore(bvid, p)
      .then(() => sendResponse({ ok: true }))
      .catch(error =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : '清空问答记录失败',
        }),
      );
    return true;
  }

  // 「存到知识库」第一步：让模型补「一句话摘要 + 关键词」，其余用现成的。
  if (message?.type === 'kb:draft') {
    const info = readKbInfo(message.info);
    if (!info) {
      sendResponse({ ok: false, message: '缺少视频信息' });
      return false;
    }
    const segments = readKbSegments(message.segments);
    const qa = readKbQa(message.qa);
    void (async () => {
      const settings = await loadSettings();
      let summary = '';
      let keywords: string[] = [];
      let usedModel = false;
      if (settings.apiKey.trim() !== '') {
        try {
          const result = await callDeepSeek({
            apiKey: settings.apiKey,
            baseUrl: settings.apiBaseUrl,
            model: settings.textModel,
            messages: buildKbSummaryPrompt({ info, segments }),
            thinking: false,
            maxTokens: 512,
            temperature: 0.2,
            onChunk: () => {},
          });
          const parsed = parseKbSummary(result.text);
          if (parsed) {
            summary = parsed.summary;
            keywords = parsed.keywords;
            usedModel = true;
          }
        } catch (error) {
          // 摘要生成失败不该挡住入库：退化成「没有摘要」的纯资料条目。
          log('kb summary failed', error);
        }
      }
      const now = new Date();
      sendResponse({
        ok: true,
        fileName: kbFileName({ title: info.title, bvid: info.bvid, now }),
        markdown: buildKbMarkdown({ info, segments, qa, summary, keywords, now }),
        usedModel,
      });
    })().catch(error =>
      sendResponse({
        ok: false,
        message: error instanceof Error ? error.message : '生成笔记草稿失败',
      }),
    );
    return true;
  }

  // 「存到知识库」第二步：交给本地 companion 写进 <kb>/20-知识笔记/。
  if (message?.type === 'kb:save') {
    const fileName = typeof message.fileName === 'string' ? message.fileName.trim() : '';
    const markdown = typeof message.markdown === 'string' ? message.markdown : '';
    if (fileName === '' || markdown.trim() === '') {
      sendResponse({ ok: false, message: '没有可保存的内容' });
      return false;
    }
    void (async () => {
      const settings = await loadSettings();
      const base = settings.companionUrl.replace(/\/+$/, '');
      const response = await fetch(`${base}/api/kb/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ fileName, markdown }),
      });
      const data = (await response.json().catch(() => null)) as
        | { ok?: boolean; relative?: string; overwrote?: boolean; message?: string }
        | null;
      if (!response.ok || !data?.ok) {
        throw new Error(data?.message ?? `companion 返回 HTTP ${response.status}`);
      }
      sendResponse({ ok: true, relative: data.relative ?? fileName, overwrote: data.overwrote === true });
    })().catch(error =>
      sendResponse({
        ok: false,
        message:
          error instanceof Error && error.message.includes('Failed to fetch')
            ? '连不上 companion（127.0.0.1:8787），先在终端跑 pnpm companion'
            : error instanceof Error
              ? error.message
              : '写入知识库失败',
      }),
    );
    return true;
  }

  if (message?.type === 'frame:capture') {
    const rect = readCaptureRect(message.rect);
    const viewport = readCaptureViewport(message.viewport);
    const windowId = sender.tab?.windowId;
    if (!rect || !viewport || windowId === undefined) {
      sendResponse({ ok: false, message: '截图参数不合法' });
      return false;
    }
    void captureFrame(windowId, rect, viewport, 0)
      .then(frame => sendResponse({ ok: true, frame }))
      .catch(error =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : '截图失败',
        }),
      );
    return true;
  }

  if (message?.type === 'asr:transcribe') {
    const bvid = typeof message.bvid === 'string' ? message.bvid : '';
    const p = typeof message.p === 'number' && message.p >= 1 ? Math.floor(message.p) : 0;
    const cid =
      typeof message.cid === 'number' && message.cid > 0 ? message.cid : undefined;
    const duration =
      typeof message.duration === 'number' && Number.isFinite(message.duration)
        ? message.duration
        : undefined;
    const tabId = typeof message.tabId === 'number' ? message.tabId : sender.tab?.id;
    if (!bvid || !p || tabId === undefined) {
      sendResponse({
        ok: false,
        code: 'unknown',
        message: '缺少 bvid/p 或标签页',
      } satisfies AsrTranscribeResponse);
      return false;
    }

    const request: AsrRequest = {
      bvid,
      p,
      cid,
      title: typeof message.title === 'string' ? message.title : undefined,
      duration,
    };
    const jobKey = `${tabId}:${bvid}:${p}`;
    let job = asrJobs.get(jobKey);
    if (!job) {
      job = transcribeAsr(tabId, request);
      asrJobs.set(jobKey, job);
      const pending = job;
      void pending
        .then(result => {
          if (asrJobs.get(jobKey) === pending) asrJobs.delete(jobKey);
          sendToTab(tabId, {
            type: 'asr:done',
            bvid: request.bvid,
            p: request.p,
            cid: request.cid,
            asr: result,
          });
        })
        .catch(error => {
          if (asrJobs.get(jobKey) === pending) asrJobs.delete(jobKey);
          sendToTab(tabId, {
            type: 'asr:error',
            bvid: request.bvid,
            p: request.p,
            cid: request.cid,
            error: asrError(error),
          });
        });
    }
    sendResponse({ ok: true } satisfies AsrTranscribeResponse);
    return false;
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

    const rawFrames = Array.isArray(message.frames) ? message.frames : [];
    const frames = readOutlineFrames(rawFrames);
    if (rawFrames.length > 0 && frames.length === 0) {
      sendResponse({
        ok: false,
        code: 'bad-output',
        message: '截图数据无效，请重试',
      } satisfies OutlineGenerateResponse);
      return false;
    }

    const request: OutlineRequest = {
      bvid,
      p,
      cid,
      title,
      duration,
      frames: frames.length > 0 ? frames : undefined,
    };
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
    // 用户手动点「同步失败 N 条」：先把它放回队列，再走正常 flush。
    void retryFailed()
      .catch(() => 0)
      .then(() => flushQueue())
      .then(status => sendResponse({ ok: true, status }))
      .catch(error =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : '同步失败',
        }),
      );
    return true;
  }

  if (message?.type === 'sync:clear-failed') {
    void clearFailed()
      .then(count =>
        getSyncStatus().then(status => sendResponse({ ok: true, cleared: count, status })),
      )
      .catch(error =>
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : '清空失败队列失败',
        }),
      );
    return true;
  }

  return false;
});

/** 下载 B 站 CDN 音轨必须带 Referer；JS 设不了 forbidden header，交给 DNR 改写。 */
function ensureAsrRefererRule(): void {
  const rule: chrome.declarativeNetRequest.Rule = {
    id: ASR_REFERER_RULE_ID,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        {
          header: 'Referer',
          operation: 'set',
          value: 'https://www.bilibili.com/',
        },
      ],
    },
    condition: {
      urlFilter: 'bilivideo.com',
      resourceTypes: ['xmlhttprequest'],
    },
  };
  void chrome.declarativeNetRequest
    .updateDynamicRules({ removeRuleIds: [ASR_REFERER_RULE_ID], addRules: [rule] })
    .catch(error => log('asr referer rule failed', error));
}
ensureAsrRefererRule();
chrome.runtime.onInstalled.addListener(() => ensureAsrRefererRule());
chrome.runtime.onStartup.addListener(() => ensureAsrRefererRule());

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
