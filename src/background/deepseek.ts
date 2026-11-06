/**
 * DeepSeek Chat Completions 流式调用（D3 切片 1）。
 * 只负责发请求、解 SSE、把错误归一成 QaErrorCode；不碰 storage / port。
 */

import type { ChatMessage, QaErrorInfo, QaUsage } from '../shared/qa';
import { EMPTY_USAGE } from '../shared/qa';

/** 连接 + 整体上限；空闲上限在每次收到字节时重置。 */
// 长字幕（三万字符）首 token 可能等一分钟以上，idle 放宽到 120 秒；
// 总时长给到 5 分钟，否则 52 分钟的视频切不出大纲。
export const DEEPSEEK_TOTAL_TIMEOUT_MS = 300_000;
export const DEEPSEEK_IDLE_TIMEOUT_MS = 120_000;

export class QaError extends Error {
  readonly info: QaErrorInfo;

  constructor(info: QaErrorInfo) {
    super(info.message);
    this.name = 'QaError';
    this.info = info;
  }
}

/** 用户主动取消 / 被新请求顶掉，不算错误。 */
export class QaAbortError extends Error {
  constructor(readonly reason: string) {
    super(`aborted: ${reason}`);
    this.name = 'QaAbortError';
  }
}

export interface DeepSeekRequest {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  thinking: boolean;
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
  onChunk: (kind: 'answer' | 'reasoning', text: string) => void;
  onUsage?: (usage: QaUsage) => void;
}

export interface DeepSeekResult {
  text: string;
  reasoning: string;
  usage: QaUsage;
  finishReason: string;
}

interface StreamChoice {
  delta?: { content?: string | null; reasoning_content?: string | null };
  message?: { content?: string | null };
  finish_reason?: string | null;
}

interface StreamPayload {
  choices?: StreamChoice[];
  usage?: Record<string, unknown> | null;
  error?: { message?: string; type?: string; code?: string | number } | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function numberField(source: Record<string, unknown> | null | undefined, key: string): number {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** 字段不存在时返回 undefined，方便做「顶层优先、details 兜底」的链式读取。 */
function optionalNumber(
  source: Record<string, unknown> | null | undefined,
  key: string,
): number | undefined {
  const value = source?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readUsage(raw: unknown): QaUsage | null {
  const usage = asRecord(raw);
  if (!usage) return null;
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const completionDetails = asRecord(usage.completion_tokens_details);
  return {
    promptTokens: numberField(usage, 'prompt_tokens'),
    completionTokens: numberField(usage, 'completion_tokens'),
    totalTokens: numberField(usage, 'total_tokens'),
    // 官方文档：cache 命中/未命中在 usage 顶层；prompt_tokens_details 里是等义的 cached_tokens。
    cacheHitTokens:
      optionalNumber(usage, 'prompt_cache_hit_tokens') ??
      optionalNumber(promptDetails, 'cached_tokens') ??
      0,
    cacheMissTokens: optionalNumber(usage, 'prompt_cache_miss_tokens') ?? 0,
    reasoningTokens: numberField(completionDetails, 'reasoning_tokens'),
  };
}

function messageOf(body: unknown): string {
  const record = asRecord(body);
  const error = asRecord(record?.error);
  const message = error?.message ?? record?.message ?? record?.detail;
  return typeof message === 'string' ? message.slice(0, 400) : '';
}

export function errorFromStatus(status: number, body: unknown): QaErrorInfo {
  const detail = messageOf(body);
  const base = { status, detail };
  switch (status) {
    case 400:
      return { code: 'bad-request', message: '请求参数被拒绝（400）', retryable: false, ...base };
    case 401:
      return { code: 'auth', message: 'API Key 无效或已失效（401），请到设置页检查', retryable: false, ...base };
    case 402:
      return { code: 'balance', message: 'DeepSeek 账户余额不足（402）', retryable: false, ...base };
    case 422:
      return { code: 'bad-request', message: '请求参数不合法（422）', retryable: false, ...base };
    case 429:
      return { code: 'rate-limit', message: '请求太频繁或被限流（429），稍后重试', retryable: true, ...base };
    default:
      if (status >= 500) {
        return { code: 'server', message: `DeepSeek 服务异常（${status}），稍后重试`, retryable: true, ...base };
      }
      return { code: 'unknown', message: `请求失败（${status}）`, retryable: false, ...base };
  }
}

function buildBody(request: DeepSeekRequest, includeUsage: boolean): string {
  const body: Record<string, unknown> = {
    model: request.model,
    messages: request.messages,
    stream: true,
    max_tokens: request.maxTokens,
    thinking: { type: request.thinking ? 'enabled' : 'disabled' },
  };
  // thinking 模式下 temperature 无效，干脆不发，避免误解。
  if (!request.thinking) body.temperature = request.temperature;
  if (includeUsage) body.stream_options = { include_usage: true };
  return JSON.stringify(body);
}

/**
 * 一次 SSE 读取。onChunk 在本函数内同步调用。
 * 返回累积文本；错误抛 QaError / QaAbortError。
 */
async function streamOnce(
  request: DeepSeekRequest,
  includeUsage: boolean,
  controller: AbortController,
  touch: () => void,
): Promise<DeepSeekResult> {
  const url = `${request.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${request.apiKey}`,
      },
      body: buildBody(request, includeUsage),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw error;
    throw new QaError({
      code: 'network',
      message: '连不上 DeepSeek，请检查网络或 API 地址',
      retryable: true,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  if (!response.ok) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      try {
        body = await response.text();
      } catch {
        body = null;
      }
    }
    throw new QaError(errorFromStatus(response.status, body));
  }

  if (!response.body) {
    throw new QaError({ code: 'network', message: '响应没有可读的流', retryable: true });
  }
  // 响应头到达也算有动静，重置空闲计时（连接阶段不单独设超时）。
  touch();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let reasoning = '';
  let usage: QaUsage = { ...EMPTY_USAGE };
  let finishReason = '';

  const handleLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith(':')) return false;
    if (!trimmed.startsWith('data:')) return false;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return true;

    let payload: StreamPayload;
    try {
      payload = JSON.parse(data) as StreamPayload;
    } catch {
      // 半行 JSON 或服务端心跳，丢弃即可。
      return false;
    }

    if (payload.error) {
      throw new QaError({
        code: 'server',
        message: payload.error.message ?? 'DeepSeek 返回了错误',
        retryable: true,
      });
    }

    const nextUsage = readUsage(payload.usage);
    if (nextUsage) {
      usage = nextUsage;
      request.onUsage?.(usage);
    }

    const choice = payload.choices?.[0];
    if (!choice) return false;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta;
    const answer = delta?.content ?? choice.message?.content ?? '';
    if (answer) {
      text += answer;
      request.onChunk('answer', answer);
    }
    const thought = delta?.reasoning_content ?? '';
    if (thought) {
      reasoning += thought;
      request.onChunk('reasoning', thought);
    }
    return false;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    touch();
    buffer += decoder.decode(value, { stream: true });
    // SSE 事件以空行分隔，但逐行处理更宽容（有的代理只发 \n）。
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (handleLine(line)) {
        return { text, reasoning, usage, finishReason };
      }
      newline = buffer.indexOf('\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.trim() !== '' && handleLine(buffer)) {
    return { text, reasoning, usage, finishReason };
  }

  return { text, reasoning, usage, finishReason };
}

/** 空回答 + 明确的结束原因时，给出比「模型没有返回内容」更准的文案。 */
function assertFinishReason(result: DeepSeekResult): DeepSeekResult {
  if (result.text.trim() !== '') return result;
  if (result.finishReason === 'content_filter') {
    throw new QaError({
      code: 'filtered',
      message: '回答被内容安全策略拦截了，换个问法试试',
      retryable: false,
    });
  }
  if (result.finishReason === 'insufficient_system_resource') {
    throw new QaError({
      code: 'server',
      message: 'DeepSeek 算力紧张，这次没生成出内容，稍后重试',
      retryable: true,
    });
  }
  return result;
}

export async function callDeepSeek(request: DeepSeekRequest): Promise<DeepSeekResult> {
  const controller = new AbortController();
  let timeoutKind: 'idle' | 'total' | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // 空闲计时：收到任意字节（含响应头）就重置；连接阶段也受它保护。
  const touch = () => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (timeoutKind === null) timeoutKind = 'idle';
      controller.abort();
    }, DEEPSEEK_IDLE_TIMEOUT_MS);
  };
  touch();

  const totalTimer = setTimeout(() => {
    if (timeoutKind === null) timeoutKind = 'total';
    controller.abort();
  }, DEEPSEEK_TOTAL_TIMEOUT_MS);

  const external = request.signal;
  const forwardAbort = () => controller.abort();
  if (external) {
    if (external.aborted) controller.abort();
    else external.addEventListener('abort', forwardAbort, { once: true });
  }

  try {
    try {
      return assertFinishReason(await streamOnce(request, true, controller, touch));
    } catch (error) {
      if (error instanceof QaError && error.info.status === 400 && /stream_options/i.test(error.info.detail ?? '')) {
        // 某些代理不认 stream_options，去掉重试一次。
        return assertFinishReason(await streamOnce(request, false, controller, touch));
      }
      throw error;
    }
  } catch (error) {
    if (timeoutKind === 'idle') {
      throw new QaError({ code: 'timeout', message: '45 秒没有收到新内容，请重试', retryable: true });
    }
    if (timeoutKind === 'total') {
      throw new QaError({ code: 'timeout', message: '超过 180 秒没有完成，请重试', retryable: true });
    }
    if (external?.aborted) throw new QaAbortError('user');
    if (controller.signal.aborted) throw new QaAbortError('aborted');
    if (error instanceof QaError) throw error;
    throw new QaError({
      code: 'unknown',
      message: error instanceof Error ? error.message : '未知错误',
      retryable: true,
    });
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    external?.removeEventListener('abort', forwardAbort);
  }
}
