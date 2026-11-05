import type { VideoInfo, VideoMeta } from '../shared/types';
import { clampSeconds } from '../shared/citations';
import { QA_MIN_VISIBLE_RATIO, type QaRect, type QaViewport } from '../shared/qa';

function readBvid(): string | null {
  const match = location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/);
  return match?.[1] ?? null;
}

function readPage(): number {
  const raw = Number(new URLSearchParams(location.search).get('p') ?? '1');
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

function fallbackTitle(): string {
  return document.title.replace(/_哔哩哔哩.*$/, '').trim();
}

export function getVideoInfo(): VideoInfo | null {
  const bvid = readBvid();
  if (!bvid) return null;
  return { bvid, p: readPage(), title: fallbackTitle() };
}

export function waitForVideoInfo(timeoutMs = 8000): Promise<VideoInfo | null> {
  const base = getVideoInfo();
  if (!base) return Promise.resolve(null);

  return new Promise(resolve => {
    let done = false;
    let timer = 0;

    const finish = (info: VideoInfo) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      resolve(info);
    };

    timer = window.setTimeout(() => finish(base), timeoutMs);

    requestVideoMeta(base.bvid).then(meta => {
      if (!meta) {
        finish(base);
        return;
      }
      const page = meta.pages.find(item => item.page === base.p) ?? meta.pages[base.p - 1];
      finish({
        bvid: base.bvid,
        p: base.p,
        aid: meta.aid,
        cid: page?.cid,
        title: meta.title || base.title,
        partTitle: page?.part,
        owner: meta.owner,
        duration: page?.duration ?? meta.duration,
        pageCount: meta.pages.length,
      });
    });
  });
}

function requestVideoMeta(bvid: string): Promise<VideoMeta | null> {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'video-meta', bvid }, (reply: VideoMeta | null) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(reply ?? null);
    });
  });
}

/** 当前页面的 <video>；B 站切 P 会复用同一个元素。 */
export function getVideoElement(): HTMLVideoElement | null {
  return document.querySelector('video');
}

export function getPlaybackTime(): number {
  const video = getVideoElement();
  return video && Number.isFinite(video.currentTime) ? video.currentTime : 0;
}

/**
 * 当前 video 在视口里的可见矩形（已与视口求交）。
 * 可见面积不足一半时返回 null：这时截出来是半张画面，不如不带图。
 */
export function getVisibleVideoRect(): { rect: QaRect; viewport: QaViewport } | null {
  const video = getVideoElement();
  if (!video) return null;
  const box = video.getBoundingClientRect();
  if (!(box.width > 0) || !(box.height > 0)) return null;

  const viewport: QaViewport = { width: window.innerWidth, height: window.innerHeight };
  const left = Math.max(0, box.left);
  const top = Math.max(0, box.top);
  const right = Math.min(viewport.width, box.right);
  const bottom = Math.min(viewport.height, box.bottom);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  if ((width * height) / (box.width * box.height) < QA_MIN_VISIBLE_RATIO) return null;

  return { rect: { x: left, y: top, width, height }, viewport };
}

/**
 * 跳转并恢复播放状态：跳之前正在播就继续播，本来暂停就保持暂停；
 * autoPlay 为 true 时强制播放（设置项 jumpAutoPlay）。
 */
export function seekVideo(seconds: number, options: { autoPlay?: boolean } = {}): boolean {
  const video = getVideoElement();
  if (!video) return false;
  const wasPlaying = !video.paused;
  video.currentTime = clampSeconds(seconds, Number.isFinite(video.duration) ? video.duration : undefined);
  if (options.autoPlay || wasPlaying) {
    void video.play().catch(() => undefined);
  } else {
    video.pause();
  }
  return true;
}

/** 截图前藏起的弹幕元素，恢复时按原值还原。 */
let hiddenDanmaku: Array<{ el: HTMLElement; prev: string }> = [];

/** B 站播放器各版本的弹幕层；新版 bpx-player，旧版兜底。 */
const DANMAKU_SELECTORS = [
  '.bpx-player-dm-mask-wrap',
  '.bpx-player-adv-dm-wrap',
  '.bpx-player-row-dm-wrap',
  '.bpx-player-bas-dm-wrap',
  '.bpx-player-cmd-dm-wrap',
  '.bpx-player-cmd-dm-inside',
  '.bpx-player-new-dialogue-area',
  '.bilibili-player-video-danmaku',
  '#danmukuBox',
];

/**
 * 截图期间隐藏弹幕层：弹幕浮在画面上，会把 PPT 文字盖掉，
 * 模型看到的就是一片「666」「哈哈哈哈」。
 * 只改元素的 inline visibility，恢复时写回原值。
 */
export function setDanmakuHidden(on: boolean): void {
  if (on) {
    if (hiddenDanmaku.length > 0) return;
    for (const selector of DANMAKU_SELECTORS) {
      document.querySelectorAll<HTMLElement>(selector).forEach(el => {
        if (getComputedStyle(el).visibility === 'hidden') return;
        hiddenDanmaku.push({ el, prev: el.style.visibility });
        el.style.visibility = 'hidden';
      });
    }
    return;
  }
  for (const { el, prev } of hiddenDanmaku) el.style.visibility = prev;
  hiddenDanmaku = [];
}
