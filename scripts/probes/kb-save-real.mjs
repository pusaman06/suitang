import { chromium } from '@playwright/test';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = 'D:\\project\\video-tutor';
const dist = resolve(root, 'dist');
const profile = resolve(root, '.e2e', 'profile');
const kbNoteDir = 'D:\\knowledge-base\\20-知识笔记';
const log = [];
const out = msg => {
  log.push(msg);
  console.log(msg);
};

const envText = readFileSync(resolve(root, '.env'), 'utf8');
const env = {};
for (const line of envText.split(/\r?\n/)) {
  const match = /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(line);
  if (match) env[match[1]] = match[2];
}
if (!env.DS_KEY) throw new Error('缺少 DS_KEY');
if (!env.SILICONFLOW_KEY) throw new Error('缺少 SILICONFLOW_KEY');

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${dist}`,
    `--load-extension=${dist}`,
    '--disable-features=BlockInsecurePrivateNetworkRequests',
    '--mute-audio',
  ],
});

const readState = async target =>
  target.evaluate(() => {
    const host = document.getElementById('video-tutor-host');
    const rootEl = host?.shadowRoot ?? null;
    return {
      state: rootEl?.querySelector('.vt-outline-state')?.textContent?.trim() ?? '',
      empty: rootEl?.querySelector('.vt-outline-empty-text')?.textContent?.trim() ?? '',
      error: rootEl?.querySelector('.vt-outline-error-text')?.textContent?.trim() ?? '',
      diag: rootEl?.querySelector('.vt-outline-diag')?.textContent?.trim() ?? '',
      asrText: rootEl?.querySelector('.vt-outline-asr')?.textContent?.trim() ?? '',
    };
  });

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20000 }));
  const extensionId = sw.url().split('/')[2];

  const helper = await context.newPage();
  await helper.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await helper.evaluate(
    async config => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({ settings: config });
    },
    {
      apiKey: env.DS_KEY,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      visionModel: 'deepseek-flash',
      thinking: false,
      frameEnabled: false,
      companionUrl: 'http://127.0.0.1:8787',
      asrApiKey: env.SILICONFLOW_KEY,
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
    },
  );
  await helper.close();

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  page.on('console', message => {
    if (message.type() === 'error') out(`console.error: ${message.text()}`);
  });
  await page.goto('https://www.bilibili.com/video/BV19n4h6VENS/', { waitUntil: 'domcontentloaded' });
  await page.locator('.vt-ball').waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('.vt-ball').click();
  await page.locator('.vt-panel').waitFor({ state: 'visible' });

  // 2 分钟日报视频：没有官方字幕 → 生成时自动转写，再自动生成大纲。
  await page.locator('.vt-outline-generate').click();
  let last = '';
  let generated = false;
  for (let tick = 0; tick < 120; tick += 1) {
    await page.waitForTimeout(3000);
    const snapshot = await readState(page);
    const line = `[${tick * 3}s] state="${snapshot.state}" asr="${snapshot.asrText}" empty="${snapshot.empty}" error="${snapshot.error}" diag="${snapshot.diag}"`;
    if (line !== last) {
      out(line);
      last = line;
    }
    if (/^\d+ 段$/.test(snapshot.state)) {
      generated = true;
      break;
    }
  }
  if (!generated) {
    const snapshot = await readState(page);
    await page.screenshot({ path: resolve(root, 'e2e/screenshots/d13-kb-real-fail.png') });
    throw new Error(`大纲没生成：${JSON.stringify(snapshot)}`);
  }

  await page.locator('.vt-kb-open').click();
  await page.locator('.vt-kb').waitFor({ state: 'visible', timeout: 60_000 });
  const preview = await page.locator('.vt-kb-preview').inputValue();
  out(`preview: ${preview.length} chars`);
  out(`hint: ${(await page.locator('.vt-kb-hint').textContent())?.trim()}`);
  await page.screenshot({ path: resolve(root, 'e2e/screenshots/d13-kb-real-preview.png') });

  await page.locator('.vt-kb-confirm').click();
  await page.waitForFunction(
    () => {
      const host = document.getElementById('video-tutor-host');
      const status = host?.shadowRoot?.querySelector('.vt-status');
      return !!status && /已存入|已覆盖/.test(status.textContent ?? '');
    },
    undefined,
    { timeout: 60_000 },
  );
  out(`status: ${(await page.locator('.vt-status').textContent())?.trim()}`);
  await page.screenshot({ path: resolve(root, 'e2e/screenshots/d13-kb-real-saved.png') });

  const notes = readdirSync(kbNoteDir)
    .filter(name => name.includes('BV19n4h6VENS'))
    .map(name => ({
      name,
      size: statSync(resolve(kbNoteDir, name)).size,
      mtime: statSync(resolve(kbNoteDir, name)).mtimeMs,
    }));
  out(`kb notes: ${JSON.stringify(notes)}`);
  const newest = [...notes].sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) throw new Error('知识库里没找到这份笔记');
  out(`note: ${newest.name} (${newest.size}B)`);
  out(`page errors: ${JSON.stringify(pageErrors)}`);
} catch (error) {
  out(`FAILED: ${error?.stack ?? error}`);
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(root, 'test-results', 'kb-save-real.log'), log.join('\n'), 'utf8');
  await context.close().catch(() => undefined);
}
