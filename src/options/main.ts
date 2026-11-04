import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings';

const apiKey = el<HTMLInputElement>('#api-key');
const visionModel = el<HTMLInputElement>('#vision-model');
const textModel = el<HTMLInputElement>('#text-model');
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
}

save.addEventListener('click', () => {
  void saveSettings({
    apiKey: apiKey.value.trim(),
    visionModel: visionModel.value.trim() || DEFAULT_SETTINGS.visionModel,
    textModel: textModel.value.trim() || DEFAULT_SETTINGS.textModel,
  }).then(() => {
    status.textContent = '已保存';
    window.setTimeout(() => {
      status.textContent = '';
    }, 1500);
  });
});

void init();
