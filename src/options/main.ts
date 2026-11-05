import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings';

const apiKey = el<HTMLInputElement>('#api-key');
const visionModel = el<HTMLInputElement>('#vision-model');
const textModel = el<HTMLInputElement>('#text-model');
const thinking = el<HTMLInputElement>('#thinking');
const contextWindow = el<HTMLInputElement>('#context-window');
const apiBaseUrl = el<HTMLInputElement>('#api-base-url');
const save = el<HTMLButtonElement>('#save');
const status = el<HTMLParagraphElement>('#status');

function el<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`options page is missing ${selector}`);
  return node;
}

async function init(): Promise<void> {
  const settings = await loadSettings();
  apiKey.value = settings.apiKey;
  visionModel.value = settings.visionModel;
  textModel.value = settings.textModel;
  thinking.checked = settings.thinking;
  contextWindow.value = String(settings.contextWindowSec);
  apiBaseUrl.value = settings.apiBaseUrl === DEFAULT_SETTINGS.apiBaseUrl ? '' : settings.apiBaseUrl;
}

save.addEventListener('click', () => {
  void saveSettings({
    apiKey: apiKey.value.trim(),
    visionModel: visionModel.value.trim() || DEFAULT_SETTINGS.visionModel,
    textModel: textModel.value.trim() || DEFAULT_SETTINGS.textModel,
    thinking: thinking.checked,
    contextWindowSec: Number(contextWindow.value) || DEFAULT_SETTINGS.contextWindowSec,
    apiBaseUrl: apiBaseUrl.value.trim(),
  }).then(next => {
    contextWindow.value = String(next.contextWindowSec);
    status.textContent = '已保存';
    window.setTimeout(() => {
      status.textContent = '';
    }, 1500);
  });
});

void init();
