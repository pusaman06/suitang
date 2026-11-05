import styleText from './ui.css?inline';
import { formatCueTime } from '../shared/subtitles';
import type { SubtitleResult, VideoInfo } from '../shared/types';

const HOST_ID = 'video-tutor-host';

export interface UiHandle {
  toggle(): void;
  update(info: VideoInfo): void;
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
      <p class="vt-hint">D2：先验证字幕抓取；问答 D3 接入。</p>
      <button class="vt-ping">测试后台连接</button>
      <button class="vt-sub">测试字幕（前 10 条）</button>
      <pre class="vt-log"></pre>
    </section>`;

  const ball = must<HTMLButtonElement>(shadow, '.vt-ball');
  const panel = must<HTMLElement>(shadow, '.vt-panel');
  const close = must<HTMLButtonElement>(shadow, '.vt-close');
  const ping = must<HTMLButtonElement>(shadow, '.vt-ping');
  const sub = must<HTMLButtonElement>(shadow, '.vt-sub');
  const log = must<HTMLPreElement>(shadow, '.vt-log');
  const course = must<HTMLElement>(shadow, '.vt-course');
  const part = must<HTMLElement>(shadow, '.vt-part');
  const ids = must<HTMLElement>(shadow, '.vt-ids');

  let currentInfo = info;
  const render = (next: VideoInfo) => {
    currentInfo = next;
    course.textContent = next.title;
    const pageLabel = next.pageCount ? `P${next.p} / ${next.pageCount}` : `P${next.p}`;
    part.textContent = `${pageLabel}${next.partTitle ? ` · ${next.partTitle}` : ''}`;
    ids.textContent = `${next.bvid}${next.cid ? ` · cid ${next.cid}` : ''}`;
  };
  render(info);

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

  sub.addEventListener('click', () => {
    if (!currentInfo.aid || !currentInfo.cid) {
      log.textContent = '缺少 aid/cid，请等页面元数据加载完再试。';
      return;
    }
    sub.disabled = true;
    log.textContent = '拉取字幕…';
    chrome.runtime.sendMessage(
      {
        type: 'subtitle:list',
        bvid: currentInfo.bvid,
        aid: currentInfo.aid,
        cid: currentInfo.cid,
        p: currentInfo.p,
        duration: currentInfo.duration,
      },
      (reply: SubtitleResult | undefined) => {
        sub.disabled = false;
        const error = chrome.runtime.lastError;
        if (error) {
          log.textContent = `后台未响应：${error.message}`;
          return;
        }
        if (!reply?.ok) {
          const loginHint = reply?.needLogin
            ? '\n请确认 Edge 已登录 B 站，然后重试。'
            : '';
          log.textContent = `字幕失败：${reply?.error ?? '未知错误'}${loginHint}`;
          return;
        }
        const lines = (reply.cues ?? []).map(
          cue => `[${formatCueTime(cue.from)} → ${formatCueTime(cue.to)}] ${cue.content}`,
        );
        const head = `${reply.track?.lan_doc || reply.track?.lan || '字幕'} · 共 ${
          reply.total ?? 0
        } 条 · ${reply.cached ? '缓存' : '新拉取'}`;
        log.textContent = `${head}\n${lines.join('\n')}`;
      },
    );
  });

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') panel.hidden = true;
  };
  document.addEventListener('keydown', onKeyDown);

  document.body.appendChild(host);

  return {
    toggle,
    update: render,
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
