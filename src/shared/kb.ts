import type { OutlineSegment } from './outline';
import type { VideoInfo } from './types';
import type { CompanionPage } from './video-record';

/**
 * 原文底稿目录。插件把 `50-底稿` 硬编码进索引排除列表，所以放这里的 md
 * 既不会被搜到、也不报缺陷，只能从索引卡的链接点进来。
 */
export const KB_SOURCE_SUBDIR = '50-底稿/视频原文';

export const DEFAULT_KB_DIR = 'D:\\knowledge-base';

/**
 * 原文底稿的文件名。带上 BV 号，因为在知识库的目录列表里只显示文件名，
 * 光一个 `p1.md` 认不出是哪个视频。补零保证同一视频的分 P 排序正确。
 * **这是唯一一处命名规则**：扩展生成文件名，companion 只负责校验和落盘。
 */
export function kbSourceFileName(bvid: string, p: number): string {
  return `${bvid}-p${String(p).padStart(2, '0')}.md`;
}

/** 原文底稿的绝对路径（展示给人看。真正可点的链接用 kbSourceLink）。 */
export function kbSourcePath(bvid: string, p: number, kbDir: string = DEFAULT_KB_DIR): string {
  const root = kbDir.replace(/[\\/]+$/, '');
  return `${root}\\${KB_SOURCE_SUBDIR.replace(/\//g, '\\')}\\${bvid}\\${kbSourceFileName(bvid, p)}`;
}

/**
 * 从索引卡指向原文底稿的相对链接（索引卡在 `20-知识笔记/`，底稿在 `50-底稿/视频原文/<BV>/`）。
 * 用相对路径而不是绝对路径：换机器、换库根都不会断。
 */
export function kbSourceLink(bvid: string, p: number): string {
  return `../${KB_SOURCE_SUBDIR}/${bvid}/${kbSourceFileName(bvid, p)}`;
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
  /** 整片核心结论（3–5 条）；没有字幕时为空，整段不写。 */
  conclusions?: string[];
  /** 时间戳来源：`asr` 时在笔记里注明是估算值（D19）。 */
  captions?: string;
  /** 章节说明文字的来源：章节骨架 + ASR 说明时是 `asr`，和 captions 不同。 */
  detailCaptions?: string;
  /** 视频没有字幕：核心结论不生成，笔记底部注明原因（D18）。 */
  noSubtitle?: boolean;
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
 * 索引卡文件名：`<标题>（<BV号>-p<NN>）.md`。
 * - 多 P 视频共用同一个 BV 号，必须带 p 号，否则不同分 P 会互相覆盖；
 * - 不带日期：同一分 P 再存就是覆盖更新，不会堆出「11-06 / 11-07」两份；
 * - 多 P 时标题用分 P 名（`02. Python启航-初识Python`），单 P 用视频标题。
 * **这是唯一一处命名规则**：扩展生成文件名，companion 只负责校验和落盘。
 */
export function kbFileName(input: {
  title: string;
  bvid: string;
  p?: number;
  partTitle?: string;
}): string {
  const p = Number.isInteger(input.p) && (input.p ?? 0) > 0 ? (input.p as number) : 1;
  const base = safeName((input.partTitle ?? '').trim() || input.title).slice(0, 40) || input.bvid;
  const file = `${base}（${input.bvid}-p${String(p).padStart(2, '0')}）.md`;
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
  if (info.partTitle && (info.pageCount ?? 0) > 1) meta.push(info.partTitle);
  if (info.owner) meta.push(`UP：${info.owner}`);
  if (info.duration && info.duration > 0) meta.push(formatClock(info.duration));
  const part = info.pageCount && info.pageCount > 1 ? `第 ${info.p} P / 共 ${info.pageCount} P` : '';
  if (part !== '') meta.push(part);
  lines.push(`- 视频：${meta.join(' · ')}`);
  const link =
    (info.pageCount ?? 0) > 1
      ? `https://www.bilibili.com/video/${info.bvid}/?p=${info.p}`
      : `https://www.bilibili.com/video/${info.bvid}/`;
  lines.push(`- 链接：${link}`);
  lines.push(`- 存入：${localDate(now)}`);
  lines.push('');

  // 核心结论：整片要说什么。没有字幕时不写这段（D18）。
  const conclusions = (input.conclusions ?? []).map(line => line.trim()).filter(line => line !== '');
  if (conclusions.length > 0) {
    lines.push('## 核心结论');
    lines.push('');
    for (const line of conclusions) lines.push(`- ${line}`);
    lines.push('');
  }

  if (segments.length > 0) {
    lines.push('## 大纲');
    lines.push('');
    if (input.captions === 'asr') {
      lines.push('> 时间戳由语音转写按字数估算，可能有几十秒出入。');
      lines.push('');
    } else if (input.detailCaptions === 'asr') {
      lines.push('> 章节边界来自 UP 主；章节说明由语音转写内容生成，可能有误差。');
      lines.push('');
    }
    for (const segment of segments) {
      lines.push(`### [${formatClock(segment.start)}] ${segment.title}`);
      lines.push('');
      const detail = segment.detail?.trim();
      if (detail) {
        lines.push(detail);
        lines.push('');
      }
    }
  }

  if (input.keywords.length > 0) {
    lines.push('## 关键词');
    lines.push('');
    lines.push(input.keywords.join('、'));
    lines.push('');
  }

  lines.push('## 原文');
  lines.push('');
  lines.push(`- [字幕全文（${kbSourceFileName(info.bvid, info.p)}）](${kbSourceLink(info.bvid, info.p)})`);
  lines.push(`- 本机路径：\`${kbSourcePath(info.bvid, info.p, input.kbDir)}\``);
  lines.push('');

  if (input.noSubtitle) {
    lines.push('> 这个视频没有可用字幕，所以没有核心结论；大纲来自画面截图。');
    lines.push('');
  }

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
    if (page.subtitle?.source === 'asr') {
      lines.push('> 时间戳由语音转写按字数估算，可能有几十秒出入。');
      lines.push('');
    }
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
