/**
 * 分 P 页面记录在 chrome.storage 里的读写。
 *
 * 历史：这里原本是 D6「本地同步」——把快照推进队列再 PUT 给 companion 落盘。
 * 2026-11-07 收口后落盘链路已停用，只保留 `chrome.storage` 这一层缓存
 * （知识库草稿仍读它拿分 P 快照）。
 *
 * 这里只依赖 chrome.storage（MV3 service worker 原生提供），不引第三方库。
 */
import type { OutlineSegment } from './outline';

export interface CompanionSubtitleSegment {
  from: number;
  to: number;
  text: string;
}

export interface CompanionSubtitle {
  lang: string;
  /** 字幕来源：ASR 转写的时间戳是估算值，底稿里要如实标注。 */
  source: 'bilibili' | 'asr';
  segments: CompanionSubtitleSegment[];
}

export interface CompanionQa {
  at: number;
  q: string;
  a: string;
  citations: number[];
  createdAt: string;
}

export interface CompanionMark {
  at: number;
  note: string;
  createdAt: string;
}

export interface CompanionPage {
  schema: 1;
  bvid: string;
  p: number;
  partTitle?: string;
  pageCount?: number;
  cid?: number;
  aid?: number;
  title?: string;
  owner?: string;
  duration?: number;
  indexedAt?: string;
  subtitle?: CompanionSubtitle;
  outline?: OutlineSegment[];
  qa?: CompanionQa[];
  marks?: CompanionMark[];
  updatedAt: string;
}

export function pageStorageKey(bvid: string, p: number, cid?: number): string {
  return `page:${bvid}:${p}:${cid ?? 'nocid'}`;
}

/** chrome.storage.local 里属于「看视频留下的缓存」的键前缀：问答、字幕、页面记录。 */
export const CACHE_KEY_PREFIXES = ['qa:', 'sub:', 'page:'];

export async function readPageRecord(
  bvid: string,
  p: number,
  cid?: number,
): Promise<CompanionPage | null> {
  const key = pageStorageKey(bvid, p, cid);
  const stored = await chrome.storage.local.get(key);
  const value = stored[key] as CompanionPage | undefined;
  if (!value || value.bvid !== bvid || value.p !== p) return null;
  return value;
}
