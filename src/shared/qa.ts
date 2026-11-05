/**
 * content ↔ background 的问答协议（D3 切片 1）。
 * 只放类型与常量，不依赖 chrome / DOM，方便 e2e 直接 import 做单测。
 */

export const QA_PORT_NAME = 'vt-qa';
export const QA_PROTOCOL_VERSION = 1;
/** thinking 关闭时的采样温度；thinking 模式下服务端会忽略它。 */
export const QA_TEMPERATURE = 0.3;

export interface QaAskPayload {
  bvid: string;
  aid?: number;
  p: number;
  cid?: number;
  title: string;
  partTitle?: string;
  pageCount?: number;
  duration?: number;
  /** 提问瞬间的视频时间（秒）。 */
  at: number;
  question: string;
}

export type QaClientMessage =
  | { v: 1; type: 'qa:ask'; requestId: string; payload: QaAskPayload }
  | { v: 1; type: 'qa:abort'; requestId: string }
  | { v: 1; type: 'qa:ping'; at: number };

export type QaChunkKind = 'answer' | 'reasoning';

export interface QaUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
}

export const EMPTY_USAGE: QaUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  cacheHitTokens: 0,
  cacheMissTokens: 0,
  reasoningTokens: 0,
};

export interface QaWindowInfo {
  start: number;
  end: number;
  cues: number;
  estimatedInputTokens: number;
  truncated: boolean;
  noSubtitle: boolean;
}

export type QaErrorCode =
  | 'no-key'
  | 'auth'
  | 'balance'
  | 'bad-request'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'timeout'
  | 'empty'
  | 'filtered'
  | 'no-cid'
  | 'disconnected'
  | 'protocol'
  | 'unknown';

export interface QaErrorInfo {
  code: QaErrorCode;
  message: string;
  retryable: boolean;
  status?: number;
  detail?: string;
}

export type QaAbortReason = 'user' | 'superseded' | 'p-changed' | 'tab-closed';

export type QaServerMessage =
  | { v: 1; type: 'qa:start'; requestId: string; model: string; window: QaWindowInfo }
  | { v: 1; type: 'qa:chunk'; requestId: string; kind: QaChunkKind; text: string }
  | {
      v: 1;
      type: 'qa:done';
      requestId: string;
      text: string;
      reasoning: string;
      citations: number[];
      usage: QaUsage;
      finishReason: string;
      elapsedMs: number;
      recordId: string;
    }
  | { v: 1; type: 'qa:error'; requestId: string; error: QaErrorInfo }
  | { v: 1; type: 'qa:aborted'; requestId: string; text: string; reason: QaAbortReason }
  | { v: 1; type: 'qa:pong'; at: number };

/* ---------- DeepSeek Chat Completions 的最小类型 ---------- */

export type ChatRole = 'system' | 'user' | 'assistant';

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' } };

export interface ChatMessage {
  role: ChatRole;
  content: string | ChatContentPart[];
}
