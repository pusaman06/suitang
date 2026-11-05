import { formatTimestamp } from './citations';
import { compactCuesForOutline, type OutlineLine, type OutlineRange, segmentRange } from './outline';
import type { ChatMessage } from './qa';
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
}

export function outlineSystemPrompt(range: OutlineRange, title: string, duration: number): string {
  const target = Math.round((range.min + range.max) / 2);
  const each = Math.max(30, Math.round(duration / target));
  return [
    `你是课程笔记助手。下面是视频《${title}》的完整字幕（带时间戳）。`,
    `请输出 JSON 数组，每项 {start, end, title}，把视频切成 ${range.min}–${range.max} 个主题段。`,
    `按字幕总量看，最合适的切法是正好 ${target} 段、每段约 ${each} 秒。不要按每行字幕切，` +
      `那样会切出几十段。`,
    'start 和 end 必须是整数秒（例如 2 分 5 秒写 125），不要写 "02:05" 这种时间戳。',
    'title 用 8–16 个汉字，概括这一段在讲什么。',
    '硬约束：',
    '1. 按时间顺序首尾相接覆盖全片：首段 start=0，末段 end ≥ 视频时长。',
    '2. 时间戳只能用字幕行开头给出的时间，不要自己估算。',
    '3. 只输出 JSON 数组，不要 markdown 围栏，不要解释。',
  ].join('\n');
}

/** 无字幕时返回 null，调用方按 no-subtitle 处理，不把空上下文发给模型。 */
export function buildOutlinePrompt(input: OutlinePromptInput): OutlinePrompt | null {
  const range = segmentRange(input.duration);
  const lines: OutlineLine[] = compactCuesForOutline(input.cues, input.maxChars);
  if (lines.length === 0) return null;

  const subtitleText = lines
    .map(line => `[${formatTimestamp(line.from)}] ${line.text}`)
    .join('\n');
  const user = `视频：《${input.title}》（时长 ${formatTimestamp(input.duration)}）\n\n字幕：\n${subtitleText}`;

  return {
    messages: [
      { role: 'system', content: outlineSystemPrompt(range, input.title, input.duration) },
      { role: 'user', content: user },
    ],
    range,
    lines: lines.length,
  };
}
