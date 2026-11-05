import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

// 本地密钥放 .env（已被 .gitignore 忽略），CI 上直接读环境变量。
const envFile = resolve(root, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  testDir: resolve(root, 'e2e'),
  // 真浏览器 + 真 B 站页面，慢是正常的。
  timeout: 180_000,
  expect: { timeout: 30_000 },
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'off',
  },
});
