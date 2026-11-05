import styleText from './ui.css?inline';
import type { AsrError, AsrProgress, AsrResult } from '../shared/asr';
import { formatTimestamp, renderAnswerHtml } from '../shared/citations';
import { formatCny } from '../shared/cost';
import type { UsageLedger } from '../shared/usage-store';
import {
  outlineFrameTimes,
  type Outline,
  type OutlineGenerateResponse,
  type OutlineGetResponse,
} from '../shared/outline';
import {
  QA_PORT_NAME,
  type FrameCaptureResponse,
  type QaAskPayload,
  type QaFrame,
  type QaRect,
  type QaServerMessage,
  type QaViewport,
  type QaWindowInfo,
} from '../shared/qa';
import type { QaRecord } from '../shared/qa-store';
import { loadSettings, type Settings } from '../shared/settings';
import type { SyncStatus } from '../shared/sync';
import type { VideoInfo } from '../shared/types';
import { getPlaybackTime, getVideoElement, getVisibleVideoRect, seekVideo, setDanmakuHidden } from './page';

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
        <span class="vt-head-actions">
          <button class="vt-gear" type="button" title="设置">⚙</button>
          <button class="vt-close" type="button" title="关闭">×</button>
        </span>
      </div>
      <div class="vt-meta">
        <div class="vt-course"></div>
        <div class="vt-part"></div>
        <div class="vt-ids"></div>
      </div>
      <section class="vt-outline">
        <button class="vt-outline-head" type="button" aria-expanded="true">
          <span class="vt-outline-title">大纲</span>
          <span class="vt-outline-caret">▾</span>
          <span class="vt-outline-state">未生成</span>
        </button>
        <div class="vt-outline-body">
          <div class="vt-outline-empty">
            <div class="vt-outline-empty-text">生成一份大纲，快速了解视频结构。</div>
            <div class="vt-outline-actions">
              <button class="vt-outline-generate" type="button">生成大纲</button>
              <span class="vt-outline-cost">约 5–10 秒</span>
              <button class="vt-outline-asr" type="button">转写这段</button>
              <span class="vt-outline-asr-hint"></span>
            </div>
          </div>
          <ol class="vt-outline-list" hidden></ol>
          <div class="vt-outline-foot" hidden>
            <button class="vt-outline-refresh" type="button" title="清掉当前大纲，重新生成一份">
              重新生成
            </button>
          </div>
          <div class="vt-outline-error" hidden>
            <span class="vt-outline-error-text"></span>
            <button class="vt-retry vt-outline-retry" type="button">重试</button>
          </div>
        </div>
      </section>
      <div class="vt-status">就绪</div>
      <button class="vt-sync" type="button" title="点击手动重试同步">同步检查中…</button>
      <button class="vt-usage" type="button" title="点击刷新用量">今日 ≈¥0.00</button>
      <div class="vt-history-head" hidden>
        <button class="vt-clear" type="button">清空记录</button>
      </div>
      <div class="vt-answers"></div>
      <div class="vt-frame-hint" hidden></div>
      <div class="vt-composer">
        <textarea class="vt-input" rows="2" placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"></textarea>
        <div class="vt-actions">
          <button class="vt-kb-open" type="button" title="把这期视频的资料存进个人知识库">存到知识库</button>
          <button class="vt-send">发送</button>
        </div>
      </div>
      <div class="vt-kb" hidden>
        <div class="vt-kb-head">
          <span class="vt-kb-title">存到知识库</span>
          <span class="vt-kb-hint"></span>
        </div>
        <textarea class="vt-kb-preview" rows="12" spellcheck="false"></textarea>
        <div class="vt-kb-foot">
          <button class="vt-kb-confirm" type="button">写入知识库</button>
          <button class="vt-kb-cancel" type="button">取消</button>
        </div>
      </div>
    </section>`;

  const ball = must<HTMLButtonElement>(shadow, '.vt-ball');
  const panel = must<HTMLElement>(shadow, '.vt-panel');
  const close = must<HTMLButtonElement>(shadow, '.vt-close');
  const gear = must<HTMLButtonElement>(shadow, '.vt-gear');
  const course = must<HTMLElement>(shadow, '.vt-course');
  const part = must<HTMLElement>(shadow, '.vt-part');
  const ids = must<HTMLElement>(shadow, '.vt-ids');
  const outlineHead = must<HTMLButtonElement>(shadow, '.vt-outline-head');
  const outlineState = must<HTMLElement>(shadow, '.vt-outline-state');
  const outlineBody = must<HTMLElement>(shadow, '.vt-outline-body');
  const outlineEmpty = must<HTMLElement>(shadow, '.vt-outline-empty');
  const outlineEmptyText = must<HTMLElement>(shadow, '.vt-outline-empty-text');
  const outlineGenerate = must<HTMLButtonElement>(shadow, '.vt-outline-generate');
  const outlineAsr = must<HTMLButtonElement>(shadow, '.vt-outline-asr');
  const outlineAsrHint = must<HTMLElement>(shadow, '.vt-outline-asr-hint');
  const outlineList = must<HTMLOListElement>(shadow, '.vt-outline-list');
  const outlineFoot = must<HTMLElement>(shadow, '.vt-outline-foot');
  const outlineRefresh = must<HTMLButtonElement>(shadow, '.vt-outline-refresh');
  const outlineError = must<HTMLElement>(shadow, '.vt-outline-error');
  const outlineErrorText = must<HTMLElement>(shadow, '.vt-outline-error-text');
  const outlineRetry = must<HTMLButtonElement>(shadow, '.vt-outline-retry');
  const status = must<HTMLElement>(shadow, '.vt-status');
  const syncLine = must<HTMLButtonElement>(shadow, '.vt-sync');
  const usageLine = must<HTMLButtonElement>(shadow, '.vt-usage');
  const answers = must<HTMLElement>(shadow, '.vt-answers');
  const historyHead = must<HTMLElement>(shadow, '.vt-history-head');
  const clearHistory = must<HTMLButtonElement>(shadow, '.vt-clear');
  const frameHint = must<HTMLElement>(shadow, '.vt-frame-hint');
  const input = must<HTMLTextAreaElement>(shadow, '.vt-input');
  const send = must<HTMLButtonElement>(shadow, '.vt-send');
  const kbOpen = must<HTMLButtonElement>(shadow, '.vt-kb-open');
  const kbBox = must<HTMLElement>(shadow, '.vt-kb');
  const kbPreview = must<HTMLTextAreaElement>(shadow, '.vt-kb-preview');
  const kbHint = must<HTMLElement>(shadow, '.vt-kb-hint');
  const kbConfirm = must<HTMLButtonElement>(shadow, '.vt-kb-confirm');
  const kbCancel = must<HTMLButtonElement>(shadow, '.vt-kb-cancel');

  let currentInfo = info;
  let settings: Settings | null = null;
  let port: chrome.runtime.Port | null = null;
  let activeRequestId = '';
  let streamTurn: { answer: HTMLElement; text: string; meta: HTMLElement } | null = null;
  let lastQuestion = '';
  let lastWindow: QaWindowInfo | null = null;
  let askedFrame = false;
  let asking = false;
  let captureTimer = 0;
  let syncTimer = 0;
  let syncBusy = false;

  const OUTLINE_EMPTY_TEXT = '生成一份大纲，快速了解视频结构。';
  let outline: Outline | null = null;
  let outlineKey = outlineInfoKey(info);
  let outlineExpanded = true;
  let outlineGenerating = false;
  let outlineGetToken = 0;
  let outlineRunToken = 0;
  let outlineCapturing = false;
  let outlineCaptureDone = 0;
  let outlineCaptureTotal = 0;
  let outlineActiveIndex = -1;
  let outlineRetryAction: (() => void) | null = null;
  let lastOutlineTimeupdate = 0;
  let asrTranscribing = false;
  let asrDone = false;
  let asrRunToken = 0;
  let asrSegments = 0;
  let asrKey = outlineInfoKey(info);

  void loadSettings().then(next => {
    settings = next;
    if (activeRequestId === '') status.textContent = next.apiKey ? '就绪' : '未配置 API Key';
    updateAsrButton();
  });

  /* -------- D3 切片 2：问答记录持久化 -------- */

  const formatRecordTime = (createdAt: number): string => {
    if (!createdAt) return '历史';
    const date = new Date(createdAt);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getMonth() + 1}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const renderHistoryTurn = (record: QaRecord) => {
    const turn = document.createElement('div');
    turn.className = 'vt-turn vt-turn-history';
    const q = document.createElement('div');
    q.className = 'vt-q';
    q.textContent = record.question;
    const a = document.createElement('div');
    a.className = 'vt-a';
    a.innerHTML = renderAnswerHtml(record.answer, currentInfo.duration);
    const meta = document.createElement('div');
    meta.className = 'vt-turn-meta';
    meta.textContent = `${formatRecordTime(record.createdAt)} · ${record.usage.totalTokens} tokens`;
    turn.append(q, a, meta);
    answers.append(turn);
  };

  const syncHistoryHead = () => {
    historyHead.hidden = answers.querySelector('.vt-turn-history') === null;
  };

  /** 打开面板 / 切 P 时拉一次记录。读失败就当没有，不影响提问。 */
  const loadQaHistory = async (): Promise<void> => {
    if (currentInfo.bvid === '' || currentInfo.p <= 0) return;
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'qa:history',
        bvid: currentInfo.bvid,
        p: currentInfo.p,
      })) as { ok?: boolean; records?: QaRecord[] } | undefined;
      answers.querySelectorAll('.vt-turn-history').forEach(node => node.remove());
      if (response?.ok) {
        for (const record of response.records ?? []) renderHistoryTurn(record);
      }
      syncHistoryHead();
    } catch {
      // 读历史失败不影响提问。
    }
  };

  let clearTimer = 0;
  clearHistory.addEventListener('click', () => {
    if (clearTimer === 0) {
      clearTimer = window.setTimeout(() => {
        clearTimer = 0;
        clearHistory.textContent = '清空记录';
      }, 3000);
      clearHistory.textContent = '再点一次确认';
      return;
    }
    window.clearTimeout(clearTimer);
    clearTimer = 0;
    clearHistory.textContent = '清空记录';
    void chrome.runtime
      .sendMessage({ type: 'qa:clear', bvid: currentInfo.bvid, p: currentInfo.p })
      .then(() => {
        answers.querySelectorAll('.vt-turn-history').forEach(node => node.remove());
        syncHistoryHead();
        status.textContent = '已清空记录';
      })
      .catch(() => {
        status.textContent = '清空失败，稍后再试';
      });
  });

  /** 「存到知识库」：先拉问答记录 → 让 background 拼草稿 → 面板里可改 → 确认才写盘。 */
  let kbBusy = false;
  let kbFileName = '';

  const draftKb = async (): Promise<void> => {
    if (kbBusy) return;
    kbBusy = true;
    kbOpen.disabled = true;
    kbOpen.textContent = '生成中…';
    try {
      const history = (await chrome.runtime.sendMessage({
        type: 'qa:history',
        bvid: currentInfo.bvid,
        p: currentInfo.p,
      })) as { ok?: boolean; records?: QaRecord[] } | undefined;
      const qa = (history?.records ?? []).map(record => ({
        question: record.question,
        answer: record.answer,
      }));
      const response = (await chrome.runtime.sendMessage({
        type: 'kb:draft',
        info: currentInfo,
        segments: outline?.segments ?? [],
        qa,
      })) as
        | { ok?: boolean; fileName?: string; markdown?: string; usedModel?: boolean; message?: string }
        | undefined;
      if (!response?.ok) {
        status.textContent = response?.message ?? '生成笔记草稿失败';
        return;
      }
      kbFileName = response.fileName ?? '';
      kbPreview.value = response.markdown ?? '';
      kbHint.textContent = response.usedModel
        ? `${kbFileName} · 摘要由模型生成，可直接改`
        : `${kbFileName} · 没配 API Key，只有资料没有摘要`;
      kbBox.hidden = false;
      kbBox.scrollIntoView({ block: 'nearest' });
      kbPreview.focus();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : '生成笔记草稿失败';
    } finally {
      kbBusy = false;
      kbOpen.disabled = false;
      kbOpen.textContent = '存到知识库';
    }
  };

  kbOpen.addEventListener('click', () => {
    void draftKb();
  });

  kbCancel.addEventListener('click', () => {
    kbBox.hidden = true;
    kbPreview.value = '';
    kbFileName = '';
  });

  kbConfirm.addEventListener('click', () => {
    if (kbBusy) return;
    if (kbPreview.value.trim() === '') {
      kbHint.textContent = '内容为空，没什么可存的';
      return;
    }
    kbBusy = true;
    kbConfirm.disabled = true;
    kbConfirm.textContent = '写入中…';
    void chrome.runtime
      .sendMessage({ type: 'kb:save', fileName: kbFileName, markdown: kbPreview.value })
      .then(response => {
        const result = response as
          | { ok?: boolean; relative?: string; overwrote?: boolean; message?: string }
          | undefined;
        if (!result?.ok) {
          kbHint.textContent = result?.message ?? '写入失败';
          return;
        }
        kbBox.hidden = true;
        kbPreview.value = '';
        status.textContent = `${result.overwrote ? '已覆盖' : '已存入'} ${result.relative}（约 8 秒后可搜到）`;
      })
      .catch(error => {
        kbHint.textContent = error instanceof Error ? error.message : '写入失败';
      })
      .finally(() => {
        kbBusy = false;
        kbConfirm.disabled = false;
        kbConfirm.textContent = '写入知识库';
      });
  });

  const render = (next: VideoInfo) => {
    const nextKey = outlineInfoKey(next);
    const changed = nextKey !== outlineKey;
    currentInfo = next;
    outlineKey = nextKey;
    course.textContent = next.title;
    const pageLabel = next.pageCount ? `P${next.p} / ${next.pageCount}` : `P${next.p}`;
    part.textContent = `${pageLabel}${next.partTitle ? ` · ${next.partTitle}` : ''}`;
    ids.textContent = `${next.bvid}${next.cid ? ` · cid ${next.cid}` : ''}`;
    if (changed) {
      resetOutline();
      void loadQaHistory();
    }
  };
  render(info);

  const toggle = () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      // 首次打开时不要从 CSS 默认位置滑过来，直接落位。
      panel.style.transition = 'none';
      placePanelNearBall();
      window.requestAnimationFrame(() => {
        panel.style.transition = '';
      });
      input.focus();
      // 面板打开只读缓存，不自动生成；用户点「生成大纲」才发请求。
      void loadOutline();
      void loadQaHistory();
      void refreshSync();
      void refreshUsage();
      startSyncPolling();
    } else {
      stopSyncPolling();
    }
  };

  ball.addEventListener('click', () => {
    if (suppressBallClick) return;
    toggle();
  });
  gear.addEventListener('click', () => {
    // content script 的 chrome.runtime 没有 openOptionsPage，转给 background。
    void chrome.runtime.sendMessage({ type: 'options:open' });
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
    stopSyncPolling();
  });

  const setFrameHint = (text: string) => {
    frameHint.textContent = text;
    frameHint.hidden = text === '';
  };

  /** D6 同步状态：只显示一行小字，失败不打断问答。 */
  const renderSyncStatus = (next: SyncStatus) => {
    syncLine.classList.remove('vt-sync-error');
    if (!next.enabled) {
      syncLine.textContent = '同步已关闭';
      syncLine.title = '在设置页开启本地落盘同步';
      return;
    }
    if (next.pending > 0) {
      syncLine.textContent = `待同步 ${next.pending} 条`;
      syncLine.title = '点击手动重试同步';
      return;
    }
    if (next.failed > 0) {
      syncLine.textContent = `同步失败 ${next.failed} 条`;
      syncLine.title = '点击重试；仍然失败请检查 companion';
      syncLine.classList.add('vt-sync-error');
      return;
    }
    if (next.lastError) {
      syncLine.textContent = 'companion 未连接';
      syncLine.title = `${next.lastError}；点击重试`;
      syncLine.classList.add('vt-sync-error');
      return;
    }
    syncLine.textContent = '已同步';
    syncLine.title = next.url;
  };

  const refreshSync = async () => {
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'sync:status' })) as
        | SyncStatus
        | undefined;
      if (response) renderSyncStatus(response);
    } catch {
      syncLine.textContent = '同步状态未知';
      syncLine.classList.add('vt-sync-error');
    }
  };

  const stopSyncPolling = () => {
    if (syncTimer !== 0) {
      window.clearInterval(syncTimer);
      syncTimer = 0;
    }
  };

  const startSyncPolling = () => {
    stopSyncPolling();
    syncTimer = window.setInterval(() => {
      if (!panel.hidden) void refreshSync();
    }, 5000);
  };

  syncLine.addEventListener('click', () => {
    if (syncBusy) return;
    syncBusy = true;
    syncLine.textContent = '同步中…';
    void chrome.runtime
      .sendMessage({ type: 'sync:flush' })
      .then(() => refreshSync())
      .catch(() => {
        syncLine.textContent = '同步失败';
        syncLine.classList.add('vt-sync-error');
      })
      .finally(() => {
        syncBusy = false;
      });
  });

  /** D10 用量：只显示今日/本月，失败保持上一次的值，不打断输入。 */
  const renderUsage = (ledger: UsageLedger) => {
    usageLine.textContent = `今日 ${formatCny(ledger.dayCny)} · 本月 ${formatCny(ledger.monthCny)}`;
    usageLine.title = `累计 ${formatCny(ledger.totalCny)}；点击刷新`;
  };

  const refreshUsage = async () => {
    try {
      const response = (await chrome.runtime.sendMessage({ type: 'usage:get' })) as
        | { ok?: boolean; ledger?: UsageLedger }
        | undefined;
      if (response?.ok && response.ledger) renderUsage(response.ledger);
    } catch {
      // 用量只是辅助信息，读不到就保持现状。
    }
  };

  usageLine.addEventListener('click', () => {
    usageLine.textContent = '刷新中…';
    void refreshUsage();
  });

  /** 截图时藏起会入镜的东西：弹幕总是藏；面板只有压住画面时才藏，免得闪一下。 */
  const setCapturing = (on: boolean, hidePanel = true) => {
    ball.style.visibility = on ? 'hidden' : '';
    panel.style.visibility = on && hidePanel ? 'hidden' : '';
    setDanmakuHidden(on);
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

  /* -------- D5 大纲 -------- */

  function outlineInfoKey(next: VideoInfo): string {
    return `${next.bvid}:${next.p}:${next.cid ?? 'nocid'}`;
  }

  function setOutlineExpanded(open: boolean): void {
    outlineExpanded = open;
    outlineBody.hidden = !open;
    outlineHead.setAttribute('aria-expanded', String(open));
  }

  function renderOutlineState(): void {
    if (outlineGenerating) {
      if (outlineCapturing) {
        outlineState.textContent = `正在抓画面（第 ${outlineCaptureDone} 帧）`;
      } else {
        outlineState.textContent = '生成中…';
      }
    } else if (asrTranscribing) {
      outlineState.textContent = '转写中…';
    } else if (!outlineError.hidden) {
      outlineState.textContent = '失败';
    } else if (outline) {
      outlineState.textContent = `${outline.segments.length} 段`;
    } else if (asrDone) {
      outlineState.textContent = '已转写';
    } else {
      outlineState.textContent = '未生成';
    }
    outlineGenerate.disabled = outlineGenerating || asrTranscribing;
    outlineGenerate.textContent = outlineGenerating
      ? outlineCapturing
        ? `抓画面 ${outlineCaptureDone}/${outlineCaptureTotal}`
        : '生成中…'
      : '生成大纲';
    updateAsrButton();
  }

  function setOutlineActive(index: number): void {
    if (index === outlineActiveIndex) return;
    outlineActiveIndex = index;
    outlineList.querySelectorAll<HTMLElement>('.vt-outline-item').forEach((item, itemIndex) => {
      const active = itemIndex === index;
      item.classList.toggle('vt-outline-active', active);
      if (active) item.setAttribute('aria-current', 'true');
      else item.removeAttribute('aria-current');
    });
  }

  function applyOutlineActive(): void {
    const segments = outline?.segments ?? [];
    if (segments.length === 0) {
      setOutlineActive(-1);
      return;
    }
    const at = getPlaybackTime();
    let index = segments.findIndex(segment => at >= segment.start && at < segment.end);
    if (index < 0 && at >= segments[segments.length - 1].end) index = segments.length - 1;
    setOutlineActive(index);
  }

  function renderOutlineList(): void {
    outlineList.replaceChildren();
    outlineActiveIndex = -1;
    if (!outline || outline.segments.length === 0) {
      outlineList.hidden = true;
      return;
    }
    outline.segments.forEach((segment, index) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vt-outline-item';
      button.dataset.index = String(index);
      button.dataset.start = String(segment.start);
      button.dataset.end = String(segment.end);
      const time = document.createElement('span');
      time.className = 'vt-outline-time';
      time.textContent = formatTimestamp(segment.start);
      const name = document.createElement('span');
      name.className = 'vt-outline-name';
      name.textContent = segment.title;
      button.append(time, name);
      item.append(button);
      outlineList.append(item);
    });
    outlineList.hidden = false;
    applyOutlineActive();
  }

  function renderOutline(): void {
    outlineGenerate.disabled = outlineGenerating;
    outlineGenerate.textContent = outlineGenerating
      ? outlineCapturing
        ? `抓画面 ${outlineCaptureDone}/${outlineCaptureTotal}`
        : '生成中…'
      : '生成大纲';
    if (outline) {
      outlineEmpty.hidden = true;
      outlineError.hidden = true;
      renderOutlineList();
    } else {
      outlineList.hidden = true;
      outlineList.replaceChildren();
      outlineActiveIndex = -1;
      outlineEmpty.hidden = !outlineError.hidden;
    }
    outlineFoot.hidden = !outline || outline.segments.length === 0;
    renderOutlineState();
  }

  function setOutlineError(message: string, retry: () => void): void {
    outlineEmpty.hidden = true;
    outlineList.hidden = true;
    outlineFoot.hidden = true;
    outlineError.hidden = false;
    outlineErrorText.textContent = message;
    outlineRetryAction = retry;
    renderOutlineState();
  }

  function clearOutlineError(): void {
    outlineError.hidden = true;
    outlineErrorText.textContent = '';
    outlineRetryAction = null;
  }

  function resetOutline(): void {
    outline = null;
    outlineGenerating = false;
    outlineGetToken += 1;
    // 切 P 时让正在进行的抓帧循环看到 token 变化并中止。
    outlineRunToken += 1;
    outlineCapturing = false;
    outlineCaptureDone = 0;
    outlineCaptureTotal = 0;
    outlineActiveIndex = -1;
    asrRunToken += 1;
    asrTranscribing = false;
    asrDone = false;
    asrSegments = 0;
    asrKey = outlineInfoKey(currentInfo);
    outlineEmptyText.textContent = OUTLINE_EMPTY_TEXT;
    outlineList.replaceChildren();
    outlineList.hidden = true;
    outlineEmpty.hidden = false;
    clearOutlineError();
    renderOutlineState();
    if (!panel.hidden) void loadOutline();
  }

  async function loadOutline(): Promise<void> {
    const requested = currentInfo;
    const key = outlineInfoKey(requested);
    const token = ++outlineGetToken;
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'outline:get',
        bvid: requested.bvid,
        p: requested.p,
        cid: requested.cid,
        duration: requested.duration ?? 0,
      })) as OutlineGetResponse | undefined;
      if (token !== outlineGetToken || outlineInfoKey(currentInfo) !== key) return;
      if (!response) throw new Error('读取大纲失败');
      if (!response.ok) throw new Error(response.message || '读取大纲失败');
      if (outlineGenerating) return;
      outline = response.outline;
      clearOutlineError();
      outlineEmptyText.textContent = OUTLINE_EMPTY_TEXT;
      renderOutline();
    } catch (error) {
      if (token !== outlineGetToken || outlineInfoKey(currentInfo) !== key) return;
      if (outlineGenerating) return;
      setOutlineError(
        `读取大纲失败：${error instanceof Error ? error.message : String(error)}`,
        () => void loadOutline(),
      );
    }
  }

  function setOutlineCaptureProgress(done: number, total: number): void {
    outlineCapturing = true;
    outlineCaptureDone = done;
    outlineCaptureTotal = total;
    outlineEmpty.hidden = false;
    outlineList.hidden = true;
    outlineFoot.hidden = true;
    outlineError.hidden = true;
    outlineEmptyText.textContent = `正在抓画面 ${done}/${total}…`;
    renderOutlineState();
  }

  /** 面板压住画面一大块时才在截图中藏起来；边缘蹭到不算。 */
  function panelCoversVideo(target: { rect: QaRect }): boolean {
    const panelRect = panel.getBoundingClientRect();
    const overlapWidth = Math.max(
      0,
      Math.min(panelRect.right, target.rect.x + target.rect.width) -
        Math.max(panelRect.left, target.rect.x),
    );
    const overlapHeight = Math.max(
      0,
      Math.min(panelRect.bottom, target.rect.y + target.rect.height) -
        Math.max(panelRect.top, target.rect.y),
    );
    return overlapWidth * overlapHeight > panelRect.width * panelRect.height * 0.15;
  }

  /** 等 seeked，最多 3 秒；目标时间和当前位置几乎一样时直接返回。 */
  function seekAndWait(video: HTMLVideoElement, seconds: number): Promise<void> {
    const duration = Number.isFinite(video.duration) ? video.duration : seconds;
    const target = Math.max(0, Math.min(seconds, duration));
    if (Math.abs(video.currentTime - target) < 0.05) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      let timer = 0;
      const finish = () => {
        if (done) return;
        done = true;
        window.clearTimeout(timer);
        video.removeEventListener('seeked', finish);
        resolve();
      };
      timer = window.setTimeout(finish, 3000);
      video.addEventListener('seeked', finish);
      video.currentTime = target;
    });
  }

  /**
   * 无字幕兜底：逐帧暂停、seek、等稳定后请 background 截一张。
   * 视频状态在 finally 里恢复；切 P 时 run token 变化，循环中止且不把旧时间写回新视频。
   */
  async function captureOutlineFrames(
    times: number[],
    key: string,
    run: number,
    onProgress: (done: number, total: number) => void,
  ): Promise<QaFrame[]> {
    const video = getVideoElement();
    if (!video) throw new Error('找不到视频画面');
    const firstTarget = getVisibleVideoRect();
    if (!firstTarget) throw new Error('视频画面没有完整显示，无法抓取画面');

    const originalTime = video.currentTime;
    const wasPaused = video.paused;
    const hidePanel = panelCoversVideo(firstTarget);
    const frames: QaFrame[] = [];
    let restored = false;

    const restore = async () => {
      if (restored) return;
      restored = true;
      setCapturing(false);
      const sameVideo = run === outlineRunToken && outlineInfoKey(currentInfo) === key;
      if (!sameVideo) return;
      await seekAndWait(video, originalTime);
      if (!wasPaused) void video.play().catch(() => undefined);
    };

    try {
      onProgress(0, times.length);
      setCapturing(true, hidePanel);
      for (let index = 0; index < times.length; index += 1) {
        if (run !== outlineRunToken || outlineInfoKey(currentInfo) !== key) throw new Error('已取消');
        video.pause();
        await seekAndWait(video, times[index]);
        // 等解码后的那一帧真正上屏；只等 seeked 会截到上一帧。
        await new Promise<void>(resolve => window.setTimeout(resolve, 250));
        if (run !== outlineRunToken || outlineInfoKey(currentInfo) !== key) throw new Error('已取消');

        const target = getVisibleVideoRect();
        if (!target) throw new Error('视频画面没有完整显示，无法抓取画面');
        // 每帧重置 5s 兜底计时器，长视频 10 帧也不会中途把面板放回来。
        setCapturing(true, hidePanel);
        const response = (await chrome.runtime.sendMessage({
          type: 'frame:capture',
          rect: target.rect,
          viewport: target.viewport,
        })) as FrameCaptureResponse | undefined;
        if (!response || !response.ok) {
          throw new Error(response?.message ?? '截图失败');
        }
        // background 不知道这张图对应哪个取样点，at 由 content 按 times 补。
        frames.push({ ...response.frame, at: times[index] });
        onProgress(frames.length, times.length);
      }
      return frames;
    } finally {
      await restore();
    }
  }

  async function generateOutline(): Promise<void> {
    if (outlineGenerating) return;
    const requested = currentInfo;
    const key = outlineInfoKey(requested);
    if (!requested.duration || requested.duration <= 0) {
      setOutlineError('还不知道视频时长，暂时不能生成大纲。', () => void generateOutline());
      return;
    }

    const run = ++outlineRunToken;
    outlineGenerating = true;
    outlineCapturing = false;
    outlineCaptureDone = 0;
    outlineCaptureTotal = 0;
    clearOutlineError();
    outlineEmpty.hidden = false;
    outlineEmptyText.textContent = '正在生成大纲，请稍候…';
    renderOutlineState();

    const sendGenerate = (frames?: QaFrame[]) =>
      chrome.runtime.sendMessage({
        type: 'outline:generate',
        bvid: requested.bvid,
        p: requested.p,
        cid: requested.cid,
        title: requested.title,
        duration: requested.duration,
        frames,
      }) as Promise<OutlineGenerateResponse | undefined>;

    const fail = (message: string) => {
      if (run !== outlineRunToken || outlineInfoKey(currentInfo) !== key) return;
      outlineGenerating = false;
      outlineCapturing = false;
      outlineCaptureDone = 0;
      outlineCaptureTotal = 0;
      setOutlineError(message, () => void generateOutline());
    };

    try {
      let response = await sendGenerate();
      if (run !== outlineRunToken || outlineInfoKey(currentInfo) !== key) return;

      if (!response) {
        fail('大纲生成失败，请重试');
        return;
      }

      // 第一级/第二级都没有：字幕接口判了 no-subtitle，且章节不足 2 段。
      if (!response.ok && response.code === 'no-subtitle') {
        const times = outlineFrameTimes(requested.duration);
        let frames: QaFrame[] = [];
        try {
          frames = await captureOutlineFrames(times, key, run, setOutlineCaptureProgress);
        } catch (error) {
          if (run !== outlineRunToken || outlineInfoKey(currentInfo) !== key) return;
          const detail = error instanceof Error ? error.message : String(error);
          if (detail === '已取消') return;
          fail(`没有字幕，抓取画面也失败了：${detail}`);
          return;
        }
        if (run !== outlineRunToken || outlineInfoKey(currentInfo) !== key) return;
        if (frames.length === 0) {
          fail('没有字幕，也没有抓到可用的画面，暂时不能生成大纲。');
          return;
        }

        outlineCapturing = false;
        outlineCaptureDone = 0;
        outlineCaptureTotal = 0;
        outlineEmpty.hidden = false;
        outlineEmptyText.textContent = '正在生成大纲，请稍候…';
        renderOutlineState();
        response = await sendGenerate(frames);
        if (run !== outlineRunToken || outlineInfoKey(currentInfo) !== key) return;
      }

      if (!response) {
        fail('大纲生成失败，请重试');
        return;
      }
      if (!response.ok) {
        fail(response.message || '大纲生成失败，请重试');
        return;
      }

      outlineGenerating = false;
      outlineCapturing = false;
      outline = response.outline;
      clearOutlineError();
      outlineEmptyText.textContent = OUTLINE_EMPTY_TEXT;
      renderOutline();
      window.setTimeout(() => void refreshSync(), 600);
    } catch (error) {
      if (run !== outlineRunToken || outlineInfoKey(currentInfo) !== key) return;
      fail(`大纲生成失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function jumpToOutlineSegment(index: number): void {
    const segment = outline?.segments[index];
    if (!segment) return;
    const video = getVideoElement();
    // 大纲用于预习/跳转，默认不因为点击而开始播放；jumpAutoPlay 显式打开时才播。
    if (video && !video.paused) video.pause();
    seekVideo(segment.start, { autoPlay: settings?.jumpAutoPlay === true });
    setOutlineActive(index);
  }

  /* -------- D8 语音转写 -------- */

  function updateAsrButton(): void {
    const minutes = Math.max(1, Math.ceil((currentInfo.duration ?? 0) / 60));
    const configured = Boolean(settings?.asrApiKey.trim());
    if (asrDone) {
      outlineAsr.textContent = '已转写';
      outlineAsr.disabled = true;
      outlineAsr.title = `已缓存 ${asrSegments} 句转写字幕`;
      outlineAsrHint.textContent = `已缓存 ${asrSegments} 句`;
      return;
    }
    outlineAsr.textContent = `转写这段（约 ${minutes} 分钟）`;
    outlineAsr.disabled = asrTranscribing || outlineGenerating || !configured;
    if (!configured) {
      outlineAsr.title = '先在设置页填写语音转写 Key';
      outlineAsrHint.textContent = '先在设置页填写语音转写 Key';
    } else if (asrTranscribing) {
      outlineAsr.title = '';
      outlineAsrHint.textContent = '正在转写，可继续使用问答';
    } else {
      outlineAsr.title = '没有字幕时，用语音转写生成带时间戳的字幕';
      outlineAsrHint.textContent = '';
    }
  }

  function setAsrProgress(progress: AsrProgress): void {
    asrTranscribing = true;
    asrDone = false;
    clearOutlineError();
    outlineEmpty.hidden = false;
    outlineList.hidden = true;
    const done = Math.max(0, Math.floor(progress.done));
    const total = Math.max(1, Math.floor(progress.total));
    if (progress.stage === 'download') {
      outlineEmptyText.textContent = `正在下载音轨 ${done}/${total}…`;
    } else if (progress.stage === 'slice') {
      outlineEmptyText.textContent = `正在切片 ${done}/${total}…`;
    } else {
      outlineEmptyText.textContent = `正在转写 ${done}/${total}…`;
    }
    renderOutlineState();
  }

  function asrMatchesCurrent(message: {
    bvid?: unknown;
    p?: unknown;
    cid?: unknown;
  }): boolean {
    return (
      message.bvid === currentInfo.bvid &&
      message.p === currentInfo.p &&
      (message.cid ?? undefined) === (currentInfo.cid ?? undefined)
    );
  }

  function failAsr(message: string, run: number): void {
    if (run !== asrRunToken || asrKey !== outlineInfoKey(currentInfo)) return;
    asrTranscribing = false;
    setOutlineError(`转写失败：${message}`, () => void startAsr());
  }

  const onAsrMessage = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const message = raw as {
      type?: string;
      bvid?: string;
      p?: number;
      cid?: number;
      stage?: AsrProgress['stage'];
      done?: number;
      total?: number;
      asr?: AsrResult;
      error?: AsrError;
    };
    if (!asrMatchesCurrent(message)) return;

    if (message.type === 'asr:progress') {
      if (!message.stage) return;
      setAsrProgress({
        stage: message.stage,
        done: typeof message.done === 'number' ? message.done : 0,
        total: typeof message.total === 'number' ? message.total : 1,
      });
      return;
    }
    if (message.type === 'asr:done' && message.asr) {
      asrTranscribing = false;
      asrDone = true;
      asrSegments = message.asr.segments.length;
      asrKey = outlineInfoKey(currentInfo);
      clearOutlineError();
      outlineEmpty.hidden = false;
      outlineEmptyText.textContent = `转写完成，已缓存 ${asrSegments} 句字幕。`;
      renderOutlineState();
      return;
    }
    if (message.type === 'asr:error') {
      failAsr(message.error?.message ?? '转写失败', asrRunToken);
    }
  };
  chrome.runtime.onMessage.addListener(onAsrMessage);

  async function startAsr(): Promise<void> {
    if (asrTranscribing || outlineGenerating) return;
    if (!settings?.asrApiKey.trim()) {
      updateAsrButton();
      return;
    }
    if (!currentInfo.cid || !currentInfo.duration || currentInfo.duration <= 0) {
      setOutlineError('还不知道当前分 P 的信息，暂时不能转写。', () => void startAsr());
      return;
    }

    const requested = currentInfo;
    const run = ++asrRunToken;
    asrKey = outlineInfoKey(requested);
    asrTranscribing = true;
    asrDone = false;
    asrSegments = 0;
    clearOutlineError();
    outlineEmpty.hidden = false;
    outlineEmptyText.textContent = '正在准备音轨…';
    renderOutlineState();

    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'asr:transcribe',
        bvid: requested.bvid,
        p: requested.p,
        cid: requested.cid,
        title: requested.title,
        duration: requested.duration,
      })) as { ok?: boolean; message?: string } | undefined;
      if (run !== asrRunToken || asrKey !== outlineInfoKey(currentInfo)) return;
      if (!response) {
        failAsr('后台没有响应', run);
        return;
      }
      if (!response.ok) failAsr(response.message ?? '转写失败', run);
    } catch (error) {
      failAsr(error instanceof Error ? error.message : String(error), run);
    }
  }

  outlineAsr.addEventListener('click', () => void startAsr());

  outlineHead.addEventListener('click', () => setOutlineExpanded(!outlineExpanded));
  outlineGenerate.addEventListener('click', () => void generateOutline());
  outlineRefresh.addEventListener('click', () => {
    if (outlineGenerating) return;
    outline = null;
    renderOutline();
    void generateOutline();
  });
  outlineRetry.addEventListener('click', () => {
    const retry = outlineRetryAction;
    outlineRetryAction = null;
    retry?.();
  });
  outlineList.addEventListener('click', event => {
    const item = (event.target as HTMLElement | null)?.closest<HTMLElement>('.vt-outline-item');
    if (!item) return;
    const index = Number(item.dataset.index);
    if (Number.isInteger(index) && index >= 0) jumpToOutlineSegment(index);
  });

  const onOutlineTimeupdate = (event: Event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    const now = Date.now();
    if (now - lastOutlineTimeupdate < 1000) return;
    lastOutlineTimeupdate = now;
    applyOutlineActive();
  };
  const onOutlineSeeked = (event: Event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    lastOutlineTimeupdate = 0;
    applyOutlineActive();
  };
  document.addEventListener('timeupdate', onOutlineTimeupdate, true);
  document.addEventListener('seeked', onOutlineSeeked, true);

  setOutlineExpanded(true);
  renderOutline();

  /* -------- 问答 -------- */

  const scrollAnswers = (force = false) => {
    // 用户往上翻历史时不要把他拽回底部；只有本来就在底部附近才跟随。
    const distance = answers.scrollHeight - answers.scrollTop - answers.clientHeight;
    if (force || distance < 60) answers.scrollTop = answers.scrollHeight;
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
    scrollAnswers(true);
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

  /** 为截图暂停的视频，等后台截完就恢复播放。 */
  let resumeAfterFrame = false;
  const restorePlayback = () => {
    if (!resumeAfterFrame) return;
    resumeAfterFrame = false;
    const video = getVideoElement();
    if (video && video.paused) void video.play().catch(() => undefined);
  };

  const handleServerMessage = (message: QaServerMessage) => {
    if (!message || message.type === 'qa:pong') return;
    if (message.requestId !== activeRequestId) return;
    // 后台发回任何消息都说明截图阶段已结束（qa:start 在截图之后才发）。
    setCapturing(false);
    restorePlayback();
    switch (message.type) {
      case 'qa:frame':
        return;
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
        const cost = Number.isFinite(message.costCny) ? message.costCny : 0;
        finishStream(
          message.text,
          `${message.usage.totalTokens} tokens · ${seconds}s · ≈${formatCny(cost)}`,
        );
        const scope = lastWindow?.noSubtitle ? ' · 无字幕 · 只能按标题回答' : '';
        status.textContent = `完成 · ${message.usage.totalTokens} tokens${scope}`;
        setBusy(false);
        // 这一轮已经落库，下次打开面板能看到「清空记录」。
        historyHead.hidden = false;
        // 入队/flush 是后台异步的，稍等再看状态。
        window.setTimeout(() => {
          void refreshSync();
          void refreshUsage();
        }, 600);
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
      askedFrame = false;
      setFrameHint('');
      let target: { rect: QaRect; viewport: QaViewport } | null = null;
      if (settings.frameEnabled) {
        target = getVisibleVideoRect();
        if (!target) setFrameHint('视频画面没有完整显示，先滚动到画面再问');
      }
      // 只有真要截图时才暂停：截完 background 会发 qa:frame，这里立刻恢复播放。
      resumeAfterFrame = Boolean(target && video && !video.paused);
      if (resumeAfterFrame && video) video.pause();
      // 兜底：万一后台没回消息，3 秒后也别让视频一直停着。
      window.setTimeout(restorePlayback, 3000);

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

      // 刚为我们暂停时等最后一帧稳定，避免截到旧帧；本来已暂停则不需要等。
      if (askedFrame && resumeAfterFrame) await sleep(300);
      if (askedFrame && target) {
        setFrameHint('附当前画面');
        // 只有面板遮住画面一大块时才藏；边缘蹭到一条不算，免得每次提问都闪一下。
        const panelRect = panel.getBoundingClientRect();
        const overlapWidth = Math.max(
          0,
          Math.min(panelRect.right, target.rect.x + target.rect.width) -
            Math.max(panelRect.left, target.rect.x),
        );
        const overlapHeight = Math.max(
          0,
          Math.min(panelRect.bottom, target.rect.y + target.rect.height) -
            Math.max(panelRect.top, target.rect.y),
        );
        const covered = overlapWidth * overlapHeight;
        const hidePanel = covered > panelRect.width * panelRect.height * 0.15;
        setCapturing(true, hidePanel);
      }

      const requestId = `q${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      activeRequestId = requestId;
      streamTurn = addTurn(trimmed);
      input.value = '';
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
    if (event.key === 'Escape') {
      panel.hidden = true;
      stopSyncPolling();
    }
  };
  document.addEventListener('keydown', onKeyDown);

  /* -------- 悬浮球拖动：球是把手，面板自动贴边 -------- */

  const BALL_POS_KEY = 'ball:pos';
  const PANEL_GAP = 12;
  const EDGE = 8;

  const clampValue = (value: number, min: number, max: number) =>
    Math.min(Math.max(value, min), Math.max(min, max));

  const placeBall = (x: number, y: number) => {
    const size = ball.offsetWidth || 48;
    ball.style.left = `${clampValue(x, EDGE, window.innerWidth - size - EDGE)}px`;
    ball.style.top = `${clampValue(y, EDGE, window.innerHeight - size - EDGE)}px`;
    ball.style.right = 'auto';
  };

  const placePanelNearBall = (side?: 'left' | 'right') => {
    if (panel.hidden) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const rect = ball.getBoundingClientRect();
    // 拖动过程中锁定在球的一侧，避免划过边界时面板左右横跳。
    const preferLeft =
      side === 'left' ||
      (side === undefined && rect.right + PANEL_GAP + width > window.innerWidth - EDGE);
    const left = preferLeft ? rect.left - width - PANEL_GAP : rect.right + PANEL_GAP;
    const top = rect.top + rect.height / 2 - height / 2;
    panel.style.left = `${clampValue(left, EDGE, window.innerWidth - width - EDGE)}px`;
    panel.style.top = `${clampValue(top, EDGE, window.innerHeight - height - EDGE)}px`;
    panel.style.right = 'auto';
  };

  void chrome.storage.local.get(BALL_POS_KEY).then(saved => {
    const pos = (saved as Record<string, unknown> | undefined)?.[BALL_POS_KEY];
    if (!pos || typeof pos !== 'object') return;
    const { x, y } = pos as { x?: unknown; y?: unknown };
    if (typeof x === 'number' && typeof y === 'number') placeBall(x, y);
  });

  let ballDrag: { dx: number; dy: number; moved: boolean } | null = null;
  let dragSide: 'left' | 'right' | null = null;
  let suppressBallClick = false;

  ball.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    const rect = ball.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    dragSide =
      panelRect.width > 0 && panelRect.left + panelRect.width / 2 < rect.left + rect.width / 2
        ? 'left'
        : 'right';
    // 拖动期间不做过渡，否则面板会拖尾。
    panel.style.transition = 'none';
    ballDrag = { dx: event.clientX - rect.left, dy: event.clientY - rect.top, moved: false };
    ball.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  ball.addEventListener('pointermove', event => {
    if (!ballDrag) return;
    const rect = ball.getBoundingClientRect();
    const x = event.clientX - ballDrag.dx;
    const y = event.clientY - ballDrag.dy;
    if (Math.abs(x - rect.left) + Math.abs(y - rect.top) > 3) ballDrag.moved = true;
    placeBall(x, y);
    placePanelNearBall(dragSide ?? undefined);
  });

  const endBallDrag = (event: PointerEvent) => {
    if (!ballDrag) return;
    const moved = ballDrag.moved;
    ballDrag = null;
    if (ball.hasPointerCapture(event.pointerId)) ball.releasePointerCapture(event.pointerId);
    if (moved) {
      const rect = ball.getBoundingClientRect();
      void chrome.storage.local.set({
        [BALL_POS_KEY]: { x: Math.round(rect.left), y: Math.round(rect.top) },
      });
    }
    // 松手后恢复过渡，并按最终位置重新选边。
    panel.style.transition = '';
    dragSide = null;
    placePanelNearBall();
    suppressBallClick = moved;
    window.setTimeout(() => {
      suppressBallClick = false;
    }, 0);
  };
  ball.addEventListener('pointerup', endBallDrag);
  ball.addEventListener('pointercancel', endBallDrag);

  const onResize = () => {
    const rect = ball.getBoundingClientRect();
    placeBall(rect.left, rect.top);
    placePanelNearBall();
  };
  window.addEventListener('resize', onResize);

  /* -------- 键盘隔离：面板里的按键不喂给 B 站播放器 -------- */

  const keepKeysInside = (event: KeyboardEvent) => {
    if (event.key === 'Escape') return;
    event.stopPropagation();
  };
  panel.addEventListener('keydown', keepKeysInside);
  panel.addEventListener('keyup', keepKeysInside);

  document.body.appendChild(host);

  return {
    toggle,
    update: render,
    destroy() {
      outlineRunToken += 1;
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('play', onPlayPause, true);
      document.removeEventListener('pause', onPlayPause, true);
      document.removeEventListener('timeupdate', onOutlineTimeupdate, true);
      document.removeEventListener('seeked', onOutlineSeeked, true);
      chrome.runtime.onMessage.removeListener(onAsrMessage);
      stopSyncPolling();
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
