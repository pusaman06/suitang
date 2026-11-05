import styleText from './ui.css?inline';
import { renderAnswerHtml } from '../shared/citations';
import { QA_PORT_NAME, type QaAskPayload, type QaRect, type QaServerMessage, type QaViewport, type QaWindowInfo } from '../shared/qa';
import { loadSettings, type Settings } from '../shared/settings';
import type { VideoInfo } from '../shared/types';
import { getPlaybackTime, getVideoElement, getVisibleVideoRect, seekVideo } from './page';

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
      <div class="vt-status">就绪</div>
      <div class="vt-answers"></div>
      <div class="vt-frame-hint" hidden></div>
      <div class="vt-composer">
        <textarea class="vt-input" rows="2" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
        <div class="vt-actions">
          <button class="vt-send">发送</button>
        </div>
      </div>
    </section>`;

  const ball = must<HTMLButtonElement>(shadow, '.vt-ball');
  const panel = must<HTMLElement>(shadow, '.vt-panel');
  const close = must<HTMLButtonElement>(shadow, '.vt-close');
  const course = must<HTMLElement>(shadow, '.vt-course');
  const part = must<HTMLElement>(shadow, '.vt-part');
  const ids = must<HTMLElement>(shadow, '.vt-ids');
  const status = must<HTMLElement>(shadow, '.vt-status');
  const answers = must<HTMLElement>(shadow, '.vt-answers');
  const frameHint = must<HTMLElement>(shadow, '.vt-frame-hint');
  const input = must<HTMLTextAreaElement>(shadow, '.vt-input');
  const send = must<HTMLButtonElement>(shadow, '.vt-send');

  let currentInfo = info;
  let settings: Settings | null = null;
  let port: chrome.runtime.Port | null = null;
  let activeRequestId = '';
  let streamTurn: { answer: HTMLElement; text: string; meta: HTMLElement } | null = null;
  let lastQuestion = '';
  let lastWindow: QaWindowInfo | null = null;
  let askedFrame = false;
  let asking = false;
  let capturing = false;
  let captureTimer = 0;

  void loadSettings().then(next => {
    settings = next;
    if (activeRequestId === '') status.textContent = next.apiKey ? '就绪' : '未配置 API Key';
  });

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
    if (!panel.hidden) input.focus();
  };

  ball.addEventListener('click', toggle);
  close.addEventListener('click', () => {
    panel.hidden = true;
  });

  const setFrameHint = (text: string) => {
    frameHint.textContent = text;
    frameHint.hidden = text === '';
  };

  /** 截图时把悬浮球和面板藏起来，免得截进画面；收到 qa:start / 报错就恢复。 */
  const setCapturing = (on: boolean) => {
    if (capturing === on) return;
    capturing = on;
    host.style.visibility = on ? 'hidden' : '';
    if (on) {
      if (captureTimer !== 0) window.clearTimeout(captureTimer);
      // 兜底：后台无响应时 5s 后把 UI 放回来，避免面板一直消失。
      captureTimer = window.setTimeout(() => {
        captureTimer = 0;
        setCapturing(false);
      }, 5000);
    } else if (captureTimer !== 0) {
      window.clearTimeout(captureTimer);
      captureTimer = 0;
    }
  };

  // 暂停时悬浮球脉冲提示「可以先问这一帧」；播放时收回高亮。
  const syncPaused = () => {
    const video = getVideoElement();
    ball.classList.toggle('vt-ball-paused', Boolean(video && video.paused));
  };
  const onPlayPause = (event: Event) => {
    if (event.target instanceof HTMLVideoElement) {
      ball.classList.toggle('vt-ball-paused', event.target.paused);
    }
  };
  document.addEventListener('play', onPlayPause, true);
  document.addEventListener('pause', onPlayPause, true);
  syncPaused();
  const initialSync = window.setTimeout(syncPaused, 1200);

  /* -------- 问答 -------- */

  const scrollAnswers = () => {
    answers.scrollTop = answers.scrollHeight;
  };

  const paintStream = () => {
    if (!streamTurn) return;
    streamTurn.answer.innerHTML = renderAnswerHtml(streamTurn.text, currentInfo.duration);
    scrollAnswers();
  };

  let paintTimer = 0;
  const schedulePaint = () => {
    if (paintTimer !== 0) return;
    paintTimer = window.setTimeout(() => {
      paintTimer = 0;
      paintStream();
    }, 50);
  };

  const setBusy = (busy: boolean) => {
    send.disabled = busy;
    send.textContent = busy ? '生成中…' : '发送';
  };

  const addTurn = (question: string): { answer: HTMLElement; text: string; meta: HTMLElement } => {
    const turn = document.createElement('div');
    turn.className = 'vt-turn';
    const q = document.createElement('div');
    q.className = 'vt-q';
    q.textContent = question;
    const a = document.createElement('div');
    a.className = 'vt-a vt-streaming';
    const meta = document.createElement('div');
    meta.className = 'vt-turn-meta';
    turn.append(q, a, meta);
    answers.append(turn);
    scrollAnswers();
    return { answer: a, text: '', meta };
  };

  const showError = (message: string, retryable: boolean) => {
    const box = document.createElement('div');
    box.className = 'vt-error';
    box.textContent = message;
    if (retryable && lastQuestion) {
      const retry = document.createElement('button');
      retry.className = 'vt-retry';
      retry.textContent = '重试';
      retry.addEventListener('click', () => {
        box.remove();
        void ask(lastQuestion);
      });
      box.append(retry);
    }
    if (/API Key/.test(message)) {
      const open = document.createElement('button');
      open.className = 'vt-retry';
      open.textContent = '打开设置';
      open.addEventListener('click', () => {
        try {
          void chrome.runtime.openOptionsPage();
        } catch {
          // content script 里不可用时忽略。
        }
      });
      box.append(open);
    }
    answers.append(box);
    scrollAnswers();
  };

  const finishStream = (text: string, suffix: string) => {
    if (streamTurn) {
      streamTurn.text = text;
      streamTurn.answer.innerHTML = renderAnswerHtml(text, currentInfo.duration);
      streamTurn.answer.classList.remove('vt-streaming');
      streamTurn.meta.textContent = suffix;
      streamTurn = null;
    }
    scrollAnswers();
  };

  const handleServerMessage = (message: QaServerMessage) => {
    if (!message || message.type === 'qa:pong') return;
    if (message.requestId !== activeRequestId) return;
    // 后台发回任何消息都说明截图阶段已结束（qa:start 在截图之后才发）。
    setCapturing(false);
    switch (message.type) {
      case 'qa:start': {
        const { window } = message;
        lastWindow = window;
        if (askedFrame) {
          setFrameHint(window.hasFrame ? '附当前画面' : '画面没截到，只用字幕回答');
        }
        const scope = window.noSubtitle
          ? '无字幕 · 只能按标题回答'
          : `±${Math.round((window.end - window.start) / 2)}s · ${window.cues} 条字幕`;
        status.textContent = `生成中 · ${message.model} · ${scope}`;
        if (streamTurn) streamTurn.meta.textContent = `约 ${window.estimatedInputTokens} token 输入`;
        return;
      }
      case 'qa:chunk': {
        if (message.kind !== 'answer' || !streamTurn) return;
        streamTurn.text += message.text;
        schedulePaint();
        return;
      }
      case 'qa:done': {
        activeRequestId = '';
        const seconds = (message.elapsedMs / 1000).toFixed(1);
        finishStream(message.text, `${message.usage.totalTokens} tokens · ${seconds}s`);
        const scope = lastWindow?.noSubtitle ? ' · 无字幕 · 只能按标题回答' : '';
        status.textContent = `完成 · ${message.usage.totalTokens} tokens${scope}`;
        setBusy(false);
        return;
      }
      case 'qa:error': {
        activeRequestId = '';
        if (askedFrame) setFrameHint('');
        if (streamTurn) {
          streamTurn.answer.classList.remove('vt-streaming');
          streamTurn = null;
        }
        status.textContent = '出错';
        showError(message.error.message, message.error.retryable);
        setBusy(false);
        return;
      }
      case 'qa:aborted': {
        activeRequestId = '';
        finishStream(message.text, '已中断');
        status.textContent = '已中断';
        setBusy(false);
        return;
      }
      default:
        return;
    }
  };

  const ensurePort = (): chrome.runtime.Port => {
    if (port) return port;
    const next = chrome.runtime.connect({ name: QA_PORT_NAME });
    next.onMessage.addListener((message: QaServerMessage) => handleServerMessage(message));
    next.onDisconnect.addListener(() => {
      if (port === next) port = null;
      setCapturing(false);
      void chrome.runtime.lastError;
      if (activeRequestId !== '') {
        activeRequestId = '';
        finishStream(streamTurn?.text ?? '', '连接中断');
        status.textContent = '连接中断';
        showError('与后台的连接中断，请重试。', true);
        setBusy(false);
      }
    });
    port = next;
    return next;
  };

  const sleep = (ms: number) => new Promise<void>(resolve => window.setTimeout(resolve, ms));

  const ask = async (question: string) => {
    const trimmed = question.trim();
    if (trimmed === '' || activeRequestId !== '' || asking) return;
    asking = true;

    try {
      settings = await loadSettings();
      lastQuestion = trimmed;

      const video = getVideoElement();
      const justPaused = Boolean(video && !video.paused);
      if (video && justPaused) video.pause();

      askedFrame = false;
      setFrameHint('');
      let target: { rect: QaRect; viewport: QaViewport } | null = null;
      if (settings.frameEnabled) {
        target = getVisibleVideoRect();
        if (!target) setFrameHint('视频画面没有完整显示，先滚动到画面再问');
      }

      const payload: QaAskPayload = {
        bvid: currentInfo.bvid,
        aid: currentInfo.aid,
        p: currentInfo.p,
        cid: currentInfo.cid,
        title: currentInfo.title,
        partTitle: currentInfo.partTitle,
        pageCount: currentInfo.pageCount,
        duration: currentInfo.duration,
        at: getPlaybackTime(),
        question: trimmed,
      };
      if (target) {
        payload.rect = target.rect;
        payload.viewport = target.viewport;
        askedFrame = true;
      }

      // 刚暂停时等最后一帧稳定，避免截到旧帧；本来已暂停则不需要等。
      if (askedFrame && justPaused) await sleep(300);
      if (askedFrame) {
        setFrameHint('附当前画面');
        setCapturing(true);
      }

      const requestId = `q${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      activeRequestId = requestId;
      streamTurn = addTurn(trimmed);
      setBusy(true);
      status.textContent = settings.apiKey ? '连接中…' : '未配置 API Key';
      ensurePort().postMessage({ v: 1, type: 'qa:ask', requestId, payload });
    } catch (error) {
      activeRequestId = '';
      setCapturing(false);
      setBusy(false);
      if (streamTurn) {
        streamTurn.answer.classList.remove('vt-streaming');
        streamTurn = null;
      }
      showError(`发送失败：${error instanceof Error ? error.message : String(error)}`, true);
    } finally {
      asking = false;
    }
  };

  send.addEventListener('click', () => {
    void ask(input.value);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void ask(input.value);
    }
  });

  // 时间戳点击：事件委托，流式渲染换 DOM 也不用重新绑定。
  answers.addEventListener('click', event => {
    const target = (event.target as HTMLElement | null)?.closest('a.vt-cite');
    if (!(target instanceof HTMLElement)) return;
    const raw = target.dataset.t;
    if (!raw) return;
    seekVideo(Number(raw), { autoPlay: settings?.jumpAutoPlay === true });
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
      document.removeEventListener('play', onPlayPause, true);
      document.removeEventListener('pause', onPlayPause, true);
      window.clearTimeout(initialSync);
      if (captureTimer !== 0) window.clearTimeout(captureTimer);
      if (paintTimer !== 0) window.clearTimeout(paintTimer);
      if (port) {
        port.disconnect();
        port = null;
      }
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
