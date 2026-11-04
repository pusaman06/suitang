import type { VideoInfo, VideoMeta } from '../shared/types';

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
