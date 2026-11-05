/**
 * 扩展设置：chrome.storage.local 单键 `settings`。
 * 所有导出保持向后兼容（D1/D2 的调用点只用 apiKey / visionModel / textModel）。
 */

export const SETTINGS_STORAGE_KEY = 'settings';
export const DEFAULT_API_BASE_URL = 'https://api.deepseek.com';
export const DEFAULT_COMPANION_URL = 'http://127.0.0.1:8787';

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
  /** 点时间戳跳转后是否自动播放；false 表示保持暂停。 */
  jumpAutoPlay: boolean;
  /** 提问时是否附带当前视频画面截图。 */
  frameEnabled: boolean;
  /** D6 本地 companion 地址；末尾不带斜杠。 */
  companionUrl: string;
  /** D6 是否开启本地落盘同步。 */
  syncEnabled: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  visionModel: 'deepseek-flash',
  textModel: 'deepseek-flash',
  apiBaseUrl: DEFAULT_API_BASE_URL,
  thinking: false,
  maxTokens: 2048,
  contextWindowSec: 90,
  jumpAutoPlay: false,
  frameEnabled: true,
  companionUrl: DEFAULT_COMPANION_URL,
  syncEnabled: true,
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

function normalizeCompanionUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (raw === '') return DEFAULT_COMPANION_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return DEFAULT_COMPANION_URL;
    return raw.replace(/\/+$/, '');
  } catch {
    return DEFAULT_COMPANION_URL;
  }
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
    jumpAutoPlay: typeof saved.jumpAutoPlay === 'boolean' ? saved.jumpAutoPlay : DEFAULT_SETTINGS.jumpAutoPlay,
    // D4 新增：旧存档没有这个字段时按默认开启处理。
    frameEnabled: typeof saved.frameEnabled === 'boolean' ? saved.frameEnabled : DEFAULT_SETTINGS.frameEnabled,
    // D6 新增：旧存档缺省指向本机默认端口，并默认开启同步。
    companionUrl: normalizeCompanionUrl(saved.companionUrl),
    syncEnabled: typeof saved.syncEnabled === 'boolean' ? saved.syncEnabled : DEFAULT_SETTINGS.syncEnabled,
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
