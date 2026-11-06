import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// 只测 companion 自己的 HTTP 接口，不需要浏览器、不需要 B 站登录。
// 落盘改成「点『存到知识库』才写」之后，原来那批「提问后自动同步」的用例已经失去意义。

let companion: ChildProcess;
let companionPort = 0;
let companionDir = '';

function startCompanion(port: string, dir: string): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ['companion/server.mjs', '--port', port, '--dir', dir],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    let started = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`companion 启动超时：\n${output}`));
    }, 15_000);
    const onData = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        started = true;
        companionPort = Number(match[1]);
        resolvePromise(child);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', code => {
      if (!started && code !== null) {
        clearTimeout(timer);
        reject(new Error(`companion 退出 ${code}：\n${output}`));
      }
    });
  });
}

async function stopCompanion(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) return;
  await new Promise<void>(resolvePromise => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolvePromise();
    }, 3_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolvePromise();
    });
    child.kill('SIGTERM');
  });
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  companionDir = resolve('test-results', `companion-${Date.now()}`);
  mkdirSync(companionDir, { recursive: true });
  companion = await startCompanion('0', companionDir);
});

test.afterAll(async () => {
  await stopCompanion(companion);
});

test('health 字段齐全', async () => {
  const health = (await (await fetch(`http://127.0.0.1:${companionPort}/health`)).json()) as {
    ok: boolean;
    version: string;
    dir: string;
    uptimeSec: number;
  };
  expect(health.ok).toBe(true);
  expect(health.version).toMatch(/^\d+\.\d+\.\d+$/);
  expect(health.dir).toBe(companionDir);
  expect(Number.isFinite(health.uptimeSec)).toBe(true);
});

test('companion 拒绝外部 Origin 和非法 bvid', async () => {
  const evil = await fetch(`http://127.0.0.1:${companionPort}/api/videos/BV1sHU9BmEne`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: 'http://evil.com' },
    body: '{}',
  });
  expect(evil.status).toBe(403);
  const evilBody = (await evil.json()) as { code: string };
  expect(evilBody.code).toBe('forbidden-origin');

  const bad = await fetch(`http://127.0.0.1:${companionPort}/api/videos/not-a-bvid/p/1`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(bad.status).toBe(400);
  const badBody = (await bad.json()) as { code: string };
  expect(badBody.code).toBe('bad-request');

  const preflight = await fetch(`http://127.0.0.1:${companionPort}/api/videos/BV1sHU9BmEne`, {
    method: 'OPTIONS',
    headers: {
      origin: 'chrome-extension://e2e-test',
      'access-control-request-method': 'PUT',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('chrome-extension://e2e-test');
  expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
  expect(preflight.headers.get('access-control-max-age')).toBe('600');
});
