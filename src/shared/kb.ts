import type { OutlineSegment } from './outline';
import type { VideoInfo } from './types';
import type { CompanionPage } from './video-record';

/** 个人知识库的落库规则，见 D:\knowledge-base\_模板\视频笔记.md。 */
export const KB_NOTE_SUBDIR = '20-知识笔记';

/**
 * 原文底稿目录。插件把 `50-底稿` 硬编码进索引排除列表，所以放这里的 md
 * 既不会被搜到、也不报缺陷，只能从索引卡的链接点进来。
 */
export const KB_SOURCE_SUBDIR = '50-底稿/视频原文';

export const DEFAULT_KB_DIR = 'D:\\knowledge-base';

/** 原文底稿的绝对路径，写进索引卡的「原文」一节。 */
export function kbSourcePath(bvid: string, p: number, kbDir: string = DEFAULT_KB_DIR): string {
  const root = kbDir.replace(/[\\/]+$/, '');
  const pp = String(p).padStart(2, '0');
  return `${root}\\${KB_SOURCE_SUBDIR.replace(/\//g, '\\')}\\${bvid}\\p${pp}.md`;
}

export interface KbQaPair {
  question: string;
  answer: string;
}

export interface KbNoteInput {
  info: VideoInfo;
  segments: OutlineSegment[];
  qa: KbQaPair[];
  summary: string;
  keywords: string[];
  now?: Date;
  /** 知识库根目录；不传就用默认值，只影响「原文」里写的绝对路径。 */
  kbDir?: string;
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = total % 60;
  const mm = String(hours > 0 ? minutes : minutes).padStart(2, '0');
  const ss = String(rest).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** 本地时区的日期（YYYY-MM-DD）。UTC 会把晚上入库的笔记算到前一天。 */
export function localDate(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Windows 文件名里不能出现的字符换成短横线。 */
function safeName(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[. ]+|[. ]+$/g, '')
    .trim();
}

/**
 * 文件名：`<本地日期>-<视频标题>（<BV号>）.md`。
 * 带上 BV 号是因为课程里同名视频很常见（「第 1 讲」这种）。
 */
export function kbFileName(input: { title: string; bvid: string; now?: Date }): string {
  const date = localDate(input.now);
  const title = safeName(input.title).slice(0, 40) || input.bvid;
  const file = `${date}-${title}（${input.bvid}）.md`;
  return safeName(file).replace(/\.md$/, '') + '.md';
}

function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function tagList(input: KbNoteInput): string[] {
  const tags = ['视频笔记', 'B站', input.info.bvid];
  for (const word of input.keywords) {
    const clean = word.replace(/[,\[\]"]/g, '').trim();
    if (clean === '' || tags.includes(clean)) continue;
    tags.push(clean);
    if (tags.length >= 6) break;
  }
  return tags;
}

export function buildKbMarkdown(input: KbNoteInput): string {
  const { info, segments, qa } = input;
  const now = input.now ?? new Date();
  const title = info.title.trim() || info.bvid;
  const lines: string[] = [];

  lines.push('---');
  lines.push(`title: ${yamlString(title)}`);
  lines.push('type: 知识');
  lines.push(`tags: [${tagList(input).map(tag => `"${tag}"`).join(', ')}]`);
  lines.push('status: 已完成');
  lines.push('---');
  lines.push('');
  lines.push(`# ${title}`);
  lines.push('');
  const summary = input.summary.trim();
  if (summary !== '') {
    lines.push(`> ${summary}`);
    lines.push('');
  }

  lines.push('## 基本信息');
  lines.push('');
  const meta: string[] = [title];
  if (info.owner) meta.push(`UP：${info.owner}`);
  if (info.duration && info.duration > 0) meta.push(formatClock(info.duration));
  const part = info.pageCount && info.pageCount > 1 ? `第 ${info.p} P / 共 ${info.pageCount} P` : '';
  if (part !== '') meta.push(part);
  lines.push(`- 视频：${meta.join(' · ')}`);
  lines.push(`- 链接：https://www.bilibili.com/video/${info.bvid}/`);
  lines.push(`- 存入：${localDate(now)}`);
  lines.push('');

  if (segments.length > 0) {
    lines.push('## 大纲');
    lines.push('');
    for (const segment of segments) {
      lines.push(`- [${formatClock(segment.start)}] ${segment.title}`);
    }
    lines.push('');
  }

  if (input.keywords.length > 0) {
    lines.push('## 关键词');
    lines.push('');
    lines.push(input.keywords.join('、'));
    lines.push('');
  }

  lines.push('## 原文');
  lines.push('');
  lines.push(`- 字幕全文：\`${kbSourcePath(info.bvid, info.p, input.kbDir)}\``);
  lines.push('');

  // 只在真的问过时才写这一段：没问过就整段不要，也不留空标题。
  if (qa.length > 0) {
    lines.push('## 当时我问了什么');
    lines.push('');
    for (const item of qa) {
      lines.push(`**Q**：${item.question.trim()}`);
      lines.push('');
      lines.push(`A：${item.answer.trim()}`);
      lines.push('');
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * 原文底稿：字幕全文 + 大纲 + 问答，落到 `50-底稿/视频原文/<BV>/p<NN>.md`。
 * 故意不写 frontmatter——它在插件的排除目录里，本来就不该进索引。
 */
export function buildKbSourceMarkdown(page: CompanionPage, now: Date = new Date()): string {
  const title = page.partTitle || page.title || `P${page.p}`;
  const lines: string[] = [];

  lines.push(`# ${title}`, '');
  lines.push('## 基本信息', '');
  if (page.owner) lines.push(`- UP：${page.owner}`);
  if (page.duration && page.duration > 0) lines.push(`- 时长：${formatClock(page.duration)}`);
  const part =
    page.pageCount && page.pageCount > 1
      ? `第 ${page.p} P / 共 ${page.pageCount} P`
      : `第 ${page.p} P`;
  lines.push(`- ${part}`);
  lines.push(`- 链接：https://www.bilibili.com/video/${page.bvid}/?p=${page.p}`);
  lines.push(`- 入库：${localDate(now)}`);
  lines.push('');

  const segments = page.outline ?? [];
  if (segments.length > 0) {
    lines.push('## 大纲', '');
    for (const segment of segments) {
      lines.push(`- [${formatClock(segment.start)}] ${segment.title}`);
    }
    lines.push('');
  }

  const cues = page.subtitle?.segments ?? [];
  if (cues.length > 0) {
    lines.push('## 字幕', '');
    for (const cue of cues) {
      lines.push(`**[${formatClock(cue.from)}]** ${cue.text.trim()}`, '');
    }
  }

  const qa = page.qa ?? [];
  if (qa.length > 0) {
    lines.push('## 问答', '');
    for (const item of qa) {
      lines.push(`**Q（[${formatClock(item.at)}]）** ${item.q.trim()}`);
      lines.push('');
      lines.push(`A：${item.a.trim()}`);
      lines.push('');
    }
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** 只让模型干两件小事：一句话摘要 + 关键词。大纲和问答都是现成的，不再花一次钱。 */
export function buildKbSummaryPrompt(input: {
  info: VideoInfo;
  segments: OutlineSegment[];
}): ChatMessage[] {
  const { info, segments } = input;
  const system = [
    '你在帮用户把一期 B 站视频整理成知识库条目。',
    '条目定位是「资料索引」，不是读后感：只写这期讲了什么、值不值得回看。',
    '不要编用户的学习心得，不要编用户没问过的问题。',
    '只输出一个 JSON 对象，不要代码围栏，不要解释：',
    '{"summary": "一句话，30–60 字", "keywords": ["3–6 个便于检索的词"]}',
  ].join('\n');

  const outlineText =
    segments.length > 0
      ? segments.map(segment => `[${formatClock(segment.start)}] ${segment.title}`).join('\n')
      : '（这期还没生成大纲）';

  const user = [
    `视频：《${info.title}》`,
    info.owner ? `UP：${info.owner}` : '',
    info.duration ? `时长：${formatClock(info.duration)}` : '',
    '',
    '大纲：',
    outlineText,
  ]
    .filter(line => line !== '')
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

export function parseKbSummary(text: string): { summary: string; keywords: string[] } | null {
  const source = String(text).replace(/```(?:json)?/gi, '').trim();
  const first = source.indexOf('{');
  const last = source.lastIndexOf('}');
  if (first < 0 || last <= first) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const raw = parsed as Record<string, unknown>;
  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  const keywords = Array.isArray(raw.keywords)
    ? raw.keywords.filter((item): item is string => typeof item === 'string').map(item => item.trim())
    : [];
  const kept = keywords.filter(item => item !== '').slice(0, 8);
  if (summary === '' && kept.length === 0) return null;
  return { summary, keywords: kept };
}
