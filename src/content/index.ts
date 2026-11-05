import { waitForVideoInfo } from './page';
import { mountUi, type UiHandle } from './ui';

const HOST_ID = 'video-tutor-host';

let handle: UiHandle | null = null;
let booting = false;
let lastHref = location.href;

async function boot(): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    const info = await waitForVideoInfo();
    if (!info) return;
    // SPA 只改 URL（q、p、vd_source）时保留面板；否则点击/滚动状态会被清掉。
    if (handle && document.getElementById(HOST_ID)) {
      handle.update(info);
      return;
    }
    handle = mountUi(info);
  } finally {
    booting = false;
  }
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'toggle-panel') handle?.toggle();
});

window.setInterval(() => {
  if (location.href === lastHref) return;
  lastHref = location.href;
  window.setTimeout(() => void boot(), 300);
}, 500);

void boot();
