/**
 * 复现「本地缓存的大纲点重新生成后看不到来源」。
 *
 * 用法：node scripts/probes/outline-refresh-source.mjs
 * 前置：dist 已 build；.env 有 DS_KEY / SILICONFLOW_KEY。
 *
 * 流程：打开视频页拿 meta → 写入一份「旧版缓存大纲」（没有 captionDetail，
 * 和用户环境里那份一样）→ 重新加载页面 → 读诊断行 → 点「重新生成」
 * → 轮询诊断行/状态/错误，看来源是否更新。
 */
import { chromium } from '@playwright/test';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const root = 'D:\\project\\video-tutor';
const dist = resolve(root, 'dist');
const profile = resolve(root, '.e2e', 'profile');
const shots = resolve(root, 'e2e', 'screenshots');
const VIDEO = 'https://www.bilibili.com/video/BV19n4h6VENS/';

// 跑扩展前清 SW / Code Cache，否则加载的是上一版 background.js。
for (const dir of ['Service Worker', 'Code Cache']) {
  rmSync(resolve(profile, 'Default', dir), { recursive: true, force: true });
}

const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() && !line.startsWith('#'))
    .map(line => {
      const at = line.indexOf('=');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    }),
);

const log = [];
const say = line => {
  log.push(String(line));
  console.log(line);
};

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--mute-audio'],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20000 }));
const extensionId = sw.url().split('/')[2];
sw.on('console', message => say(`[sw] ${message.text()}`));

const readPanel = async page => ({
  state: await page.locator('.vt-outline-state').textContent().catch(() => null),
  diag: await page.locator('.vt-outline-diag').textContent().catch(() => null),
  error: await page.locator('.vt-outline-error-text').textContent().catch(() => null),
});

try {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await options.waitForTimeout(500);
  const current = await options.evaluate(() => chrome.storage.local.get('settings'));
  const settings = {
    ...(current.settings ?? {}),
    apiKey: env.DS_KEY,
    apiBaseUrl: 'https://api.deepseek.com',
    textModel: 'deepseek-flash',
    asrApiKey: env.SILICONFLOW_KEY,
    asrBaseUrl: 'https://api.siliconflow.cn/v1',
    asrModel: 'FunAudioLLM/SenseVoiceSmall',
    frameEnabled: true,
  };
  await options.evaluate(patch => chrome.storage.local.set({ settings: patch }), settings);

  // 1) 打开视频页（BV19n4h6VENS p1，cid 43358291431 已知），等面板可用。
  const page = await context.newPage();
  await page.goto(VIDEO, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const info = { bvid: 'BV19n4h6VENS', p: 1, cid: 43358291431, duration: 127.802 };
  if (!info?.cid) {
    say('NO META');
    process.exit(0);
  }

  // 2) 写入一份旧版缓存大纲：没有 captionDetail，段落随便但结构合法。
  const key = `outline:${info.bvid}:${info.p}:${info.cid}`;
  const duration = info.duration ?? 0;
  const seg = (start, end, title) => ({ start, end, title, detail: '' });
  const fake = {
    bvid: info.bvid,
    p: info.p,
    cid: info.cid,
    duration,
    segments: [
      seg(0, duration * 0.25, '开场'),
      seg(duration * 0.25, duration * 0.5, '主体'),
      seg(duration * 0.5, duration * 0.75, '对比'),
      seg(duration * 0.75, duration, '收尾'),
    ],
    createdAt: Date.now() - 86400000,
    model: 'deepseek-flash',
  };
  await options.evaluate(({ key, fake }) => chrome.storage.local.set({ [key]: fake }), { key, fake });
  say(`seeded ${key}`);

  // 3) 重新加载，从缓存读大纲。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.locator('.vt-ball').click();
  await page.waitForTimeout(1200);
  say(`before: ${JSON.stringify(await readPanel(page))}`);
  await page.screenshot({ path: resolve(shots, 'd12-outline-refresh-before.png') });

  // 4) 点「重新生成」，观察来源是否更新。
  await page.locator('.vt-outline-refresh').click();
  let last = '';
  for (let i = 0; i < 150; i += 1) {
    const panel = await readPanel(page);
    const now = JSON.stringify(panel);
    if (now !== last) {
      say(`[${i}s] ${now}`);
      last = now;
    }
    if (/^\d+ 段$/.test(panel.state ?? '')) break;
    if ((panel.error ?? '').trim()) break;
    await page.waitForTimeout(1000);
  }
  say(`after: ${JSON.stringify(await readPanel(page))}`);
  await page.screenshot({ path: resolve(shots, 'd12-outline-refresh-after.png') });

  // 5) 清空全部缓存后，大纲应该消失。
  const statsBefore = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'cache:stats' }));
  say(`stats before clear: ${JSON.stringify(statsBefore)}`);
  await options.evaluate(() => chrome.runtime.sendMessage({ type: 'cache:clear-all' }));
  const stored = await options.evaluate(() => chrome.storage.local.get(null));
  say(`after clear outline keys: ${JSON.stringify(Object.keys(stored).filter(k => k.startsWith('outline:') || k.startsWith('asr:')))}`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3000);
  await page.locator('.vt-ball').click();
  await page.waitForTimeout(1200);
  say(`after clear: ${JSON.stringify(await readPanel(page))}`);
  await page.screenshot({ path: resolve(shots, 'd12-outline-cleared.png') });
  say('RESULT done');
} catch (error) {
  say('FAILED: ' + (error?.stack ?? error));
} finally {
  await context.close().catch(() => undefined);
}
