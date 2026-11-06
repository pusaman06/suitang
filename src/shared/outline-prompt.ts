import { formatTimestamp } from './citations';
import {
  compactCuesForOutline,
  type OutlineLine,
  type OutlineRange,
  type OutlineSegment,
  segmentRange,
} from './outline';
import type { ChatContentPart, ChatMessage, QaFrame } from './qa';
import type { SubtitleCue } from './types';

export interface OutlinePromptInput {
  title: string;
  duration: number;
  cues: SubtitleCue[];
  maxChars?: number;
}

export interface OutlinePrompt {
  messages: ChatMessage[];
  range: OutlineRange;
  lines: number;
  /** 送给模型的行（含 from 时间），用于把行号反查回时间（D14）。 */
  lineList: OutlineLine[];
}

export interface FrameOutlinePromptInput {
  title: string;
  duration: number;
  frames: QaFrame[];
}

export interface FrameOutlinePrompt {
  messages: ChatMessage[];
  range: OutlineRange;
}

export function outlineSystemPrompt(range: OutlineRange, title: string, duration: number): string {
  const target = Math.round((range.min + range.max) / 2);
  const each = Math.max(30, Math.round(duration / target));
  return [
    `你是课程笔记助手。下面是视频《${title}》的完整字幕，每行开头是「#行号 [时间]」，行号从 0 开始连续编号。`,
    `请输出 JSON 数组，每项 {start_line, end_line, title}，把视频切成 ${range.min}–${range.max} 个主题段。`,
    `按字幕总量看，最合适的切法是正好 ${target} 段、每段约 ${each} 秒。不要按每行字幕切，` +
      `那样会切出几十段。`,
    'start_line 和 end_line 必须是字幕行开头的 # 编号（整数），不要自己算秒数、也不要写时间戳。',
    'title 用 8–16 个汉字，概括这一段在讲什么。',
    '硬约束：',
    '1. 按时间顺序首尾相接覆盖全片：第一项 start_line = 0，最后一项 end_line = 最后一行行号。',
    '2. 相邻两项要接上（后一项 start_line = 前一项 end_line），不要重叠也不要留空。',
    '3. 只输出 JSON 数组，不要 markdown 围栏，不要解释。',
  ].join('\n');
}

/** 无字幕时返回 null，调用方按 no-subtitle 处理，不把空上下文发给模型。 */
export function buildOutlinePrompt(input: OutlinePromptInput): OutlinePrompt | null {
  const range = segmentRange(input.duration);
  const lines: OutlineLine[] = compactCuesForOutline(input.cues, input.maxChars);
  if (lines.length === 0) return null;

  const subtitleText = lines
    .map((line, index) => `#${index} [${formatTimestamp(line.from)}] ${line.text}`)
    .join('\n');
  const user = `视频：《${input.title}》（时长 ${formatTimestamp(input.duration)}）\n\n字幕：\n${subtitleText}`;

  return {
    messages: [
      { role: 'system', content: outlineSystemPrompt(range, input.title, input.duration) },
      { role: 'user', content: user },
    ],
    range,
    lines: lines.length,
    lineList: lines,
  };
}

export interface OutlineDetailPromptInput {
  title: string;
  duration: number;
  segments: OutlineSegment[];
  cues: SubtitleCue[];
  maxChars?: number;
}

export interface OutlineDetailPrompt {
  messages: ChatMessage[];
  lines: number;
}

export interface OutlineDetailResult {
  /** 与传入的 segments 等长；没有说明的位置是空串。 */
  details: string[];
  conclusions: string[];
}

/**
 * D16 + D18：一次调用同时产出「每段讲了哪些事」和「整片核心结论」。
 * 字幕按段落切开再喂，模型不用自己按时间对齐，说明更贴内容。
 */
export function buildOutlineDetailPrompt(input: OutlineDetailPromptInput): OutlineDetailPrompt | null {
  const segments = input.segments;
  if (segments.length === 0) return null;

  const budget = Number.isFinite(input.maxChars) && (input.maxChars ?? 0) > 0 ? Math.floor(input.maxChars ?? 0) : 36000;
  const perSegment = Math.max(200, Math.floor(budget / segments.length));

  const blocks: string[] = [];
  let used = 0;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const text = input.cues
      .filter(cue => cue.from >= segment.start && cue.from < segment.end)
      .map(cue => cue.content)
      .join('')
      .slice(0, perSegment);
    used += text.length;
    blocks.push(
      `## 第 ${index + 1} 段 [${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)}] ${segment.title}\n${text}`,
    );
  }

  const system = [
    `你是课程笔记助手。下面是视频《${input.title}》（时长 ${formatTimestamp(input.duration)}）已经分好的 ${segments.length} 段大纲，每段后面附上这一段范围内的字幕原文。`,
    '请做两件事：',
    '1. 为每一段写 1–2 句话，说明这一段**具体讲了哪些事**（讲内容：讲了什么概念、举了什么例子、给出了什么方法）。不要写评价、不要写「值得学习」这类空话。',
    '2. 再写 3–5 条整片的**核心结论**：用你自己的话概括这个视频到底想说什么。可以合并多处内容，但**不得引入字幕里没有的信息**，也不要写成「视频提到了……」这种描述。',
    '只输出一个 JSON 对象，格式：',
    '{"sections":[{"index":1,"detail":"这一段的内容说明"}],"conclusions":["结论一","结论二"]}',
    'index 用上面的大纲段号（从 1 开始）。不要 markdown 围栏，不要解释。',
  ].join('\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: blocks.join('\n\n') },
    ],
    lines: used,
  };
}

/** 解析 D16/D18 的返回；容忍代码围栏、段号越界、条数超限。 */
export function parseOutlineDetail(text: string, segmentCount: number): OutlineDetailResult | null {
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
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const details = new Array<string>(segmentCount).fill('');
  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  for (const item of sections) {
    if (!item || typeof item !== 'object') continue;
    const section = item as Record<string, unknown>;
    const index = Number(section.index);
    const detail = typeof section.detail === 'string' ? section.detail.trim() : '';
    if (!Number.isInteger(index) || detail === '') continue;
    const slot = index - 1;
    if (slot < 0 || slot >= segmentCount) continue;
    if (details[slot] === '') details[slot] = detail.slice(0, 200);
  }

  const conclusions: string[] = [];
  const list = Array.isArray(raw.conclusions) ? raw.conclusions : [];
  for (const item of list) {
    const line = typeof item === 'string' ? item.trim() : '';
    if (line === '' || conclusions.includes(line)) continue;
    conclusions.push(line.slice(0, 200));
    if (conclusions.length >= 5) break;
  }

  if (details.every(detail => detail === '') && conclusions.length === 0) return null;
  return { details, conclusions };
}

/**
 * 无字幕/无章节时的视觉大纲 prompt：按时间顺序把截图和对应时间戳交叠发给模型。
 * 图片用 low detail（每张约 384 token），大字卡片也够读。
 * 只让模型给标题——时间戳由 `framesToSegments` 按帧时间算，避免整体错位。
 */export function buildFrameOutlinePrompt(input: FrameOutlinePromptInput): FrameOutlinePrompt | null {
  const frames = input.frames.filter(
    frame =>
      typeof frame.dataUrl === 'string' &&
      frame.dataUrl.startsWith('data:image/jpeg;base64,') &&
      Number.isFinite(frame.at),
  );
  if (frames.length === 0) return null;

  const range = segmentRange(input.duration);
  const system = [
    `你是课程笔记助手。下面是视频《${input.title}》（时长 ${formatTimestamp(input.duration)}）按时间顺序抽取的 ${frames.length} 张截图，每张前面标了它在视频里的时间。`,
    `请为每张截图写一个 8–14 个汉字的标题，概括这一屏在讲什么。`,
    '相邻两张如果是同一个主题，标题写成完全一样的，我会把相同标题合并成一段。',
    `只输出 JSON 字符串数组，长度必须正好是 ${frames.length}，例如 ["开场介绍","一句话出图"]。`,
    '不要 markdown 围栏，不要解释，不要输出时间。',
  ].join('\n');

  const content: ChatContentPart[] = [];
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    content.push({
      type: 'text',
      text: `第 ${index + 1} 张，时间 ${formatTimestamp(frame.at)}`,
    });
    content.push({
      type: 'image_url',
      image_url: { url: frame.dataUrl, detail: 'low' },
    });
  }

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
    range,
  };
}
