import type { SubtitleCue } from './types';

/** 大纲缓存格式版本；结构不兼容时直接丢弃旧缓存。 */
export const OUTLINE_SCHEMA = 1;

export interface OutlineSegment {
  start: number;
  end: number;
  title: string;
}

export interface Outline {
  bvid: string;
  p: number;
  cid?: number;
  duration: number;
  segments: OutlineSegment[];
  createdAt: number;
  model: string;
}

export interface OutlineRange {
  min: number;
  max: number;
}

export type OutlineErrorCode =
  | 'no-key'
  | 'no-subtitle'
  | 'network'
  | 'bad-output'
  | 'empty'
  | 'unknown';

export type OutlineGetResponse =
  | { ok: true; outline: Outline | null }
  | { ok: false; code: OutlineErrorCode; message: string };

export type OutlineGenerateResponse =
  | { ok: true; outline: Outline }
  | { ok: false; code: OutlineErrorCode; message: string };

/** 一个窗口内合并后的字幕行。 */
export interface OutlineLine {
  from: number;
  text: string;
}

export function outlineStorageKey(bvid: string, p: number, cid?: number): string {
  return `outline:${bvid}:${p}:${cid ?? 'nocid'}`;
}

/** 段数按时长自适应，避免短视频被切碎、长视频只有几块。 */
export function segmentRange(duration: number): OutlineRange {
  if (Number.isFinite(duration) && duration <= 300) return { min: 3, max: 6 };
  if (Number.isFinite(duration) && duration <= 1200) return { min: 6, max: 10 };
  return { min: 8, max: 15 };
}

/** 无字幕兜底抽帧数：视频越长，画面信息越分散，需要更多帧。 */
export function outlineFrameCount(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return 6;
  if (duration <= 120) return 6;
  if (duration <= 600) return 8;
  return 10;
}

/** 均匀取样并避开首尾：取每段中点，而不是从 0 秒开始。 */
export function outlineFrameTimes(duration: number): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const count = outlineFrameCount(duration);
  return Array.from({ length: count }, (_, index) => ((index + 0.5) / count) * duration);
}

/**
 * 把字幕按固定时间窗合并成行，from 取窗口内第一条字幕的时间。
 * 输入若乱序会先排序；空文本直接跳过。
 */
export function mergeCuesByWindow(cues: SubtitleCue[], windowSec: number): OutlineLine[] {
  const size = Number.isFinite(windowSec) && windowSec > 0 ? windowSec : 15;
  const sorted = cues
    .filter(cue => Number.isFinite(cue.from) && cue.content.trim() !== '')
    .slice()
    .sort((a, b) => a.from - b.from);

  const lines: OutlineLine[] = [];
  let windowIndex = -1;
  for (const cue of sorted) {
    const from = Math.max(0, cue.from);
    const index = Math.floor(from / size);
    const text = cue.content.trim();
    const last = lines[lines.length - 1];
    if (!last || index !== windowIndex) {
      lines.push({ from, text });
      windowIndex = index;
    } else {
      last.text = `${last.text} ${text}`;
    }
  }
  return lines;
}

/**
 * 先按 15s 合并，仍超字符预算就按行均匀抽稀：
 * 每 k 行取一行，k = ceil(总字符 / 预算)，保证整片都有代表。
 */
export function compactCuesForOutline(
  cues: SubtitleCue[],
  maxChars = 14000,
): OutlineLine[] {
  const lines = mergeCuesByWindow(cues, 15);
  const budget = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1;
  const total = lines.reduce((sum, line) => sum + line.text.length, 0);
  if (total <= budget) return lines;

  const step = Math.ceil(total / budget);
  const picked = lines.filter((_, index) => index % step === 0);
  // 抽稀不能把最后一行丢掉：末段要靠它补到片尾，否则大纲尾部会缺一块。
  const tail = lines[lines.length - 1];
  if (picked[picked.length - 1] !== tail) picked.push(tail);
  return picked;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 模型经常照着字幕行的 mm:ss 格式写时间，这里两种都认：
 * 纯数字按秒，`10:32` / `1:02:03` 按时分秒换算。解析不了返回 NaN。
 */
export function toSeconds(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string') return Number.NaN;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  const match = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{1,2})$/.exec(text);
  if (!match) return Number.NaN;
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * 解析模型返回的大纲 JSON，并做边界、排序、去重叠、首尾覆盖和段数校验。
 * 输出不合格时返回 null，让调用方提示用户重试，不硬凑段数。
 */
export function parseOutline(
  text: string,
  duration: number,
  range: OutlineRange,
): OutlineSegment[] | null {
  const source = String(text).replace(/```(?:json)?/gi, '').trim();
  const first = source.indexOf('[');
  const last = source.lastIndexOf(']');
  if (first < 0 || last <= first) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.slice(first, last + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const limit = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const candidates: OutlineSegment[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const start = toSeconds(raw.start);
    const end = toSeconds(raw.end);
    const title = typeof raw.title === 'string' ? raw.title.trim() : String(raw.title ?? '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || title === '' || start >= end) continue;

    // 先夹到视频时长内；end 至少比 start 晚 1 秒，否则这一项没有意义。
    let safeStart = clamp(start, 0, limit);
    let safeEnd = clamp(end, 0, limit);
    if (safeEnd < safeStart + 1) safeEnd = Math.min(limit, safeStart + 1);
    if (safeEnd <= safeStart) continue;

    candidates.push({ start: safeStart, end: safeEnd, title });
  }

  candidates.sort((a, b) => a.start - b.start);

  // 后一段如果和上一段重叠，就从上一段结尾开始；压没了的段直接丢弃。
  const segments: OutlineSegment[] = [];
  for (const segment of candidates) {
    const previous = segments[segments.length - 1];
    if (previous && segment.start < previous.end) segment.start = previous.end;
    if (segment.start >= segment.end) continue;
    segments.push(segment);
  }

  if (segments.length === 0) return null;

  segments[0].start = 0;

  const lastSegment = segments[segments.length - 1];
  if (limit - lastSegment.end < 30) lastSegment.end = limit;

  if (segments.length < range.min) return null;
  // 模型经常按字幕粒度切得太碎（比如 42 分钟切 27 段）。硬拒不如合并：
  // 均匀分组，组内首尾相接，标题取组里第一段的。
  return coalesceSegments(segments, range.max);
}

/** 把过多的小段均匀合并到 max 段以内；不改变覆盖范围。 */
export function coalesceSegments(segments: OutlineSegment[], max: number): OutlineSegment[] {
  if (segments.length <= max) return segments;
  const merged: OutlineSegment[] = [];
  for (let index = 0; index < max; index += 1) {
    const from = Math.floor((index * segments.length) / max);
    const to = Math.floor(((index + 1) * segments.length) / max);
    const chunk = segments.slice(from, to);
    if (chunk.length === 0) continue;
    merged.push({
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      title: chunk[0].title,
    });
  }
  return merged;
}
