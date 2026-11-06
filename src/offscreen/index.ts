/**
 * 离屏文档：专门干「下载大文件」这件事。
 *
 * 为什么不在 service worker 里下：同样是扩展上下文、同样有 <all_urls> 权限，
 * 扩展页面里 fetch 一条 26MB 的音轨只要 4.9 秒，service worker 里却会拖到三十秒以上
 * 然后 network error——MV3 的 worker 会被挂起，长连接扛不住。
 * 离屏文档是持久的扩展页面，跟 options 页一样稳。
 */

let audioBuffer: ArrayBuffer | null = null;

const MAX_CHUNK_BYTES = 4 * 1024 * 1024;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'offscreen:fetch') {
    void (async () => {
      try {
        const response = await fetch(message.url as string, { credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        audioBuffer = await response.arrayBuffer();
        if (audioBuffer.byteLength === 0) throw new Error('下载到的音轨是空的');
        sendResponse({ ok: true, total: audioBuffer.byteLength });
      } catch (error) {
        audioBuffer = null;
        sendResponse({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    return true;
  }

  if (message?.type === 'offscreen:chunk') {
    if (!audioBuffer) {
      sendResponse({ ok: false, message: '音频还没下载好' });
      return false;
    }
    const total = audioBuffer.byteLength;
    const offset = Math.min(Math.max(0, Math.floor(Number(message.offset) || 0)), total);
    const size = Math.min(Math.max(1, Math.floor(Number(message.size) || 0)), MAX_CHUNK_BYTES);
    const slice = new Uint8Array(audioBuffer, offset, Math.min(size, total - offset));
    sendResponse({ ok: true, data: bytesToBase64(slice), bytes: slice.byteLength });
    return false;
  }

  if (message?.type === 'offscreen:close') {
    audioBuffer = null;
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
