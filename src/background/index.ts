import type { VideoMeta } from '../shared/types';

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

  return false;
});

function sendToTab(tabId: number, message: unknown): void {
  chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError);
}
