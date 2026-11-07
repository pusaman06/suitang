/**
 * 扩展设置：chrome.storage.local 单键 `settings`。
 * 所有导出保持向后兼容（D1/D2 的调用点只用 apiKey / visionModel / textModel）。
 */

export const SETTINGS_STORAGE_KEY = 'settings';
export const DEFAULT_API_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_COMPANION_URL = 'http://127.0.0.1:8787';
export const DEFAULT_ASR_BASE_URL = 'https://api.siliconflow.cn/v1';
export const DEFAULT_ASR_MODEL = 'FunAudioLLM/SenseVoiceSmall';

export interface Settings {
  apiKey: string;
  visionModel: string;
  textModel: string;
  /** 允许指向本地 mock / 代理；末尾不带斜杠。 */
  apiBaseUrl: string;
  /** 是否开启 DeepSeek thinking；开启时不发 temperature。 */
  thinking: boolean;
  /** 单次回答的 max_tokens。 */
  maxTokens: number;
  /** 问答上下文窗口（秒），当前时间前后各取这么多。 */
  contextWindowSec: number;
  /** 追问时带上的最近几轮问答；0 表示不带。 */
  historyTurns: number;
  /** 点时间戳跳转后是否自动播放；false 表示保持暂停。 */
  jumpAutoPlay: boolean;
  /** 提问时是否附带当前视频画面截图。 */
  frameEnabled: boolean;
  /** 本地 companion 地址（知识库链路用）；末尾不带斜杠。 */
  companionUrl: string;
  /** D8 语音转写 Key（SiliconFlow）。 */
  asrApiKey: string;
  /** D8 语音转写服务地址；末尾不带斜杠。 */
  asrBaseUrl: string;
  /** D8 语音转写模型。 */
  asrModel: string;
  /** D10 月度预算（人民币）；0 表示不设预算。 */
  monthlyBudgetCny: number;
  /** 测试期诊断：面板上显示大纲是靠什么生成的。正式发布前关掉。 */
  diagnostics: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  visionModel: 'deepseek-flash',
  textModel: 'deepseek-flash',
  apiBaseUrl: DEFAULT_API_BASE_URL,
  thinking: false,
  maxTokens: 2048,
  contextWindowSec: 90,
  historyTurns: 2,
  jumpAutoPlay: false,
  frameEnabled: true,
  companionUrl: DEFAULT_COMPANION_URL,
  asrApiKey: '',
  asrBaseUrl: DEFAULT_ASR_BASE_URL,
  asrModel: DEFAULT_ASR_MODEL,
  monthlyBudgetCny: 0,
  diagnostics: true,
};

/** 旧版本存过退役别名，读出来时归一到现役模型。 */
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function normalizeModel(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return fallback;
  const alias = MODEL_ALIASES[raw.toLowerCase()];
  return alias ?? raw;
}

function normalizeBaseUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return DEFAULT_API_BASE_URL;
  return raw.replace(/\/+$/, '');
}

function normalizeHttpUrl(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return fallback;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return fallback;
    return raw.replace(/\/+$/, '');
  } catch {
    return fallback;
  }
}

function normalizeCompanionUrl(value: unknown): string {
  return normalizeHttpUrl(value, DEFAULT_COMPANION_URL);
}

function normalizeMoney(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num <= 0) return 0;
  return Math.round(num * 100) / 100;
}

export function normalizeSettings(patch: Partial<Settings> | undefined | null): Settings {
  const saved = patch ?? {};
  return {
    apiKey: typeof saved.apiKey === 'string' ? saved.apiKey.trim() : DEFAULT_SETTINGS.apiKey,
    visionModel: normalizeModel(saved.visionModel, DEFAULT_SETTINGS.visionModel),
    textModel: normalizeModel(saved.textModel, DEFAULT_SETTINGS.textModel),
    apiBaseUrl: normalizeBaseUrl(saved.apiBaseUrl),
    thinking: typeof saved.thinking === 'boolean' ? saved.thinking : DEFAULT_SETTINGS.thinking,
    maxTokens: clampInt(saved.maxTokens, DEFAULT_SETTINGS.maxTokens, 256, 8192),
    contextWindowSec: clampInt(saved.contextWindowSec, DEFAULT_SETTINGS.contextWindowSec, 30, 300),
    historyTurns: clampInt(saved.historyTurns, DEFAULT_SETTINGS.historyTurns, 0, 5),
    jumpAutoPlay: typeof saved.jumpAutoPlay === 'boolean' ? saved.jumpAutoPlay : DEFAULT_SETTINGS.jumpAutoPlay,
    // D4 新增：旧存档没有这个字段时按默认开启处理。
    frameEnabled: typeof saved.frameEnabled === 'boolean' ? saved.frameEnabled : DEFAULT_SETTINGS.frameEnabled,
    // D6 新增：旧存档缺省指向本机默认端口。
    companionUrl: normalizeCompanionUrl(saved.companionUrl),
    // D8 新增：转写功能默认关闭（没有 Key），地址/模型缺省用 SiliconFlow。
    asrApiKey: typeof saved.asrApiKey === 'string' ? saved.asrApiKey.trim() : DEFAULT_SETTINGS.asrApiKey,
    asrBaseUrl: normalizeHttpUrl(saved.asrBaseUrl, DEFAULT_SETTINGS.asrBaseUrl),
    asrModel:
      typeof saved.asrModel === 'string' && saved.asrModel.trim() !== ''
        ? saved.asrModel.trim()
        : DEFAULT_SETTINGS.asrModel,
    // D10 新增：旧存档没有预算字段时按 0（不设预算）处理。
    monthlyBudgetCny: normalizeMoney(saved.monthlyBudgetCny),
    // 测试期新增：默认开着，方便看大纲是靠什么生成的。
    diagnostics: typeof saved.diagnostics === 'boolean' ? saved.diagnostics : DEFAULT_SETTINGS.diagnostics,
  };
}

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(stored[SETTINGS_STORAGE_KEY] as Partial<Settings> | undefined);
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings();
  const next = normalizeSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}
