import { chromium } from '@playwright/test';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 手动验证脚本（不进 playwright 用例集，不占 mock 组时间）：
// 打开 A 视频 -> 开面板 -> 点「相关推荐」里的 B 视频（SPA 内跳转，不刷新）
// -> 点「转写这段」-> 断言转写的是 B 的内容（缓存键 cid 要等于 B 的 cid）。
//
// 跑法：node scripts/probes/spa-video-switch.mjs
// 依赖：dist/ 已 build、.env 里有 DS_KEY 与 SILICONFLOW_KEY。

const root = resolve(import.meta.dirname, '..', '..');
const dist = resolve(root, 'dist');
const profile = resolve(root, '.e2e', 'profile');
const env = Object.fromEntries(
  readFileSync(resolve(root, '.env'), 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const index = line.indexOf('=');
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
);

const log = [];
const say = (...args) => {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  log.push(line);
  console.log(line);
};

// 扩展脚本会被 Chromium 缓存；不清掉跑的是上一版 background.js。
for (const dir of ['Service Worker', 'Code Cache']) {
  rmSync(resolve(profile, 'Default', dir), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: false,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--mute-audio'],
});
const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 20000 }));
sw.on('console', message => say('SW', message.text()));
const extensionId = sw.url().split('/')[2];

try {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  await options.waitForTimeout(400);
  await options.evaluate(async keys => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      settings: {
        apiKey: keys.ds,
        apiBaseUrl: 'https://api.deepseek.com',
        textModel: 'deepseek-flash',
        asrApiKey: keys.sf,
        asrBaseUrl: 'https://api.siliconflow.cn/v1',
        asrModel: 'FunAudioLLM/SenseVoiceSmall',
        frameEnabled: false,
      },
    });
  }, { ds: env.DS_KEY, sf: env.SILICONFLOW_KEY });
  await options.close();

  const page = await context.newPage();
  await page.goto('https://www.bilibili.com/video/BV19n4h6VENS/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(6000);
  await page.locator('.vt-ball').click();
  await page.locator('.vt-panel').waitFor({ timeout: 20000 });
  const idsA = await page.locator('.vt-ids').innerText();
  say('A ids:', idsA);

  const href = await page.evaluate(() => {
    const currentBv = (location.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/) ?? [])[1] ?? '';
    const anchors = [...document.querySelectorAll('a[href*="/video/BV"]')];
    const target = anchors.find(a => {
      const raw = a.getAttribute('href') ?? '';
      return raw.includes('/video/BV') && !raw.includes(currentBv);
    });
    return target?.getAttribute('href') ?? null;
  });
  if (!href) throw new Error('页面上没有找到可点的相关视频链接');
  const urlBefore = page.url();
  await page.evaluate(linkHref => {
    [...document.querySelectorAll('a[href]')]
      .find(a => a.getAttribute('href') === linkHref)
      ?.click();
  }, href);
  await page.waitForFunction(
    previous => location.href !== previous && location.href.includes('/video/BV'),
    urlBefore,
    { timeout: 30000 },
  );
  await page.waitForTimeout(3000);
  const idsB = await page.locator('.vt-ids').innerText();
  say('B ids:', idsB);
  if (idsA === idsB) throw new Error('面板没有跟着换到新视频');

  await page.locator('.vt-outline-asr').click();
  let state = '';
  let error = '';
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(1000);
    state = await page.locator('.vt-outline-state').innerText().catch(() => '');
    error = await page.locator('.vt-outline-error-text').innerText().catch(() => '');
    if (state.includes('已转写') || error) break;
  }
  say('state:', state, 'error:', error);
  await page.screenshot({ path: resolve(root, 'e2e', 'screenshots', 'd11-spa-video-switch.png') });

  // 核对缓存：key 里的 cid 必须是新视频的 cid，内容必须是新视频的内容。
  const check = await context.newPage();
  await check.goto(`chrome-extension://${extensionId}/src/options/index.html`);
  const cache = await check.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    return Object.entries(all)
      .filter(([item]) => item.startsWith('asr:'))
      .map(([item, value]) => {
        const text = (value?.segments ?? []).map(segment => segment.text ?? '').join(' ');
        return { key: item, head: text.slice(0, 80) };
      });
  });
  await check.close();
  say('asr cache:', cache);
  const bvB = (idsB.match(/BV[0-9A-Za-z]+/) ?? [])[0];
  const expectCid = idsB.match(/cid (\d+)/)?.[1];
  const wrongKey = cache.some(item => item.key.startsWith(`asr:${bvB}:`) && expectCid && !item.key.endsWith(expectCid));
  say('cid matches panel:', !wrongKey);
  if (!state.includes('已转写') || error) throw new Error(`转写没成功：${error || state}`);
  if (wrongKey) throw new Error('缓存键里的 cid 与面板不一致');
  say('RESULT ok');
} catch (error) {
  say('FAILED:', error?.message ?? String(error));
  process.exitCode = 1;
} finally {
  writeFileSync(resolve(root, 'scripts', 'probes', 'spa-video-switch.log'), log.join('\n'), 'utf8');
  await context.close().catch(() => undefined);
}
