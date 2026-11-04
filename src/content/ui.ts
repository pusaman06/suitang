import styleText from './ui.css?inline';
import type { VideoInfo } from '../shared/types';

const HOST_ID = 'video-tutor-host';

export interface UiHandle {
  toggle(): void;
  destroy(): void;
}

export function mountUi(info: VideoInfo): UiHandle {
  document.getElementById(HOST_ID)?.remove();

  const host = document.createElement('div');
  host.id = HOST_ID;
  const shadow = host.attachShadow({ mode: 'open' });
  applyStyles(shadow, styleText);
  shadow.innerHTML = `
    <button class="vt-ball" title="Video Tutor（Alt+Q）">问</button>
    <section class="vt-panel" hidden>
      <div class="vt-head">
        <span class="vt-title">Video Tutor</span>
        <button class="vt-close" title="关闭">×</button>
      </div>
      <div class="vt-meta">
        <div class="vt-course"></div>
        <div class="vt-part"></div>
        <div class="vt-ids"></div>
      </div>
      <p class="vt-hint">D1 脚手架：字幕与问答在 D2 / D3 接入。</p>
      <button class="vt-ping">测试后台连接</button>
      <pre class="vt-log"></pre>
    </section>`;

  const ball = must<HTMLButtonElement>(shadow, '.vt-ball');
  const panel = must<HTMLElement>(shadow, '.vt-panel');
  const close = must<HTMLButtonElement>(shadow, '.vt-close');
  const ping = must<HTMLButtonElement>(shadow, '.vt-ping');
  const log = must<HTMLPreElement>(shadow, '.vt-log');

  must<HTMLElement>(shadow, '.vt-course').textContent = info.title;
  const pageLabel = info.pageCount ? `P${info.p} / ${info.pageCount}` : `P${info.p}`;
  must<HTMLElement>(shadow, '.vt-part').textContent =
    `${pageLabel}${info.partTitle ? ` · ${info.partTitle}` : ''}`;
  must<HTMLElement>(shadow, '.vt-ids').textContent =
    `${info.bvid}${info.cid ? ` · cid ${info.cid}` : ''}`;

  const toggle = () => {
    panel.hidden = !panel.hidden;
  };

  ball.addEventListener('click', toggle);
  close.addEventListener('click', () => {
    panel.hidden = true;
  });

  ping.addEventListener('click', () => {
    log.textContent = '连接中…';
    chrome.runtime.sendMessage({ type: 'ping' }, reply => {
      const error = chrome.runtime.lastError;
      log.textContent = error
        ? `后台未响应：${error.message}`
        : JSON.stringify(reply, null, 2);
    });
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') panel.hidden = true;
  };
  document.addEventListener('keydown', onKeyDown);

  document.body.appendChild(host);

  return {
    toggle,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      host.remove();
    },
  };
}

function applyStyles(shadow: ShadowRoot, css: string): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }
}

function must<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`missing element: ${selector}`);
  return element;
}
