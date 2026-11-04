export interface Settings {
  apiKey: string;
  visionModel: string;
  textModel: string;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  visionModel: 'deepseek-v4-flash-vision-exp',
  textModel: 'deepseek-v4-flash',
};

const STORAGE_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const saved = data[STORAGE_KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...saved };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}
