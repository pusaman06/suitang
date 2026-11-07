import { expect, test } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildKbMarkdown, kbFileName, localDate, parseKbSummary } from '../src/shared/kb';
import type { OutlineSegment } from '../src/shared/outline';
import type { VideoInfo } from '../src/shared/types';

const info: VideoInfo = {
  bvid: 'BV14FHP6LEJE',
  p: 1,
  title: '我做了一个知识库插件',
  owner: '某UP',
  duration: 891,
};

const segments: OutlineSegment[] = [
  { start: 0, end: 120, title: '这插件解决什么问题' },
  { start: 120, end: 891, title: '现场演示' },
];

test('文件名是 <标题>（BV号-p<NN>）.md，多 P 不互相覆盖', () => {
  const single = kbFileName({ title: 'A/B: 测试?<视频>', bvid: 'BV1xx', p: 1 });
  expect(single).toBe('A-B- 测试--视频-（BV1xx-p01）.md');
  expect(single.includes('/')).toBe(false);
  expect(single.includes(':')).toBe(false);
  // 不再带日期：同一分 P 再存就是覆盖更新，不会堆出两份。
  expect(/\d{4}-\d{2}-\d{2}/.test(single)).toBe(false);

  // 多 P 共用 BV 号，靠 p 号 + 分 P 标题区分。
  const p2 = kbFileName({
    title: '黑马程序员Python+AI零基础入门到大神全套视频课程',
    partTitle: '02. Python启航-初识Python',
    bvid: 'BV1sHU9BmEne',
    p: 2,
  });
  expect(p2).toBe('02. Python启航-初识Python（BV1sHU9BmEne-p02）.md');
  const p3 = kbFileName({
    title: '黑马程序员Python+AI零基础入门到大神全套视频课程',
    partTitle: '03. 循环',
    bvid: 'BV1sHU9BmEne',
    p: 3,
  });
  expect(p2).not.toBe(p3);
  expect(p3.includes('p03')).toBe(true);
});

test('localDate 按本地时区取日期', () => {
  const now = new Date(2026, 10, 6, 0, 5, 0);
  expect(localDate(now)).toBe('2026-11-06');
});

test('没问过就不写「当时我问了什么」整段', () => {
  const markdown = buildKbMarkdown({
    info,
    segments,
    qa: [],
    summary: '一句话摘要',
    keywords: ['知识库', '插件'],
    now: new Date(2026, 10, 6, 9, 0, 0),
  });
  expect(markdown.startsWith('---\ntitle: "我做了一个知识库插件"')).toBe(true);
  expect(markdown.includes('type: 知识')).toBe(true);
  expect(markdown.includes('## 大纲')).toBe(true);
  expect(markdown.includes('### [00:00] 这插件解决什么问题')).toBe(true);
  expect(markdown.includes('## 关键词')).toBe(true);
  expect(markdown.includes('p01.md')).toBe(true);
  expect(markdown.includes('当时我问了什么')).toBe(false);
});

test('问过就带上问答，字幕全文不进库', () => {
  const markdown = buildKbMarkdown({
    info,
    segments,
    qa: [{ question: '重排序值不值得开？', answer: '收费，默认不开。[03:20]' }],
    summary: '',
    keywords: [],
    now: new Date(2026, 10, 6, 9, 0, 0),
  });
  expect(markdown.includes('## 当时我问了什么')).toBe(true);
  expect(markdown.includes('**Q**：重排序值不值得开？')).toBe(true);
  expect(markdown.includes('A：收费，默认不开。[03:20]')).toBe(true);
  // 摘要为空时不留一个空的引用行
  expect(markdown.includes('\n> \n')).toBe(false);
});

test('摘要解析容忍代码围栏和多余文字', () => {
  const parsed = parseKbSummary('好的：\n```json\n{"summary":"讲了插件","keywords":["知识库","RAG"]}\n```');
  expect(parsed).toEqual({ summary: '讲了插件', keywords: ['知识库', 'RAG'] });
  expect(parseKbSummary('完全不是 JSON')).toBeNull();
  expect(parseKbSummary('{"summary":"","keywords":[]}')).toBeNull();
});

test.describe('companion 知识库路由', () => {
  let child: ChildProcess | null = null;
  let base = '';
  let workDir = '';
  let kbDir = '';

  test.beforeAll(async () => {
    workDir = mkdtempSync(join(tmpdir(), 'vt-kb-'));
    kbDir = mkdtempSync(join(tmpdir(), 'vt-kb-lib-'));
    child = spawn(process.execPath, ['companion/server.mjs', '--port', '0', '--dir', workDir, '--kb', kbDir], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    base = await new Promise<string>((resolvePromise, reject) => {
      let output = '';
      const timer = setTimeout(() => {
        child?.kill();
        reject(new Error(`companion 启动超时：\n${output}`));
      }, 15_000);
      child?.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
        const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolvePromise(`http://127.0.0.1:${match[1]}`);
        }
      });
      child?.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString('utf8');
      });
    });
  });

  test.afterAll(() => {
    child?.kill();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
    if (kbDir) rmSync(kbDir, { recursive: true, force: true });
  });

  test('status 报出知识库位置', async () => {
    const response = await fetch(`${base}/api/kb/status`);
    const data = (await response.json()) as { ok?: boolean; kbDir?: string; noteDir?: string };
    expect(response.ok).toBe(true);
    expect(data.ok).toBe(true);
    expect(data.kbDir).toBe(kbDir);
    expect(data.noteDir).toBe(join(kbDir, '20-知识笔记'));
  });

  test('写一条笔记并读回，同名再写是覆盖', async () => {
    const fileName = '2026-11-06-测试（BV1xx）.md';
    const first = await fetch(`${base}/api/kb/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, markdown: '# 第一版\n' }),
    });
    const firstData = (await first.json()) as { ok?: boolean; relative?: string; overwrote?: boolean };
    expect(first.ok).toBe(true);
    expect(firstData.ok).toBe(true);
    expect(firstData.overwrote).toBe(false);
    expect(firstData.relative).toBe(`20-知识笔记/${fileName}`);

    const second = await fetch(`${base}/api/kb/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, markdown: '# 第二版\n' }),
    });
    const secondData = (await second.json()) as { ok?: boolean; overwrote?: boolean };
    expect(secondData.overwrote).toBe(true);
    expect(readFileSync(join(kbDir, '20-知识笔记', fileName), 'utf8')).toBe('# 第二版\n');
  });

  test('带中文标点的标题也能落盘：问号、冒号、书名号都放行', async () => {
    const fileName = '2026-11-06-DeepSeek 新出的 Super Agent 是什么？真有用么？（BV1kr4h6fExw）.md';
    const response = await fetch(`${base}/api/kb/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, markdown: '# 中文标点\n' }),
    });
    const data = (await response.json()) as { ok?: boolean; relative?: string };
    expect(data.ok).toBe(true);
    expect(data.relative).toBe(`20-知识笔记/${fileName}`);
    expect(readFileSync(join(kbDir, '20-知识笔记', fileName), 'utf8')).toBe('# 中文标点\n');
  });

  test('Windows 真正非法的字符仍被拒', async () => {
    for (const fileName of ['a:b.md', 'a|b.md', 'a*/b.md', 'a?.md', 'a<b.md', '..md']) {
      const response = await fetch(`${base}/api/kb/note`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName, markdown: 'x' }),
      });
      expect(response.ok, fileName).toBe(false);
    }
  });

  test('非法文件名被拒', async () => {
    const response = await fetch(`${base}/api/kb/note`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: '../逃逸.md', markdown: 'x' }),
    });
    expect(response.ok).toBe(false);
  });

  test('原文底稿写进 50-底稿/视频原文/<BV>/<BV号>-p<NN>.md', async () => {
    const response = await fetch(`${base}/api/kb/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bvid: 'BV1sHU9BmEne',
        p: 1,
        fileName: 'BV1sHU9BmEne-p01.md',
        markdown: '# 原文\n\n**[00:12]** 第一句话\n',
      }),
    });
    const data = (await response.json()) as { ok?: boolean; relative?: string; bytes?: number };
    expect(data.ok).toBe(true);
    expect(data.relative).toBe('50-底稿/视频原文/BV1sHU9BmEne/BV1sHU9BmEne-p01.md');
    const file = join(kbDir, '50-底稿', '视频原文', 'BV1sHU9BmEne', 'BV1sHU9BmEne-p01.md');
    expect(readFileSync(file, 'utf8')).toContain('第一句话');
  });

  test('原文接口拒绝非法 bvid、空正文和带路径的文件名', async () => {
    const badBvid = await fetch(`${base}/api/kb/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: 'not-a-bvid', p: 1, fileName: 'a-p01.md', markdown: 'x' }),
    });
    expect(badBvid.ok).toBe(false);

    const badP = await fetch(`${base}/api/kb/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: 'BV1sHU9BmEne', p: 0, fileName: 'a-p01.md', markdown: 'x' }),
    });
    expect(badP.ok).toBe(false);

    const escape = await fetch(`${base}/api/kb/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bvid: 'BV1sHU9BmEne',
        p: 1,
        fileName: '../逃逸.md',
        markdown: 'x',
      }),
    });
    expect(escape.ok).toBe(false);

    const empty = await fetch(`${base}/api/kb/source`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bvid: 'BV1sHU9BmEne', p: 1, fileName: 'a-p01.md', markdown: '   ' }),
    });
    expect(empty.ok).toBe(false);
  });
});
