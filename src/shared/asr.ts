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
 * 把整段转写文本打包成字幕行，参照 Bilitato 的 splitTranscriptionTextByPunctuation：
 * 每行不超过 80 字符，逗号/顿号也参与断行，句末标点立即断。
 * SenseVoice 只返回整段文本、没有时间戳；切得越细，大纲和知识库里的字幕才越接近逐句
 * （9 分钟英文课只按句号切会得到 12 行、每行横跨几十秒，大纲只能切 2 段）。
 */
const ASR_ROW_MAX_CHARS = 80;
const ASR_PIECE_RE = /[^。！？!?；;，,、\n]+[。！？!?；;，,、]?/gu;
const ASR_SENTENCE_END_RE = /[。！？!?；;]$/u;

function packTranscriptionRows(text: string): string[] {
  const pieces = text.match(ASR_PIECE_RE) ?? [text];
  const rows: string[] = [];
  let buffer = '';

  const flush = (): void => {
    const value = buffer.trim();
    buffer = '';
    if (value === '') return;
    if (value.length <= ASR_ROW_MAX_CHARS) {
      rows.push(value);
      return;
    }
    // 英文课可能整段没有可切标点：按空格硬切，别让一行横跨几十秒。
    let rest = value;
    while (rest.length > ASR_ROW_MAX_CHARS) {
      let cut = rest.lastIndexOf(' ', ASR_ROW_MAX_CHARS);
      if (cut < ASR_ROW_MAX_CHARS / 2) cut = ASR_ROW_MAX_CHARS;
      rows.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest !== '') rows.push(rest);
  };

  for (const piece of pieces) {
    const value = piece.trim();
    if (value === '') continue;
    if (buffer === '') {
      buffer = value;
    } else if ((buffer + value).length <= ASR_ROW_MAX_CHARS && !ASR_SENTENCE_END_RE.test(buffer)) {
      buffer += value;
    } else {
      flush();
      buffer = value;
    }
    if (ASR_SENTENCE_END_RE.test(buffer) || buffer.length >= ASR_ROW_MAX_CHARS) flush();
  }
  flush();
  return rows.filter(row => !PUNCT_ONLY_RE.test(row));
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

  const sentences = packTranscriptionRows(source);
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
