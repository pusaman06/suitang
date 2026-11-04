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
    if (document.getElementById(HOST_ID)) return;
    handle = mountUi(info);
  } finally {
    booting = false;
  }
}

function reset(): void {
  handle?.destroy();
  handle = null;
  document.getElementById(HOST_ID)?.remove();
}

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === 'toggle-panel') handle?.toggle();
});

window.setInterval(() => {
  if (location.href === lastHref) return;
  lastHref = location.href;
  reset();
  window.setTimeout(() => void boot(), 500);
}, 800);

void boot();
