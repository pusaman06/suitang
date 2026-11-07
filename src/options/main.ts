import { formatCny } from '../shared/cost';
import {
  DEFAULT_SETTINGS,
  isAllowedApiBaseUrl,
  loadSettings,
  OFFICIAL_API_HOST,
  saveSettings,
} from '../shared/settings';
import type { Settings } from '../shared/settings';
import { formatCueTime } from '../shared/subtitles';
import type { SubtitleResult, VideoMeta } from '../shared/types';
import type { UsageLedger } from '../shared/usage-store';
import { CACHE_KEY_PREFIXES } from '../shared/video-record';

const apiKey = el<HTMLInputElement>('#api-key');
const visionModel = el<HTMLInputElement>('#vision-model');
const textModel = el<HTMLInputElement>('#text-model');
const thinking = el<HTMLInputElement>('#thinking');
const frameEnabled = el<HTMLInputElement>('#frame-enabled');
const diagnostics = el<HTMLInputElement>('#diagnostics');
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
const apiBaseHint = el<HTMLSpanElement>('#api-base-hint');
const companionUrl = el<HTMLInputElement>('#companion-url');
const save = el<HTMLButtonElement>('#save');
const status = el<HTMLParagraphElement>('#status');
const diagPing = el<HTMLButtonElement>('#diag-ping');
const diagSub = el<HTMLButtonElement>('#diag-sub');
const diagLog = el<HTMLPreElement>('#diag-log');
const cacheSummary = el<HTMLElement>('#cache-summary');
const cacheClear = el<HTMLButtonElement>('#cache-clear');
const cacheStatus = el<HTMLParagraphElement>('#cache-status');

function el<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`options page is missing ${selector}`);
  return node;
}

/** 已保存的 Key 只在 placeholder 里露末四位，输入框本身永远不回填明文。 */
function keyPlaceholder(saved: string): string {
  const trimmed = saved.trim();
  if (trimmed === '') return 'sk-...';
  // 太短的串取末四位等于泄露大半，宁可什么都不显示。
  if (trimmed.length < 8) return '已保存（不回填显示）';
  return `已保存 sk-…${trimmed.slice(-4)}`;
}

/** 地址框旁的提示：非官方域名要明确说 Key 会发给谁。 */
function renderApiBaseHint(): void {
  const raw = apiBaseUrl.value.trim();
  apiBaseHint.classList.remove('warn');
  if (raw === '') {
    apiBaseHint.textContent = '只接受 https；本机 127.0.0.1 / localhost 可用 http。';
    return;
  }
  if (!isAllowedApiBaseUrl(raw)) {
    apiBaseHint.textContent =
      '地址无效：必须用 https（本机 127.0.0.1 / localhost 可用 http），保存时会回退默认地址。';
    apiBaseHint.classList.add('warn');
    return;
  }
  let host = '';
  try {
    host = new URL(raw).hostname;
  } catch {
    host = '';
  }
  if (host !== OFFICIAL_API_HOST) {
    apiBaseHint.textContent = `Key 会发送给该地址：${host || raw}`;
    apiBaseHint.classList.add('warn');
    return;
  }
  apiBaseHint.textContent = '使用官方地址，Key 只会发给 api.deepseek.com。';
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
  // Key 不回填明文：输入框留空，placeholder 说明已保存（末四位）。
  apiKey.value = '';
  apiKey.placeholder = keyPlaceholder(settings.apiKey);
  visionModel.value = settings.visionModel;
  textModel.value = settings.textModel;
  thinking.checked = settings.thinking;
  frameEnabled.checked = settings.frameEnabled;
  diagnostics.checked = settings.diagnostics;
  asrApiKey.value = '';
  asrApiKey.placeholder = keyPlaceholder(settings.asrApiKey);
  asrModel.value = settings.asrModel;
  jumpAutoPlay.checked = settings.jumpAutoPlay;
  contextWindow.value = String(settings.contextWindowSec);
  maxTokens.value = String(settings.maxTokens);
  historyTurns.value = String(settings.historyTurns);
  budgetCny = settings.monthlyBudgetCny;
  monthlyBudget.value = settings.monthlyBudgetCny > 0 ? String(settings.monthlyBudgetCny) : '';
  apiBaseUrl.value = settings.apiBaseUrl === DEFAULT_SETTINGS.apiBaseUrl ? '' : settings.apiBaseUrl;
  renderApiBaseHint();
  companionUrl.value =
    settings.companionUrl === DEFAULT_SETTINGS.companionUrl ? '' : settings.companionUrl;
  renderBudget();
  void loadUsage();
  void loadCacheStats();
}

apiBaseUrl.addEventListener('input', renderApiBaseHint);

refreshBalance.addEventListener('click', () => {
  void loadBalance();
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function loadCacheStats(): Promise<void> {
  const reply = (await chrome.runtime.sendMessage({ type: 'cache:stats' })) as
    | { ok?: boolean; videos?: number; entries?: number; bytes?: number; message?: string }
    | undefined;
  if (!reply?.ok) {
    cacheSummary.textContent = '统计失败';
    cacheStatus.textContent = reply?.message ?? '后台没有响应';
    return;
  }
  const videos = reply.videos ?? 0;
  if (videos === 0) {
    cacheSummary.textContent = '还没有缓存';
    cacheClear.disabled = true;
    return;
  }
  cacheSummary.textContent = `已缓存 ${videos} 个视频 · ${formatBytes(reply.bytes ?? 0)}`;
  cacheClear.disabled = false;
}

// 别的页面（视频页）边看边写缓存时，这里的数字跟着变。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const touched = Object.keys(changes).some(key =>
    CACHE_KEY_PREFIXES.some(prefix => key.startsWith(prefix)),
  );
  if (touched) void loadCacheStats();
});

cacheClear.addEventListener('click', () => {  void (async () => {
    cacheClear.disabled = true;
    cacheStatus.textContent = '正在清空…';
    const reply = (await chrome.runtime.sendMessage({ type: 'cache:clear-all' })) as
      | { ok?: boolean; cleared?: number; message?: string }
      | undefined;
    if (!reply?.ok) {
      cacheClear.disabled = false;
      cacheStatus.textContent = reply?.message ?? '清空失败';
      return;
    }
    cacheStatus.textContent = `已清空 ${reply.cleared ?? 0} 条（知识库里的那份不受影响）`;
    await loadCacheStats();
  })();
});

save.addEventListener('click', () => {
  const typedApiKey = apiKey.value.trim();
  const typedAsrKey = asrApiKey.value.trim();
  const typedApiBase = apiBaseUrl.value.trim();
  const patch: Partial<Settings> = {
    visionModel: visionModel.value.trim() || DEFAULT_SETTINGS.visionModel,
    textModel: textModel.value.trim() || DEFAULT_SETTINGS.textModel,
    thinking: thinking.checked,
    frameEnabled: frameEnabled.checked,
    diagnostics: diagnostics.checked,
    asrModel: asrModel.value || DEFAULT_SETTINGS.asrModel,
    jumpAutoPlay: jumpAutoPlay.checked,
    contextWindowSec: Number(contextWindow.value) || DEFAULT_SETTINGS.contextWindowSec,
    maxTokens: Number(maxTokens.value) || DEFAULT_SETTINGS.maxTokens,
    historyTurns: Number(historyTurns.value),
    monthlyBudgetCny: Number(monthlyBudget.value) || 0,
    apiBaseUrl: typedApiBase,
    companionUrl: companionUrl.value.trim(),
  };
  // 留空 = 不修改已保存的 Key；只有显式输入新值才覆盖。
  if (typedApiKey !== '') patch.apiKey = typedApiKey;
  if (typedAsrKey !== '') patch.asrApiKey = typedAsrKey;
  void saveSettings(patch).then(next => {
    contextWindow.value = String(next.contextWindowSec);
    maxTokens.value = String(next.maxTokens);
    historyTurns.value = String(next.historyTurns);
    budgetCny = next.monthlyBudgetCny;
    monthlyBudget.value = next.monthlyBudgetCny > 0 ? String(next.monthlyBudgetCny) : '';
    renderBudget();
    // 保存后清空输入框，只把新 Key 的末四位放回 placeholder。
    apiKey.value = '';
    apiKey.placeholder = keyPlaceholder(next.apiKey);
    asrApiKey.value = '';
    asrApiKey.placeholder = keyPlaceholder(next.asrApiKey);
    asrModel.value = next.asrModel;
    jumpAutoPlay.checked = next.jumpAutoPlay;
    companionUrl.value =
      next.companionUrl === DEFAULT_SETTINGS.companionUrl ? '' : next.companionUrl;
    // 非法地址会被 normalize 回退；把输入框同步成实际生效的地址，别让旧值骗人。
    const apiBaseRejected =
      typedApiBase !== '' && next.apiBaseUrl !== typedApiBase.replace(/\/+$/, '');
    apiBaseUrl.value = next.apiBaseUrl === DEFAULT_SETTINGS.apiBaseUrl ? '' : next.apiBaseUrl;
    renderApiBaseHint();
    status.textContent = apiBaseRejected
      ? '已保存；API 地址必须用 https（本机地址例外），已回退默认'
      : '已保存';
    window.setTimeout(
      () => {
        status.textContent = '';
      },
      apiBaseRejected ? 5000 : 1500,
    );
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
