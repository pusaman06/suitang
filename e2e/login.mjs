// 一次性登录引导：打开带扩展的 Chromium，等你扫码登录 B 站，
// 登录态写进 .e2e/profile，之后 pnpm e2e 全自动。
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const extensionPath = resolve(process.cwd(), 'dist');
const profileDir = resolve(process.cwd(), '.e2e', 'profile');
mkdirSync(profileDir, { recursive: true });

const context = await chromium.launchPersistentContext(profileDir, {
  channel: 'chromium',
  headless: false,
  viewport: { width: 1440, height: 900 },
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
  ],
});

const page = context.pages()[0] ?? (await context.newPage());
await page.goto('https://www.bilibili.com/', { waitUntil: 'domcontentloaded' });

console.log('浏览器已打开。请在窗口里扫码登录 B 站，登录成功会自动关窗（最多等 10 分钟）。');

let loggedIn = false;
for (let i = 0; i < 300; i += 1) {
  const cookies = await context.cookies('https://www.bilibili.com');
  if (cookies.some(cookie => cookie.name === 'SESSDATA' && cookie.value.length > 0)) {
    loggedIn = true;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 2000));
}

console.log(loggedIn ? '登录成功，Cookie 已存进 .e2e/profile。' : '等太久没检测到登录，窗口关掉了。');
await new Promise(resolve => setTimeout(resolve, 1500));
await context.close();
process.exit(loggedIn ? 0 : 1);
