#!/usr/bin/env node
/**
 * Video Tutor 本地 companion。
 *
 * 零依赖，只监听 127.0.0.1。扩展把课程/分 P 数据 PUT 过来，这里落成
 * data/videos/<bvid>/course.json + course.md / p<N>.json + p<N>.md。
 *
 * 用法：
 *   node companion/server.mjs [--port 8787] [--dir D:\project\video-tutor\data]
 */
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
/** 个人知识库根目录；笔记统一落 <kb>/20-知识笔记/。 */
const DEFAULT_KB_DIR = path.resolve('D:/knowledge-base');
const KB_NOTE_SUBDIR = '20-知识笔记';
/** 原文底稿目录：插件把它排除在索引之外，只能从索引卡的链接点进来。 */
const KB_SOURCE_SUBDIR = '50-底稿/视频原文';
/** 文件名白名单：中文、字母数字、空格和几个常见标点，杜绝路径穿越。 */
/** 文件名规则：只排除 Windows 真正不允许的字符，中文标点（问号、冒号、书名号）都放行。 */
function isValidKbFileName(name) {
  if (!name.endsWith('.md') || name.length > 160) return false;
  const stem = name.slice(0, -3);
  if (stem === '' || stem.includes('..')) return false;
  if (/^[. ]|[. ]$/.test(stem)) return false;
  return !/[<>:"/\\|?*\u0000-\u001F\u007F]/.test(stem);
}
const BVID_RE = /^BV[0-9A-Za-z]{10}$/;
const startedAt = Date.now();

function parseArgs(argv) {
  let port = 8787;
  let dir = DEFAULT_DIR;
  let kbDir = DEFAULT_KB_DIR;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port') {
      const raw = argv[i + 1];
      i += 1;
      if (!/^\d+$/.test(raw ?? '')) throw new Error('--port 需要 0–65535 的整数');
      port = Number(raw);
    } else if (arg === '--dir') {
      const raw = argv[i + 1];
      i += 1;
      if (!raw) throw new Error('--dir 需要目录路径');
      dir = path.resolve(raw);
    } else if (arg === '--kb') {
      const raw = argv[i + 1];
      i += 1;
      if (!raw) throw new Error('--kb 需要知识库根目录路径');
      kbDir = path.resolve(raw);
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: node companion/server.mjs [--port 8787] [--dir <dir>] [--kb <知识库根目录>]');
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port 需要 0–65535 的整数');
  }
  return { port, dir, kbDir };
}

function nowIso() {
  return new Date().toISOString();
}

function formatTime(value) {
  const seconds = Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function originAllowed(origin) {
  return origin === '' || origin.startsWith('chrome-extension://');
}

function corsHeaders(origin) {
  if (origin === '' || !originAllowed(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
}

function sendJson(res, status, data, origin) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...corsHeaders(origin),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message, origin) {
  sendJson(res, status, { ok: false, code, message }, origin);
}

function sendOptions(res, origin) {
  res.writeHead(204, {
    ...corsHeaders(origin),
    'Access-Control-Allow-Methods': 'GET,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '600',
  });
  res.end();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) {
        reject(Object.assign(new Error('请求体超过 8MB'), { code: 'too-large' }));
        return;
      }
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'bad-request' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('请求体必须是 JSON 对象'), { code: 'bad-request' });
  }
  return body;
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    // Windows 上目标存在时偶尔会拒绝 rename；清理后重试一次。
    if (error && (error.code === 'EPERM' || error.code === 'EEXIST')) {
      await fs.rm(file, { force: true });
      await fs.rename(tmp, file);
      return;
    }
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

function normalizeCourse(bvid, body) {
  const pages = Array.isArray(body.pages)
    ? body.pages
        .map(page => ({
          p: Number(page?.p),
          cid: Number(page?.cid),
          part: typeof page?.part === 'string' ? page.part : '',
          duration: Number(page?.duration),
        }))
        .filter(
          page =>
            Number.isInteger(page.p) &&
            page.p >= 1 &&
            page.p <= 10000 &&
            Number.isFinite(page.cid) &&
            page.cid > 0,
        )
    : [];
  const course = {
    schema: 1,
    bvid,
    title: typeof body.title === 'string' ? body.title : '',
    pageCount: Number.isInteger(Number(body.pageCount)) ? Number(body.pageCount) : pages.length,
    pages,
    updatedAt: nowIso(),
  };
  if (typeof body.owner === 'string' && body.owner.trim() !== '') course.owner = body.owner;
  return course;
}

function normalizePage(bvid, p, body) {
  const page = { schema: 1, bvid, p, updatedAt: nowIso() };
  const stringFields = ['partTitle', 'title', 'owner', 'indexedAt'];
  for (const key of stringFields) {
    if (typeof body[key] === 'string' && body[key] !== '') page[key] = body[key];
  }
  const numberFields = ['pageCount', 'cid', 'aid', 'duration'];
  for (const key of numberFields) {
    const value = Number(body[key]);
    if (Number.isFinite(value) && value > 0) page[key] = value;
  }
  if (Array.isArray(body.outline)) page.outline = body.outline;
  if (Array.isArray(body.qa)) page.qa = body.qa;
  if (Array.isArray(body.marks)) page.marks = body.marks;
  if (body.subtitle && typeof body.subtitle === 'object') page.subtitle = body.subtitle;
  if (!page.indexedAt) page.indexedAt = page.updatedAt;
  return page;
}

function toCourseMarkdown(course) {
  const lines = [`# ${course.title || course.bvid}`, ''];
  if (course.owner) lines.push(`- UP：${course.owner}`);
  lines.push(`- P 数：${course.pageCount ?? course.pages.length}`);
  lines.push(`- 链接：https://www.bilibili.com/video/${course.bvid}/`);
  lines.push('');
  lines.push('## 分 P');
  lines.push('');
  if (course.pages.length === 0) {
    lines.push('- （暂无）');
  } else {
    for (const page of course.pages) {
      lines.push(`- P${page.p} ${page.part || '未命名'}（${formatTime(page.duration)}）`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function subtitleBlocks(subtitle) {
  const segments = Array.isArray(subtitle?.segments) ? subtitle.segments : [];
  const ordered = [...segments].sort((a, b) => Number(a?.from) - Number(b?.from));
  const blocks = [];
  let bucket = -1;
  for (const segment of ordered) {
    const from = Number(segment?.from);
    if (!Number.isFinite(from)) continue;
    const index = Math.max(0, Math.floor(from / 60));
    const text = typeof segment?.text === 'string' ? segment.text.trim() : '';
    if (text === '') continue;
    if (blocks.length === 0 || index !== bucket) {
      blocks.push({ from, text });
      bucket = index;
    } else {
      blocks[blocks.length - 1].text += ` ${text}`;
    }
  }
  return blocks;
}

function toPageMarkdown(page) {
  const title = page.partTitle || page.title || `P${page.p}`;
  const lines = [`# ${title}`, '', '## 基本信息', ''];
  if (page.owner) lines.push(`- UP：${page.owner}`);
  lines.push(`- 时长：${formatTime(page.duration)}`);
  lines.push(
    `- 第 ${page.p} P${page.pageCount ? ` / ${page.pageCount} P` : ''}`,
  );
  lines.push(`- 链接：https://www.bilibili.com/video/${page.bvid}/?p=${page.p}`);

  if (Array.isArray(page.outline) && page.outline.length > 0) {
    lines.push('', '## 大纲', '');
    for (const segment of page.outline) {
      const start = Number(segment?.start);
      if (!Number.isFinite(start)) continue;
      const segmentTitle = typeof segment?.title === 'string' ? segment.title : '';
      lines.push(`- [${formatTime(start)}] ${segmentTitle}`);
    }
  }

  const blocks = subtitleBlocks(page.subtitle);
  if (blocks.length > 0) {
    lines.push('', '## 字幕', '');
    for (const block of blocks) {
      lines.push(`**[${formatTime(block.from)}]** ${block.text}`, '');
    }
  }

  if (Array.isArray(page.qa) && page.qa.length > 0) {
    lines.push('## 问答', '');
    for (const item of page.qa) {
      const at = Number(item?.at);
      lines.push(`**Q（[${formatTime(at)}]）** ${typeof item?.q === 'string' ? item.q : ''}`);
      lines.push(`A ${typeof item?.a === 'string' ? item.a : ''}`);
      lines.push('');
    }
  }

  if (Array.isArray(page.marks) && page.marks.length > 0) {
    lines.push('## 标记', '');
    for (const mark of page.marks) {
      const at = Number(mark?.at);
      lines.push(`- [${formatTime(at)}] ${typeof mark?.note === 'string' ? mark.note : ''}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

async function listVideos(videosRoot) {
  let entries;
  try {
    entries = await fs.readdir(videosRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const videos = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !BVID_RE.test(entry.name)) continue;
    const file = path.join(videosRoot, entry.name, 'course.json');
    try {
      const course = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!course || typeof course !== 'object') continue;
      videos.push({
        bvid: course.bvid ?? entry.name,
        title: course.title ?? '',
        pageCount: Number(course.pageCount) || 0,
        updatedAt: course.updatedAt ?? '',
      });
    } catch {
      // 单个损坏的课程目录不影响列表。
    }
  }
  videos.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return videos;
}

async function handle(req, res, videosRoot, kbDir, origin) {
  const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

  if (req.method === 'OPTIONS') {
    sendOptions(res, origin);
    return;
  }

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(
      res,
      200,
      {
        ok: true,
        version: VERSION,
        dir: path.dirname(videosRoot),
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      },
      origin,
    );
    return;
  }

  if (req.method === 'GET' && pathname === '/api/videos') {
    sendJson(res, 200, { ok: true, videos: await listVideos(videosRoot) }, origin);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/kb/status') {
    const noteDir = path.join(kbDir, KB_NOTE_SUBDIR);
    let ready = false;
    try {
      await fs.access(noteDir);
      ready = true;
    } catch {
      ready = false;
    }
    sendJson(res, 200, { ok: true, kbDir, noteDir, ready }, origin);
    return;
  }

  // 扩展「存到知识库」的落点：只往 <kb>/20-知识笔记/ 写一个 .md。
  if (req.method === 'POST' && pathname === '/api/kb/note') {
    const body = await readJsonBody(req);
    const fileName = typeof body?.fileName === 'string' ? body.fileName.trim() : '';
    const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
    if (fileName === '' || !isValidKbFileName(fileName)) {
      sendError(res, 400, 'bad-request', 'fileName 不合法（只接受纯文件名）', origin);
      return;
    }
    if (markdown.trim() === '') {
      sendError(res, 400, 'bad-request', 'markdown 不能为空', origin);
      return;
    }
    if (!kbDir) {
      sendError(res, 500, 'write-failed', '没有配置知识库目录（--kb）', origin);
      return;
    }
    const noteDir = path.join(kbDir, KB_NOTE_SUBDIR);
    const file = path.join(noteDir, fileName);
    let overwrote = false;
    try {
      await fs.access(file);
      overwrote = true;
    } catch {
      overwrote = false;
    }
    await writeAtomic(file, `${markdown.trimEnd()}\n`);
    sendJson(
      res,
      200,
      {
        ok: true,
        file,
        relative: `${KB_NOTE_SUBDIR}/${fileName}`,
        bytes: Buffer.byteLength(markdown, 'utf8'),
        overwrote,
      },
      origin,
    );
    return;
  }

  // 原文底稿：<kb>/50-底稿/视频原文/<BV>/p<NN>.md。不在索引里，只给索引卡链接用。
  if (req.method === 'POST' && pathname === '/api/kb/source') {
    const body = await readJsonBody(req);
    const bvid = typeof body?.bvid === 'string' ? body.bvid.trim() : '';
    const p = Number(body?.p);
    const markdown = typeof body?.markdown === 'string' ? body.markdown : '';
    if (!BVID_RE.test(bvid)) {
      sendError(res, 400, 'bad-request', 'bvid 不合法', origin);
      return;
    }
    if (!Number.isInteger(p) || p < 1 || p > 10000) {
      sendError(res, 400, 'bad-request', 'p 必须是 1–10000 的整数', origin);
      return;
    }
    if (markdown.trim() === '') {
      sendError(res, 400, 'bad-request', 'markdown 不能为空', origin);
      return;
    }
    if (!kbDir) {
      sendError(res, 500, 'write-failed', '没有配置知识库目录（--kb）', origin);
      return;
    }
    const sourceDir = path.join(kbDir, ...KB_SOURCE_SUBDIR.split('/'), bvid);
    const fileName = `p${p}.md`;
    const file = path.join(sourceDir, fileName);
    let overwrote = false;
    try {
      await fs.access(file);
      overwrote = true;
    } catch {
      overwrote = false;
    }
    await fs.mkdir(sourceDir, { recursive: true });
    await writeAtomic(file, `${markdown.trimEnd()}\n`);
    sendJson(
      res,
      200,
      {
        ok: true,
        file,
        relative: `${KB_SOURCE_SUBDIR}/${bvid}/${fileName}`,
        bytes: Buffer.byteLength(markdown, 'utf8'),
        overwrote,
      },
      origin,
    );
    return;
  }

  const pageMatch = /^\/api\/videos\/([^/]+)\/p\/([^/]+)$/.exec(pathname);
  if (pageMatch) {
    const bvid = decodeParam(pageMatch[1]);
    if (bvid === null) {
      sendError(res, 400, 'bad-request', 'bvid 编码不合法', origin);
      return;
    }
    if (!BVID_RE.test(bvid)) {
      sendError(res, 400, 'bad-request', 'bvid 不合法', origin);
      return;
    }
    const p = Number(pageMatch[2]);
    if (!Number.isInteger(p) || p < 1 || p > 10000) {
      sendError(res, 400, 'bad-request', 'p 必须是 1–10000 的整数', origin);
      return;
    }
    const dir = path.join(videosRoot, bvid);
    const jsonFile = path.join(dir, `p${p}.json`);
    const mdFile = path.join(dir, `p${p}.md`);

    if (req.method === 'GET') {
      try {
        const raw = await fs.readFile(jsonFile, 'utf8');
        res.writeHead(200, {
          ...corsHeaders(origin),
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(raw);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          sendError(res, 404, 'not-found', '这一 P 还没有同步', origin);
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const page = normalizePage(bvid, p, body);
      const json = `${JSON.stringify(page, null, 2)}\n`;
      const markdown = toPageMarkdown(page);
      try {
        await writeAtomic(jsonFile, json);
        await writeAtomic(mdFile, markdown);
      } catch (error) {
        throw Object.assign(new Error(`写入失败：${error?.message ?? error}`), {
          code: 'write-failed',
        });
      }
      sendJson(res, 200, { ok: true, bvid, p }, origin);
      return;
    }

    sendError(res, 404, 'not-found', '不支持的路径', origin);
    return;
  }

  const videoMatch = /^\/api\/videos\/([^/]+)$/.exec(pathname);
  if (videoMatch) {
    const bvid = decodeParam(videoMatch[1]);
    if (bvid === null) {
      sendError(res, 400, 'bad-request', 'bvid 编码不合法', origin);
      return;
    }
    if (!BVID_RE.test(bvid)) {
      sendError(res, 400, 'bad-request', 'bvid 不合法', origin);
      return;
    }
    const dir = path.join(videosRoot, bvid);
    const jsonFile = path.join(dir, 'course.json');
    const mdFile = path.join(dir, 'course.md');

    if (req.method === 'GET') {
      try {
        const raw = await fs.readFile(jsonFile, 'utf8');
        res.writeHead(200, {
          ...corsHeaders(origin),
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(raw);
      } catch (error) {
        if (error && error.code === 'ENOENT') {
          sendError(res, 404, 'not-found', '课程还没有同步', origin);
          return;
        }
        throw error;
      }
      return;
    }

    if (req.method === 'PUT') {
      const body = await readJsonBody(req);
      const course = normalizeCourse(bvid, body);
      const json = `${JSON.stringify(course, null, 2)}\n`;
      const markdown = toCourseMarkdown(course);
      try {
        await writeAtomic(jsonFile, json);
        await writeAtomic(mdFile, markdown);
      } catch (error) {
        throw Object.assign(new Error(`写入失败：${error?.message ?? error}`), {
          code: 'write-failed',
        });
      }
      sendJson(res, 200, { ok: true, bvid }, origin);
      return;
    }

    sendError(res, 404, 'not-found', '不支持的路径', origin);
    return;
  }

  sendError(res, 404, 'not-found', '路径不存在', origin);
}

async function main() {
  const { port, dir, kbDir } = parseArgs(process.argv.slice(2));
  const videosRoot = path.join(dir, 'videos');

  const server = http.createServer((req, res) => {
    const started = Date.now();
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';

    if (!originAllowed(origin)) {
      sendError(res, 403, 'forbidden-origin', '只接受 chrome-extension:// 或空的 Origin', origin);
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
      return;
    }

    void handle(req, res, videosRoot, kbDir, origin)
      .catch(error => {
        const rawCode =
          error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        const code =
          rawCode === 'bad-request' || rawCode === 'too-large' ? rawCode : 'write-failed';
        const status = code === 'bad-request' ? 400 : code === 'too-large' ? 413 : 500;
        const message = error instanceof Error ? error.message : String(error);
        if (!res.headersSent) {
          sendError(res, status, code, message, origin);
        } else {
          res.destroy();
        }
      })
      .finally(() => {
        console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
      });
  });

  server.on('error', error => {
    console.error(`companion 启动失败：${error.message}`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    console.log(`listening on 127.0.0.1:${actualPort}`);
    console.log(`kb dir: ${kbDir}`);
  });

  const shutdown = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
