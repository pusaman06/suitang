/**
 * 问答上下文组装（D3 切片 1：当前时间 ±90 秒字幕 + 课程结构）。
 * 纯函数，不碰 chrome / DOM。
 */

import type { ChatMessage } from './qa';
import type { SubtitleCue } from './types';
import { formatTimestamp } from './citations';

export const QA_SYSTEM_PROMPT = `你是坐在用户旁边一起看课的学霸朋友：懂技术，说话自然，不端着，也不掉书袋。
用户在看 B 站课程，随时暂停问你问题。

回答方式：
- 像聊天一样直接说，不要「首先/其次/综上」这种模板腔，不要动不动列小标题。
- 默认只讲核心，两到四句话说清楚。用户没让你展开就别展开，也不要顺手把相关概念都讲一遍。
- 遇到新名词先用一句话带过，等用户追问「那 X 是什么」时再详细讲。
- 用户说「详细讲讲 / 展开 / 举个例子 / 为什么」时再放开，可以分点、可以举例。
- 视频里讲到的内容，句末标 [mm:ss]；时间戳只能取自给定字幕行开头的时间，不要估算。
- 视频没讲、但不补一句就听不懂的地方，用「补一句：」引出，一两句即可，别写小论文。
- 不编造视频里的台词、画面和时间戳。`;

/** 无字幕时追加到 system 末尾。 */
export const QA_NO_SUBTITLE_NOTE =
  '本视频没有可用字幕。视频内容只能依据标题、分 P 标题和画面，不要编造台词；概念讲解照样可以给，但同样保持简短。';

/** 带画面时追加到 system 末尾；用户要求原样保留这段措辞。 */
export const QA_FRAME_NOTE =
  '用户附带了当前视频画面截图。画面中的文字可以直接引用；引用画面内容时用「画面中」开头。不要编造画面里没有的内容。';

/** 全局问题（整节/全片/总结）：±90 秒窗口答不了，改用全片抽稀字幕 + 已生成大纲。 */
export const QA_GLOBAL_NOTE =
  '用户问的是整段视频的整体问题，下面附的是全片字幕按时间抽稀后的摘要，时间不连续。请按时间顺序概括，不要因为摘要里没出现某句台词就断言视频没讲过。';

/**
 * 判断是不是「整节课」级别的提问。只影响给模型多少上下文，
 * 判错也只是多给或少给内容，不会改变回答口径。
 */
const GLOBAL_QUESTION_PATTERN =
  /(整节|整堂|整个视频|整段视频|全片|全视频|从头到尾|通篇|全部内容|整体|一共|总共|总结|概括|大纲|脉络|知识点|知识结构|章节|结构|讲了(哪|几)|分成几|分几个)/;

export function isGlobalQuestion(question: string): boolean {
  return GLOBAL_QUESTION_PATTERN.test(question);
}

export interface QaPromptTurn {
  q: string;
  a: string;
}

export interface QaPromptInput {
  title: string;
  partTitle?: string;
  pageCount?: number;
  duration?: number;
  /** 提问瞬间的播放位置（秒）。 */
  at: number;
  question: string;
  /** 当前 P 的全量字幕；空数组表示无字幕。 */
  cues?: SubtitleCue[];
  /** 前后各取多少秒，默认 90。 */
  windowSec?: number;
  /** 输入预算（估算 token），默认 3000；超出时先缩窗口再截行。 */
  maxInputTokens?: number;
  /** 切片 1 固定传 0；签名保留给多轮。 */
  historyTurns?: number;
  history?: QaPromptTurn[];
  /** 已裁剪好的暂停帧；有值时最后一条 user 消息改成 image + text。 */
  frame?: { dataUrl: string };
  /** local = 只给播放点附近；global = 全片抽稀；auto 按问题判断（默认）。 */
  mode?: 'auto' | 'local' | 'global';
  /** 全局问题时附带的已生成大纲，帮助模型建立全片结构。 */
  outline?: Array<{ start: number; end: number; title: string }>;
}

export interface QaPromptWindow {
  start: number;
  end: number;
  cues: number;
  estimatedInputTokens: number;
  truncated: boolean;
  noSubtitle: boolean;
}

export interface QaPromptResult {
  messages: ChatMessage[];
  window: QaPromptWindow;
  usedCues: SubtitleCue[];
}

/** 中文按 0.6 token/字、其余按 0.3 token/字符估算（DeepSeek 官方口径）。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    if (/[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/.test(char)) cjk += 1;
  }
  return Math.ceil(cjk * 0.6 + (text.length - cjk) * 0.3);
}

function formatCueLine(cue: SubtitleCue): string {
  const text = cue.content.replace(/\s+/g, ' ').trim();
  return `[${formatTimestamp(cue.from)}] ${text}`;
}

function pickCues(cues: SubtitleCue[], at: number, windowSec: number): SubtitleCue[] {
  const start = Math.max(0, at - windowSec);
  const end = at + windowSec;
  const nearby = cues.filter(cue => cue.to >= start && cue.from <= end);
  if (nearby.length > 0) return nearby;

  // 时间窗落进字幕空档：退化成前后最接近的几条，避免窗口全空。
  const before = cues.filter(cue => cue.to < start).slice(-3);
  const after = cues.filter(cue => cue.from > end).slice(0, 3);
  return [...before, ...after];
}

function courseLine(input: QaPromptInput): string {
  const parts: string[] = [input.title];
  if (input.partTitle) parts.push(`当前分 P：${input.partTitle}`);
  if (input.pageCount && input.pageCount > 1) parts.push(`共 ${input.pageCount} P`);
  if (input.duration && input.duration > 0) parts.push(`时长 ${formatTimestamp(input.duration)}`);
  return parts.join(' · ');
}

function buildUserText(
  input: QaPromptInput,
  usedCues: SubtitleCue[],
  windowSec: number,
  global: boolean,
): string {
  const lines: string[] = [];
  lines.push(`视频：${courseLine(input)}`);
  lines.push(`当前播放：${formatTimestamp(input.at)}`);

  if (usedCues.length > 0) {
    if (global) {
      lines.push(`全片字幕（抽稀，${usedCues.length} 段，时间不连续）：`);
    } else {
      const first = usedCues[0];
      const last = usedCues[usedCues.length - 1];
      const start = first ? formatTimestamp(first.from) : formatTimestamp(Math.max(0, input.at - windowSec));
      const end = last ? formatTimestamp(last.to) : formatTimestamp(input.at + windowSec);
      lines.push(`附近字幕（${start}–${end}）：`);
    }
    for (const cue of usedCues) lines.push(formatCueLine(cue));
  }

  if (global && input.outline && input.outline.length > 0) {
    lines.push('');
    lines.push('课程大纲：');
    for (const segment of input.outline) {
      lines.push(`- ${formatTimestamp(segment.start)}–${formatTimestamp(segment.end)} ${segment.title}`);
    }
  }

  const turns = Math.max(0, Math.floor(input.historyTurns ?? 0));
  const history = (input.history ?? []).slice(-turns);
  if (history.length > 0) {
    lines.push('');
    lines.push('最近对话：');
    for (const turn of history) {
      lines.push(`Q：${turn.q}`);
      // 每条回答只留前 600 字：追问靠的是指代和结论，不是上一轮的全文。
      lines.push(`A：${turn.a.length > 600 ? `${turn.a.slice(0, 600)}…` : turn.a}`);
    }
  }

  lines.push('');
  lines.push(`问题：${input.question}`);
  return lines.join('\n');
}

/** 全片字幕先按 15 秒合并成行，减少重复短句。 */
function mergeCuesForGlobal(cues: SubtitleCue[]): SubtitleCue[] {
  const merged: SubtitleCue[] = [];
  let bucket = Number.NaN;
  for (const cue of cues) {
    const index = Math.floor(cue.from / 15);
    const last = merged[merged.length - 1];
    if (last && index === bucket) {
      last.to = Math.max(last.to, cue.to);
      last.content = `${last.content} ${cue.content}`.trim();
      continue;
    }
    merged.push({ ...cue });
    bucket = index;
  }
  return merged;
}

/** 超预算时按步长抽稀；首尾都保，定位和收尾都要用。 */
function sampleCues(cues: SubtitleCue[], budgetTokens: number, systemText: string): SubtitleCue[] {
  if (cues.length === 0) return cues;
  const cost = (rows: SubtitleCue[]) =>
    estimateTokens(rows.map(formatCueLine).join('\n')) + estimateTokens(systemText);
  let step = 1;
  let picked = cues;
  while (cost(picked) > budgetTokens && step < cues.length) {
    step *= 2;
    picked = [];
    for (let i = 0; i < cues.length; i += step) picked.push(cues[i]);
    const tail = cues[cues.length - 1];
    if (tail && picked[picked.length - 1] !== tail) picked.push(tail);
  }
  return picked;
}

export function buildQaPrompt(input: QaPromptInput): QaPromptResult {
  const cues = (input.cues ?? [])
    .filter(cue => Number.isFinite(cue.from) && Number.isFinite(cue.to) && cue.content.trim() !== '')
    .sort((a, b) => a.from - b.from);
  const budget = Math.max(500, Math.floor(input.maxInputTokens ?? 3000));
  const baseWindow = Math.max(10, Math.floor(input.windowSec ?? 90));
  const mode = input.mode ?? 'auto';
  const global =
    mode === 'global' || (mode === 'auto' && cues.length > 0 && isGlobalQuestion(input.question));

  const systemParts = [QA_SYSTEM_PROMPT];
  if (cues.length === 0) systemParts.push(QA_NO_SUBTITLE_NOTE);
  if (input.frame) systemParts.push(QA_FRAME_NOTE);
  if (global) systemParts.push(QA_GLOBAL_NOTE);
  const systemText = systemParts.join('\n');

  let windowSec = baseWindow;
  let usedCues: SubtitleCue[];
  let text: string;
  let truncated = false;

  if (global) {
    usedCues = sampleCues(mergeCuesForGlobal(cues), budget, systemText);
    text = buildUserText(input, usedCues, baseWindow, true);
    truncated = usedCues.length < cues.length;
  } else {
    usedCues = pickCues(cues, input.at, windowSec);
    text = buildUserText(input, usedCues, windowSec, false);

    // 超预算：先对称缩窗口（90→60→45→30→20），仍超再从头尾砍字幕行。
    const steps = [60, 45, 30, 20].filter(step => step < baseWindow);
    for (const step of steps) {
      if (estimateTokens(text) + estimateTokens(systemText) <= budget) break;
      windowSec = step;
      usedCues = pickCues(cues, input.at, windowSec);
      text = buildUserText(input, usedCues, windowSec, false);
      truncated = true;
    }

    while (estimateTokens(text) + estimateTokens(systemText) > budget && usedCues.length > 4) {
      // 去掉离播放点最远的一条；at 两侧交替削，保留中间上下文。
      const first = usedCues[0];
      const last = usedCues[usedCues.length - 1];
      if (first && (input.at - first.to >= last.from - input.at || usedCues.length <= 6)) {
        usedCues = usedCues.slice(1);
      } else {
        usedCues = usedCues.slice(0, -1);
      }
      text = buildUserText(input, usedCues, windowSec, false);
      truncated = true;
    }
  }

  const promptTokens = estimateTokens(text) + estimateTokens(systemText);
  const firstUsed = usedCues[0];
  const lastUsed = usedCues[usedCues.length - 1];
  const window: QaPromptWindow = global
    ? {
        start: 0,
        end: lastUsed ? lastUsed.to : (input.duration ?? input.at),
        cues: usedCues.length,
        estimatedInputTokens: promptTokens,
        truncated,
        noSubtitle: cues.length === 0,
      }
    : {
        start: firstUsed ? firstUsed.from : Math.max(0, input.at - windowSec),
        end: lastUsed ? lastUsed.to : input.at + windowSec,
        cues: usedCues.length,
        estimatedInputTokens: promptTokens,
        truncated,
        noSubtitle: cues.length === 0,
      };

  const messages: ChatMessage[] = [{ role: 'system', content: systemText }];
  const turns = Math.max(0, Math.floor(input.historyTurns ?? 0));
  for (const turn of (input.history ?? []).slice(-turns)) {
    messages.push({ role: 'user', content: turn.q });
    messages.push({ role: 'assistant', content: turn.a });
  }
  if (input.frame) {
    // 顺序按协议要求：image 在前、text 在后；detail 固定 high。
    messages.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: input.frame.dataUrl, detail: 'high' } },
        { type: 'text', text },
      ],
    });
  } else {
    messages.push({ role: 'user', content: text });
  }

  return { messages, window, usedCues };
}
