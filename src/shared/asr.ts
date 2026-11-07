/** ASR 兜底：把整段转写文本按句切分并铺到时间轴上。 */

export const ASR_SCHEMA = 1;

export interface AsrSegment {
  start: number;
  end: number;
  text: string;
}

export interface AsrResult {
  bvid: string;
  p: number;
  cid: number;
  duration: number;
  segments: AsrSegment[];
  model: string;
  createdAt: number;
}

export type AsrStage = 'download' | 'slice' | 'transcribe';

export interface AsrProgress {
  stage: AsrStage;
  done: number;
  total: number;
}

export type AsrErrorCode =
  | 'no-key'
  | 'no-audio'
  | 'stale'
  | 'download'
  | 'too-large'
  | 'too-long'
  | 'transcribe'
  | 'empty'
  | 'unknown';

export interface AsrError {
  code: AsrErrorCode;
  message: string;
}

export interface AsrTranscribeRequest {
  type: 'asr:transcribe';
  bvid: string;
  p: number;
  cid?: number;
  title?: string;
  duration?: number;
}

export type AsrTranscribeResponse =
  | { ok: true; cached?: boolean }
  | { ok: false; code: AsrErrorCode; message: string };

export function asrStorageKey(bvid: string, p: number, cid: number): string {
  return `asr:${bvid}:${p}:${cid}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu;
// 连续 3 个以上的同一填充词压成一个；保留单个，语气信息还在。
const FILLER_RE = /(呃|啊|嗯|那个)(?:[\s，,、]*\1){2,}/gu;
const PUNCT_ONLY_RE = /^[\p{P}\p{S}\s]+$/u;

function cleanAsrText(text: string): string {
  return text
    .replace(EMOJI_RE, '')
    .replace(FILLER_RE, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * 英文 ASR 有时整段没有句末标点（SenseVoice 对英文课常见），只切成一句会让大纲
 * 退化成 1–2 段；按逗号/分号再切，仍切不动就在 ~80 字符处按空格硬切。
 */
function splitLongSentence(sentence: string): string[] {
  const byPause = sentence
    .split(/(?<=[,;:])\s+/u)
    .map(item => item.trim())
    .filter(item => item !== '' && !PUNCT_ONLY_RE.test(item));
  if (byPause.length > 1) return byPause;

  const chunks: string[] = [];
  let rest = sentence.trim();
  while (rest.length > 80) {
    let cut = rest.lastIndexOf(' ', 80);
    if (cut < 40) cut = 80;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest !== '') chunks.push(rest);
  return chunks.filter(item => item !== '' && !PUNCT_ONLY_RE.test(item));
}

/**
 * 按中英文标点切句，并在 [start, end] 内按字符数加权分配时间。
 * SiliconFlow 只返回整段文本，没有时间戳；片内均分对大纲足够用。
 */
export function splitIntoSentences(text: string, start: number, end: number): AsrSegment[] {
  const source = cleanAsrText(String(text ?? ''));
  if (source === '') return [];

  const safeStart = Number.isFinite(start) ? Math.max(0, start) : 0;
  const safeEnd = Number.isFinite(end) ? Math.max(safeStart + 0.1, end) : safeStart + 0.1;
  const span = safeEnd - safeStart;

  let sentences = source
    .split(/[。！？；\n]+|(?<=[.!?])\s+/u)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence !== '' && !PUNCT_ONLY_RE.test(sentence));
  // SenseVoice 对英文课常只返回逗号分隔的大段文本（一句 500+ 字符、横跨几十秒），
  // 不细分的话 9 分钟课程只切出十几句，大纲只能切出 2 段。长句继续按逗号/空格拆。
  sentences = sentences.flatMap(sentence =>
    sentence.length > 120 ? splitLongSentence(sentence) : [sentence],
  );
  if (sentences.length === 0) return [];

  const weights = sentences.map(sentence => Math.max(1, sentence.length));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const segments: AsrSegment[] = [];
  let cursor = safeStart;

  for (let index = 0; index < sentences.length; index += 1) {
    const isLast = index === sentences.length - 1;
    let segmentEnd = isLast
      ? safeEnd
      : cursor + (span * weights[index]) / totalWeight;
    segmentEnd = clamp(segmentEnd, safeStart, safeEnd);
    // 极短片段里句子数很多时也不生成零长度段。
    if (segmentEnd <= cursor) segmentEnd = Math.min(safeEnd, cursor + 0.1);
    if (segmentEnd <= cursor) break;
    segments.push({ start: cursor, end: segmentEnd, text: sentences[index] });
    cursor = segmentEnd;
  }

  return segments;
}

/**
 * 合并多片转写结果：相邻同文本合并，重叠部分从前一段结尾开始，按时间排序。
 */
export function mergeAsrSegments(parts: AsrSegment[]): AsrSegment[] {
  const sorted = parts
    .filter(
      part =>
        Number.isFinite(part.start) &&
        Number.isFinite(part.end) &&
        part.end > part.start &&
        typeof part.text === 'string',
    )
    .map(part => ({
      start: Math.max(0, part.start),
      end: Math.max(0, part.end),
      text: part.text.trim(),
    }))
    .filter(part => part.text !== '')
    .sort((a, b) => a.start - b.start);

  const merged: AsrSegment[] = [];
  for (const part of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.text === part.text) {
      last.end = Math.max(last.end, part.end);
      continue;
    }
    if (last && part.start < last.end) part.start = last.end;
    if (part.end <= part.start) continue;
    merged.push(part);
  }
  return merged;
}
