/**
 * 问答上下文组装（D3 切片 1：当前时间 ±90 秒字幕 + 课程结构）。
 * 纯函数，不碰 chrome / DOM。
 */

import type { ChatMessage } from './qa';
import type { SubtitleCue } from './types';
import { formatTimestamp } from './citations';

export const QA_SYSTEM_PROMPT = `你是视频学习助手。只依据给定的字幕片段和画面回答。
规则：
1. 先给结论，再解释；中文简洁。
2. 每个来自视频的论断后标 [mm:ss]，时间戳必须取自给定字幕行开头的时间戳。
3. 视频没讲到的内容，另起一行以「补充：」开头。
4. 找不到依据就说「视频里没有讲到」，不要编造。
5. 代码/公式用代码块。`;

/** 无字幕时追加到 system 末尾；用户要求原样保留这段措辞。 */
export const QA_NO_SUBTITLE_NOTE =
  '本视频没有可用字幕。只依据视频标题、分 P 标题和当前时间回答；标题里没有的信息直接说「视频里没讲到」，不要编造台词或内容。';

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

function buildUserText(input: QaPromptInput, usedCues: SubtitleCue[], windowSec: number): string {
  const lines: string[] = [];
  lines.push(`视频：${courseLine(input)}`);
  lines.push(`当前播放：${formatTimestamp(input.at)}`);

  if (usedCues.length > 0) {
    const first = usedCues[0];
    const last = usedCues[usedCues.length - 1];
    const start = first ? formatTimestamp(first.from) : formatTimestamp(Math.max(0, input.at - windowSec));
    const end = last ? formatTimestamp(last.to) : formatTimestamp(input.at + windowSec);
    lines.push(`附近字幕（${start}–${end}）：`);
    for (const cue of usedCues) lines.push(formatCueLine(cue));
  }

  const turns = Math.max(0, Math.floor(input.historyTurns ?? 0));
  const history = (input.history ?? []).slice(-turns);
  if (history.length > 0) {
    lines.push('');
    lines.push('最近对话：');
    for (const turn of history) {
      lines.push(`Q：${turn.q}`);
      lines.push(`A：${turn.a}`);
    }
  }

  lines.push('');
  lines.push(`问题：${input.question}`);
  return lines.join('\n');
}

export function buildQaPrompt(input: QaPromptInput): QaPromptResult {
  const cues = (input.cues ?? [])
    .filter(cue => Number.isFinite(cue.from) && Number.isFinite(cue.to) && cue.content.trim() !== '')
    .sort((a, b) => a.from - b.from);
  const budget = Math.max(500, Math.floor(input.maxInputTokens ?? 3000));
  const baseWindow = Math.max(10, Math.floor(input.windowSec ?? 90));
  const systemText = cues.length === 0 ? `${QA_SYSTEM_PROMPT}\n${QA_NO_SUBTITLE_NOTE}` : QA_SYSTEM_PROMPT;

  let windowSec = baseWindow;
  let usedCues = pickCues(cues, input.at, windowSec);
  let text = buildUserText(input, usedCues, windowSec);
  let truncated = false;

  // 超预算：先对称缩窗口（90→60→45→30→20），仍超再从头尾砍字幕行。
  const steps = [60, 45, 30, 20].filter(step => step < baseWindow);
  for (const step of steps) {
    if (estimateTokens(text) + estimateTokens(systemText) <= budget) break;
    windowSec = step;
    usedCues = pickCues(cues, input.at, windowSec);
    text = buildUserText(input, usedCues, windowSec);
    truncated = true;
  }

  const promptTokens = () => estimateTokens(text) + estimateTokens(systemText);
  while (promptTokens() > budget && usedCues.length > 4) {
    // 去掉离播放点最远的一条；at 两侧交替削，保留中间上下文。
    const first = usedCues[0];
    const last = usedCues[usedCues.length - 1];
    if (first && (input.at - first.to >= last.from - input.at || usedCues.length <= 6)) {
      usedCues = usedCues.slice(1);
    } else {
      usedCues = usedCues.slice(0, -1);
    }
    text = buildUserText(input, usedCues, windowSec);
    truncated = true;
  }

  const firstUsed = usedCues[0];
  const lastUsed = usedCues[usedCues.length - 1];
  const window: QaPromptWindow = {
    start: firstUsed ? firstUsed.from : Math.max(0, input.at - windowSec),
    end: lastUsed ? lastUsed.to : input.at + windowSec,
    cues: usedCues.length,
    estimatedInputTokens: promptTokens(),
    truncated,
    noSubtitle: cues.length === 0,
  };

  const messages: ChatMessage[] = [{ role: 'system', content: systemText }];
  const turns = Math.max(0, Math.floor(input.historyTurns ?? 0));
  for (const turn of (input.history ?? []).slice(-turns)) {
    messages.push({ role: 'user', content: turn.q });
    messages.push({ role: 'assistant', content: turn.a });
  }
  messages.push({ role: 'user', content: text });

  return { messages, window, usedCues };
}
