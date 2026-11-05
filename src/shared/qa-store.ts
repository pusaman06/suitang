/**
 * 问答记录持久化（D3 切片 2）。
 *
 * key 用 `qa:<bvid>:<p>`，**不带 cid**：同一 P 换清晰度 / 换合集来源时 cid 会变，
 * 但用户眼里还是「这一 P 的问答」，记录不该丢。
 * 一个 P 最多留 QA_MAX_RECORDS 条，超出丢最旧的。
 */

import { EMPTY_USAGE, type QaUsage } from './qa';

export const QA_SCHEMA = 1;
export const QA_MAX_RECORDS = 100;

export interface QaRecord {
  id: string;
  /** 提问瞬间的视频时间（秒）。 */
  at: number;
  question: string;
  answer: string;
  /** 回答里出现的引用时间戳（秒）。 */
  citations: number[];
  createdAt: number;
  model: string;
  usage: QaUsage;
}

export interface QaStore {
  schema: number;
  bvid: string;
  p: number;
  records: QaRecord[];
  updatedAt: number;
}

export function qaStorageKey(bvid: string, p: number): string {
  return `qa:${bvid}:${p}`;
}

export function newQaRecordId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyQaStore(bvid: string, p: number): QaStore {
  return { schema: QA_SCHEMA, bvid, p, records: [], updatedAt: 0 };
}

function normalizeUsage(value: unknown): QaUsage {
  if (!value || typeof value !== 'object') return { ...EMPTY_USAGE };
  const raw = value as Partial<QaUsage>;
  const num = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) && input >= 0 ? Math.round(input) : 0;
  return {
    promptTokens: num(raw.promptTokens),
    completionTokens: num(raw.completionTokens),
    totalTokens: num(raw.totalTokens),
    cacheHitTokens: num(raw.cacheHitTokens),
    cacheMissTokens: num(raw.cacheMissTokens),
    reasoningTokens: num(raw.reasoningTokens),
  };
}

function normalizeRecord(value: unknown): QaRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<QaRecord>;
  const question = typeof raw.question === 'string' ? raw.question.trim() : '';
  const answer = typeof raw.answer === 'string' ? raw.answer : '';
  if (question === '' || answer.trim() === '') return null;
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : newQaRecordId(),
    at: typeof raw.at === 'number' && Number.isFinite(raw.at) ? Math.max(0, raw.at) : 0,
    question,
    answer,
    citations: Array.isArray(raw.citations)
      ? raw.citations.filter((item): item is number => typeof item === 'number' && Number.isFinite(item) && item >= 0)
      : [],
    createdAt: typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    model: typeof raw.model === 'string' ? raw.model : '',
    usage: normalizeUsage(raw.usage),
  };
}

/** 读记录；损坏或版本不认识时当作空，不抛错（历史丢了也不能影响问答）。 */
export async function readQaStore(bvid: string, p: number): Promise<QaStore> {
  const key = qaStorageKey(bvid, p);
  const stored = await chrome.storage.local.get(key);
  const raw = stored[key] as Partial<QaStore> | undefined;
  if (!raw || raw.schema !== QA_SCHEMA || !Array.isArray(raw.records)) {
    return emptyQaStore(bvid, p);
  }
  const records = raw.records
    .map(normalizeRecord)
    .filter((item): item is QaRecord => item !== null)
    .slice(-QA_MAX_RECORDS);
  return {
    schema: QA_SCHEMA,
    bvid,
    p,
    records,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  };
}

export interface QaRecordInput {
  at: number;
  question: string;
  answer: string;
  citations: number[];
  model: string;
  usage: QaUsage;
}

/** 追加一条并裁剪；返回写入后的记录（带 id）。 */
export async function appendQaRecord(
  bvid: string,
  p: number,
  input: QaRecordInput,
): Promise<QaRecord> {
  const store = await readQaStore(bvid, p);
  const record: QaRecord = {
    id: newQaRecordId(),
    at: input.at,
    question: input.question,
    answer: input.answer,
    citations: input.citations,
    createdAt: Date.now(),
    model: input.model,
    usage: normalizeUsage(input.usage),
  };
  const records = [...store.records, record].slice(-QA_MAX_RECORDS);
  await chrome.storage.local.set({
    [qaStorageKey(bvid, p)]: { ...store, records, updatedAt: Date.now() },
  });
  return record;
}

export async function clearQaStore(bvid: string, p: number): Promise<void> {
  await chrome.storage.local.remove(qaStorageKey(bvid, p));
}
