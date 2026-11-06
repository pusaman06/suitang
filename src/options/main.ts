import { formatCny } from '../shared/cost';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings';
import { formatCueTime } from '../shared/subtitles';
import type { SubtitleResult, VideoMeta } from '../shared/types';
import type { UsageLedger } from '../shared/usage-store';

const apiKey = el<HTMLInputElement>('#api-key');
const visionModel = el<HTMLInputElement>('#vision-model');
const textModel = el<HTMLInputElement>('#text-model');
const thinking = el<HTMLInputElement>('#thinking');
const frameEnabled = el<HTMLInputElement>('#frame-enabled');
const asrApiKey = el<HTMLInputElement>('#asr-api-key');
const asrModel = el<HTMLSelectElement>('#asr-model');
const jumpAutoPlay = el<HTMLInputElement>('#jump-autoplay');
const contextWindow = el<HTMLInputElement>('#context-window');
const maxTokens = el<HTMLInputElement>('#max-tokens');
const historyTurns = el<HTMLInputElement>('#history-turns');
const monthlyBudget = el<HTMLInputElement>('#monthly-budget');
const usageMonth = el<HTMLElement>('#usage-month');
const usageTotal = el<HTMLElement>('#usage-total');
const budgetLabel = el<HTMLElement>('#budget-label');
const budgetFill = el<HTMLElement>('#budget-fill');
const balanceValue = el<HTMLElement>('#balance-value');
const balanceStatus = el<HTMLParagraphElement>('#balance-status');
const refreshBalance = el<HTMLButtonElement>('#refresh-balance');
const apiBaseUrl = el<HTMLInputElement>('#api-base-url');
const companionUrl = el<HTMLInputElement>('#companion-url');
const save = el<HTMLButtonElement>('#save');
const status = el<HTMLParagraphElement>('#status');
const diagPing = el<HTMLButtonElement>('#diag-ping');
const diagSub = el<HTMLButtonElement>('#diag-sub');
const diagLog = el<HTMLPreElement>('#diag-log');

function el<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`options page is missing ${selector}`);
  return node;
}

interface BalanceInfo {
  currency?: string;
  total_balance?: string;
}

let lastLedger: UsageLedger | null = null;
let budgetCny = 0;

function renderBudget(): void {
  const spentCny = lastLedger?.monthCny ?? 0;
  if (budgetCny <= 0) {
    budgetLabel.textContent = '未设置';
    budgetFill.style.width = '0%';
    return;
  }
  const percent = Math.min(100, Math.max(0, (spentCny / budgetCny) * 100));
  budgetLabel.textContent = `本月 ${formatCny(lastLedger?.monthCny ?? 0)} / 预算 ¥${budgetCny.toFixed(2)}`;
  budgetFill.style.width = `${percent}%`;
}

function renderUsage(ledger: UsageLedger): void {
  lastLedger = ledger;
  usageMonth.textContent = formatCny(ledger.monthCny);
  usageTotal.textContent = formatCny(ledger.totalCny);
  renderBudget();
}

async function loadUsage(): Promise<void> {
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'usage:get' })) as
      | { ok?: boolean; ledger?: UsageLedger; message?: string }
      | undefined;
    if (response?.ok && response.ledger) renderUsage(response.ledger);
  } catch {
    // 用量读取失败不影响设置保存。
  }
}

async function loadBalance(): Promise<void> {
  refreshBalance.disabled = true;
  balanceStatus.textContent = '读取中…';
  try {
    const response = (await chrome.runtime.sendMessage({ type: 'usage:balance' })) as
      | { ok?: boolean; balances?: BalanceInfo[]; message?: string }
      | undefined;
    if (!response?.ok) {
      balanceStatus.textContent = response?.message ?? '读取余额失败';
      return;
    }
    const infos = response.balances ?? [];
    balanceValue.textContent =
      infos.length === 0
        ? '暂无余额信息'
        : infos
            .map(info => `${info.currency ?? 'CNY'} ${info.total_balance ?? '0.00'}`)
            .join(' / ');
    balanceStatus.textContent = '';
  } catch (error) {
    balanceStatus.textContent = `读取余额失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    refreshBalance.disabled = false;
  }
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  apiKey.value = settings.apiKey;
  visionModel.value = settings.visionModel;
  textModel.value = settings.textModel;
  thinking.checked = settings.thinking;
  frameEnabled.checked = settings.frameEnabled;
  asrApiKey.value = settings.asrApiKey;
  asrModel.value = settings.asrModel;
  jumpAutoPlay.checked = settings.jumpAutoPlay;
  contextWindow.value = String(settings.contextWindowSec);
  maxTokens.value = String(settings.maxTokens);
  historyTurns.value = String(settings.historyTurns);
  budgetCny = settings.monthlyBudgetCny;
  monthlyBudget.value = settings.monthlyBudgetCny > 0 ? String(settings.monthlyBudgetCny) : '';
  apiBaseUrl.value = settings.apiBaseUrl === DEFAULT_SETTINGS.apiBaseUrl ? '' : settings.apiBaseUrl;
  companionUrl.value =
    settings.companionUrl === DEFAULT_SETTINGS.companionUrl ? '' : settings.companionUrl;
  renderBudget();
  void loadUsage();
}

refreshBalance.addEventListener('click', () => {
  void loadBalance();
});

save.addEventListener('click', () => {
  void saveSettings({
    apiKey: apiKey.value.trim(),
    visionModel: visionModel.value.trim() || DEFAULT_SETTINGS.visionModel,
    textModel: textModel.value.trim() || DEFAULT_SETTINGS.textModel,
    thinking: thinking.checked,
    frameEnabled: frameEnabled.checked,
    asrApiKey: asrApiKey.value.trim(),
    asrModel: asrModel.value || DEFAULT_SETTINGS.asrModel,
    jumpAutoPlay: jumpAutoPlay.checked,
    contextWindowSec: Number(contextWindow.value) || DEFAULT_SETTINGS.contextWindowSec,
    maxTokens: Number(maxTokens.value) || DEFAULT_SETTINGS.maxTokens,
    historyTurns: Number(historyTurns.value),
    monthlyBudgetCny: Number(monthlyBudget.value) || 0,
    apiBaseUrl: apiBaseUrl.value.trim(),
    companionUrl: companionUrl.value.trim(),
  }).then(next => {
    contextWindow.value = String(next.contextWindowSec);
    maxTokens.value = String(next.maxTokens);
    historyTurns.value = String(next.historyTurns);
    budgetCny = next.monthlyBudgetCny;
    monthlyBudget.value = next.monthlyBudgetCny > 0 ? String(next.monthlyBudgetCny) : '';
    renderBudget();
    asrApiKey.value = next.asrApiKey;
    asrModel.value = next.asrModel;
    jumpAutoPlay.checked = next.jumpAutoPlay;
    companionUrl.value =
      next.companionUrl === DEFAULT_SETTINGS.companionUrl ? '' : next.companionUrl;
    status.textContent = '已保存';
    window.setTimeout(() => {
      status.textContent = '';
    }, 1500);
  });
});

void init();

/* -------- 诊断：从设置页驱动后台，不依赖内容面板 -------- */

interface VideoTab {
  tabId: number;
  bvid: string;
  p: number;
}

async function findVideoTab(): Promise<VideoTab | null> {
  const tabs = await chrome.tabs.query({ url: 'https://www.bilibili.com/video/*' });
  const tab = tabs[tabs.length - 1];
  if (!tab?.id || !tab.url) return null;
  const bvid = /\/video\/(BV[0-9A-Za-z]+)/.exec(tab.url)?.[1];
  if (!bvid) return null;
  const p = Number(new URL(tab.url).searchParams.get('p') ?? '1') || 1;
  return { tabId: tab.id, bvid, p };
}

diagPing.addEventListener('click', () => {
  diagLog.textContent = '连接中…';
  void chrome.runtime
    .sendMessage({ type: 'ping' })
    .then(reply => {
      diagLog.textContent = JSON.stringify(reply, null, 2);
    })
    .catch((error: unknown) => {
      diagLog.textContent = `后台未响应：${error instanceof Error ? error.message : String(error)}`;
    });
});

diagSub.addEventListener('click', () => {
  void runSubtitleDiagnostics();
});

async function runSubtitleDiagnostics(): Promise<void> {
  diagSub.disabled = true;
  diagLog.textContent = '拉取字幕…';
  try {
    const tab = await findVideoTab();
    if (!tab) {
      diagLog.textContent = '没有找到打开的视频页，请先打开一个 B 站视频。';
      return;
    }
    const meta = (await chrome.runtime.sendMessage({
      type: 'video-meta',
      bvid: tab.bvid,
      tabId: tab.tabId,
    })) as VideoMeta | null;
    const part = meta?.pages?.find(item => item.page === tab.p) ?? meta?.pages?.[0];
    if (!meta?.aid || !part) {
      diagLog.textContent = '读取视频元数据失败（aid/cid 缺失）。';
      return;
    }
    const result = (await chrome.runtime.sendMessage({
      type: 'subtitle:list',
      bvid: tab.bvid,
      aid: meta.aid,
      cid: part.cid,
      p: part.page,
      duration: part.duration,
      tabId: tab.tabId,
    })) as SubtitleResult;
    if (!result?.ok) {
      const loginHint = result?.needLogin ? '\n请确认浏览器已登录 B 站，然后重试。' : '';
      diagLog.textContent = `字幕失败：${result?.error ?? '未知错误'}${loginHint}`;
      return;
    }
    const lines = (result.cues ?? []).map(
      cue => `[${formatCueTime(cue.from)} → ${formatCueTime(cue.to)}] ${cue.content}`,
    );
    const head = `${result.track?.lan_doc || result.track?.lan || '字幕'} · 共 ${
      result.total ?? 0
    } 条 · ${result.cached ? '缓存' : '新拉取'}`;
    diagLog.textContent = `${head}\n${lines.join('\n')}`;
  } catch (error) {
    diagLog.textContent = `请求失败：${error instanceof Error ? error.message : String(error)}`;
  } finally {
    diagSub.disabled = false;
  }
}
