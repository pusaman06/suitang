/** B 站音轨获取 + SiliconFlow 整段转写（D8 A 路径）。 */

import type { AsrErrorCode } from '../shared/asr';

export const ASR_REFERER_RULE_ID = 7101;
export const ASR_MAX_AUDIO_BYTES = 45 * 1024 * 1024;
export const ASR_MAX_AUDIO_SECONDS = 3600;
export const ASR_DEFAULT_MODEL = 'FunAudioLLM/SenseVoiceSmall';

export class AsrFailure extends Error {
  constructor(
    readonly code: AsrErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AsrFailure';
  }
}

export interface AudioTrack {
  url: string;
  bandwidth: number;
}

interface PageAudioResult {
  ok: boolean;
  audios?: Array<{ url: string; bandwidth: number }>;
  stale?: boolean;
  error?: string;
}

interface AudioItem {
  baseUrl?: string;
  base_url?: string;
  bandwidth?: number;
}

function pickAudio(items: AudioItem[] | undefined): AudioTrack | null {
  // 转写只要语音听得清，取码率最低的音轨：上传快、超时风险小。
  // 52 分钟的视频，最高码率约 41MB，最低码率约 26MB（SiliconFlow 上限 50MB）。
  const audios = (items ?? [])
    .map(item => ({
      url: item.baseUrl ?? item.base_url ?? '',
      bandwidth: Number(item.bandwidth) || 0,
    }))
    .filter(item => item.url !== '')
    .sort((a, b) => a.bandwidth - b.bandwidth);
  return audios[0] ?? null;
}

/** 页面首屏/SPA 切 P 后注入的 __playinfo__ 通常已有音轨，优先用它，避免 playurl 的 CORS。 */
async function readPageAudio(
  tabId: number,
  aid: number,
  cid: number,
  bvid: string,
  duration = 0,
): Promise<PageAudioResult | null> {
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [aid, cid, bvid, duration],
      func: (
        pageAid: number,
        pageCid: number,
        pageBvid: string,
        pageDuration: number,
      ): PageAudioResult => {
        const root = window as unknown as {
          __INITIAL_STATE__?: {
            p?: number;
            videoData?: {
              bvid?: string;
              aid?: number;
              pages?: Array<{ page?: number; cid?: number }>;
            };
          };
          __playinfo__?: {
            data?: {
              timelength?: number;
              dash?: { audio?: Array<{ baseUrl?: string; base_url?: string; bandwidth?: number }> };
            };
          };
        };
        const state = root.__INITIAL_STATE__;
        const video = state?.videoData;
        const pages = video?.pages ?? [];
        // 当前分 P 以 URL 的 ?p= 为准：SPA 切 P 只改 URL，__INITIAL_STATE__
        // 不更新（videoData.cid 永远是首 P 的 cid），拿它判断会误报「分 P 不一致」。
        const urlP = Number(new URL(location.href).searchParams.get('p') ?? '1') || 1;
        const pageNo = urlP || Number(state?.p) || 1;
        const current = pages.find(item => item.page === pageNo) ?? pages[pageNo - 1];
        const currentCid = Number(current?.cid) || 0;
        // SPA 内切分 P 时 __playinfo__ 不会重新加载（仍是首屏分 P 的时长和音轨），
        // 页面音轨不能拿来转写；但这不是「分 P 不一致」，改走后台 playurl 接口。
        const playLength = Number(root.__playinfo__?.data?.timelength) || 0;
        const playMismatch =
          pageDuration > 0 &&
          playLength > 0 &&
          Math.abs(playLength / 1000 - pageDuration) > 5;
        const stale =
          (typeof video?.bvid === 'string' && video.bvid !== pageBvid) ||
          (Number.isFinite(Number(video?.aid)) && Number(video?.aid) !== pageAid) ||
          (currentCid > 0 && currentCid !== pageCid);
        if (stale) {
          return { ok: false, stale: true, error: '播放地址和当前分 P 不一致，请稍后重试' };
        }
        if (playMismatch) {
          return { ok: false, error: '播放器还在旧分 P，改从接口取音轨' };
        }

        const items = root.__playinfo__?.data?.dash?.audio ?? [];
        // 同 pickAudio：优先最低码率，ASR 不需要高音质，上传也更快。
        const audios = items
          .map(item => ({
            url: item.baseUrl ?? item.base_url ?? '',
            bandwidth: Number(item.bandwidth) || 0,
          }))
          .filter(item => item.url !== '')
          .sort((a, b) => a.bandwidth - b.bandwidth);
        if (audios.length === 0) return { ok: false, error: '页面里还没有音轨地址' };
        return { ok: true, audios };
      },
    });
    return injection?.result ?? null;
  } catch {
    return null;
  }
}

/** 兜底：background fetch playurl，扩展的 host_permissions 不受页面 CORS 限制。 */
async function fetchPlayUrl(aid: number, cid: number, bvid: string): Promise<PageAudioResult> {
  const url =
    `https://api.bilibili.com/x/player/playurl?avid=${encodeURIComponent(String(aid))}` +
    `&cid=${encodeURIComponent(String(cid))}&qn=0&fnval=16&fourk=1`;
  let response: Response;
  try {
    response = await fetch(url, { credentials: 'include' });
  } catch (error) {
    return {
      ok: false,
      error: `playurl 请求失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!response.ok) return { ok: false, error: `playurl HTTP ${response.status}` };
  let payload: {
    code?: number;
    message?: string;
    data?: {
      bvid?: string;
      aid?: number;
      cid?: number;
      dash?: { audio?: AudioItem[] };
    };
  };
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    return { ok: false, error: 'playurl 返回的不是 JSON' };
  }
  if (payload.code !== 0 || !payload.data) {
    return { ok: false, error: payload.message ?? 'playurl 返回失败' };
  }
  const data = payload.data;
  const stale =
    (typeof data.bvid === 'string' && data.bvid !== bvid) ||
    (Number.isFinite(Number(data.aid)) && Number(data.aid) !== aid) ||
    (Number.isFinite(Number(data.cid)) && Number(data.cid) !== cid);
  if (stale) return { ok: false, stale: true, error: '播放地址和当前分 P 不一致，请稍后重试' };
  const track = pickAudio(data.dash?.audio);
  if (!track) return { ok: false, error: '这个视频没有可下载的音轨' };
  return { ok: true, audios: [track] };
}

/** 先读页面 __playinfo__，再退到 background 的 playurl 请求。 */
export async function getAudioTrack(
  tabId: number,
  aid: number,
  cid: number,
  bvid: string,
  duration = 0,
): Promise<AudioTrack> {
  const page = await readPageAudio(tabId, aid, cid, bvid, duration);
  if (page?.stale) {
    throw new AsrFailure('stale', page.error ?? '播放地址和当前分 P 不一致，请稍后重试');
  }
  if (page?.audios?.length) {
    return page.audios[0];
  }

  const fallback = await fetchPlayUrl(aid, cid, bvid);
  if (fallback.stale) {
    throw new AsrFailure('stale', fallback.error ?? '播放地址和当前分 P 不一致，请稍后重试');
  }
  if (!fallback.ok || !fallback.audios?.length) {
    throw new AsrFailure('no-audio', fallback.error ?? '没有找到可用的音轨');
  }
  return fallback.audios[0];
}

/**
 * CDN 的 Referer 由 declarativeNetRequest 改写；这里只负责下载。
 * background 的 fetch 也受 forbidden header 限制，不能直接写 Referer，
 * 所以必须保留 DNR 规则（见 background/index.ts 的 ensureAsrRefererRule）。
 */
export async function downloadAudio(url: string): Promise<ArrayBuffer> {
  let response: Response;
  try {
    // 不设自定义头：service worker 里 Referer 属于 forbidden header，设了会被
    // 浏览器直接拒掉（表现为 Failed to fetch）。Referer 统一交给 DNR 规则改。
    response = await fetch(url, { credentials: 'omit' });
  } catch (error) {
    throw new AsrFailure(
      'download',
      `下载音轨失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!response.ok) {
    throw new AsrFailure('download', `下载音轨失败：HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0) {
    throw new AsrFailure('download', '下载到的音轨是空的');
  }
  return buffer;
}

/** 调 SiliconFlow 的 multipart 转写接口；它只返回整段 text，没有时间戳。 */
export async function transcribeAudio(
  buffer: ArrayBuffer,
  apiKey: string,
  baseUrl: string,
  model: string,
): Promise<string> {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/audio/transcriptions`;
  const form = new FormData();
  form.append('model', model);
  form.append('file', new Blob([buffer], { type: 'audio/mp4' }), 'audio.m4a');

  const controller = new AbortController();
  // 26MB 左右的音轨上传 + 转写大约 40 秒；长视频留足余量，超时再放宽到 5 分钟。
  const timer = setTimeout(() => controller.abort(), 300_000);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: controller.signal,
    });
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === 'AbortError'
        ? '转写请求超时'
        : error instanceof Error
          ? error.message
          : String(error);
    throw new AsrFailure('transcribe', `转写请求失败：${message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 300);
    throw new AsrFailure('transcribe', `转写失败：HTTP ${response.status} ${detail}`);
  }

  let payload: { text?: unknown };
  try {
    payload = (await response.json()) as { text?: unknown };
  } catch {
    throw new AsrFailure('transcribe', '转写接口返回的不是 JSON');
  }
  const text = typeof payload.text === 'string' ? payload.text.trim() : '';
  if (text === '') throw new AsrFailure('empty', '转写结果为空，请重试');
  return text;
}
