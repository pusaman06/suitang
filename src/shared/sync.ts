/**
 * D6 本地同步：把课程/分 P 快照写进 chrome.storage 队列，再 PUT 给 companion。
 *
 * 这里只依赖 chrome.storage / fetch（MV3 service worker 原生提供），不引第三方库。
 * `buildCoursePayload` / `buildPagePayload` 是纯函数，e2e 可直接断言落盘结构。
 */
import type { OutlineSegment } from './outline';
import type { SubtitleCue, VideoMeta } from './types';
import { loadSettings } from './settings';

export const SYNC_QUEUE_KEY = 'sync:queue';
export const SYNC_FAILED_KEY = 'sync:failed';
export const SYNC_LAST_ERROR_KEY = 'sync:lastError';
export const SYNC_ALARM_NAME = 'sync-flush';
export const SYNC_MAX_ATTEMPTS = 3;
export const SYNC_FLUSH_LIMIT = 20;
export const SYNC_FAILED_LIMIT = 20;
export const SYNC_TIMEOUT_MS = 2000;

export type SyncKind = 'course' | 'page';

export interface CompanionCoursePage {
  p: number;
  cid: number;
  part: string;
  duration: number;
}

export interface CompanionCourse {
  schema: 1;
  bvid: string;
  title: string;
  owner?: string;
  pageCount: number;
  pages: CompanionCoursePage[];
  updatedAt: string;
}

export interface CompanionSubtitleSegment {
  from: number;
  to: number;
  text: string;
}

export interface CompanionSubtitle {
  lang: string;
  source: 'bilibili';
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

export type SyncPayload = CompanionCourse | CompanionPage;

export interface SyncQueueItem {
  id: string;
  kind: SyncKind;
  bvid: string;
  p?: number;
  payload: SyncPayload;
  attempts: number;
  queuedAt: number;
  lastError?: string;
}

export interface SyncFailedItem extends SyncQueueItem {
  failedAt: number;
}

export interface SyncStatus {
  enabled: boolean;
  url: string;
  pending: number;
  failed: number;
  lastError?: string;
}

export interface PagePayloadInput {
  bvid: string;
  p: number;
  cid?: number;
  aid?: number;
  title?: string;
  partTitle?: string;
  pageCount?: number;
  owner?: string;
  duration?: number;
  cues?: SubtitleCue[];
  subtitleLang?: string;
  subtitle?: CompanionSubtitle;
  outline?: OutlineSegment[];
  qa?: CompanionQa[];
  marks?: CompanionMark[];
  indexedAt?: string;
}

export function pageStorageKey(bvid: string, p: number, cid?: number): string {
  return `page:${bvid}:${p}:${cid ?? 'nocid'}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : undefined;
}

export function buildCoursePayload(meta: VideoMeta): CompanionCourse {
  const pages = meta.pages.map(page => ({
    p: page.page,
    cid: page.cid,
    part: page.part,
    duration: page.duration,
  }));
  const course: CompanionCourse = {
    schema: 1,
    bvid: meta.bvid,
    title: meta.title,
    pageCount: pages.length,
    pages,
    updatedAt: nowIso(),
  };
  const owner = nonEmpty(meta.owner);
  if (owner) course.owner = owner;
  return course;
}

export function buildPagePayload(input: PagePayloadInput): CompanionPage {
  const page: CompanionPage = {
    schema: 1,
    bvid: input.bvid,
    p: input.p,
    indexedAt: input.indexedAt ?? nowIso(),
    updatedAt: nowIso(),
  };

  const partTitle = nonEmpty(input.partTitle);
  const title = nonEmpty(input.title);
  const owner = nonEmpty(input.owner);
  if (partTitle) page.partTitle = partTitle;
  if (title) page.title = title;
  if (owner) page.owner = owner;

  const pageCount = positiveNumber(input.pageCount);
  const cid = positiveNumber(input.cid);
  const aid = positiveNumber(input.aid);
  const duration = positiveNumber(input.duration);
  if (pageCount) page.pageCount = Math.floor(pageCount);
  if (cid) page.cid = Math.floor(cid);
  if (aid) page.aid = Math.floor(aid);
  if (duration) page.duration = duration;

  if (input.subtitle) {
    page.subtitle = input.subtitle;
  } else if (input.cues && input.cues.length > 0) {
    page.subtitle = {
      lang: nonEmpty(input.subtitleLang) ?? 'unknown',
      source: 'bilibili',
      segments: input.cues.map(cue => ({
        from: cue.from,
        to: cue.to,
        text: cue.content,
      })),
    };
  }

  if (input.outline && input.outline.length > 0) page.outline = input.outline;
  if (input.qa && input.qa.length > 0) page.qa = input.qa;
  if (input.marks && input.marks.length > 0) page.marks = input.marks;
  return page;
}

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

export async function writePageRecord(page: CompanionPage): Promise<void> {
  await chrome.storage.local.set({ [pageStorageKey(page.bvid, page.p, page.cid)]: page });
}

function queueIdentity(kind: SyncKind, bvid: string, p?: number): string {
  return `${kind}:${bvid}:${p ?? ''}`;
}

function newId(): string {
  return `s${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isQueueItem(value: unknown): value is SyncQueueItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<SyncQueueItem>;
  return (
    typeof item.id === 'string' &&
    (item.kind === 'course' || item.kind === 'page') &&
    typeof item.bvid === 'string' &&
    (item.kind === 'course' || Number.isInteger(item.p))
  );
}

async function readQueue(): Promise<SyncQueueItem[]> {
  const stored = await chrome.storage.local.get(SYNC_QUEUE_KEY);
  const value = stored[SYNC_QUEUE_KEY];
  return Array.isArray(value) ? value.filter(isQueueItem) : [];
}

async function writeQueue(queue: SyncQueueItem[]): Promise<void> {
  await chrome.storage.local.set({ [SYNC_QUEUE_KEY]: queue });
}

async function readFailed(): Promise<SyncFailedItem[]> {
  const stored = await chrome.storage.local.get(SYNC_FAILED_KEY);
  const value = stored[SYNC_FAILED_KEY];
  return Array.isArray(value) ? (value.filter(isQueueItem) as SyncFailedItem[]) : [];
}

async function writeFailed(items: SyncFailedItem[]): Promise<void> {
  await chrome.storage.local.set({ [SYNC_FAILED_KEY]: items.slice(0, SYNC_FAILED_LIMIT) });
}

async function readLastError(): Promise<string | undefined> {
  const stored = await chrome.storage.local.get(SYNC_LAST_ERROR_KEY);
  const value = stored[SYNC_LAST_ERROR_KEY];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

async function setLastError(message: string): Promise<void> {
  await chrome.storage.local.set({ [SYNC_LAST_ERROR_KEY]: message });
}

async function clearLastError(): Promise<void> {
  await chrome.storage.local.remove(SYNC_LAST_ERROR_KEY);
}

/** 串行化 storage 读改写，避免问答/大纲/课程同时入队丢条目。 */
let queueLock: Promise<unknown> = Promise.resolve();
function withQueueLock<T>(task: () => Promise<T>): Promise<T> {
  const run = queueLock.then(task, task);
  queueLock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export interface EnqueueSyncInput {
  kind: SyncKind;
  bvid: string;
  p?: number;
  payload: SyncPayload;
}

/** 入队并去重；syncEnabled=false 时不接新任务。返回是否真的入队。 */
export async function enqueueSync(input: EnqueueSyncInput): Promise<boolean> {
  const settings = await loadSettings();
  if (!settings.syncEnabled) return false;
  if (input.kind === 'page' && !Number.isInteger(input.p)) return false;

  await withQueueLock(async () => {
    const queue = await readQueue();
    const identity = queueIdentity(input.kind, input.bvid, input.p);
    const next: SyncQueueItem = {
      id: newId(),
      kind: input.kind,
      bvid: input.bvid,
      p: input.p,
      payload: input.payload,
      attempts: 0,
      queuedAt: Date.now(),
    };
    const index = queue.findIndex(item => queueIdentity(item.kind, item.bvid, item.p) === identity);
    if (index >= 0) queue[index] = next;
    else queue.push(next);
    await writeQueue(queue);
  });
  return true;
}

function endpointFor(baseUrl: string, item: SyncQueueItem): string {
  const base = baseUrl.replace(/\/+$/, '');
  const bvid = encodeURIComponent(item.bvid);
  return item.kind === 'course'
    ? `${base}/api/videos/${bvid}`
    : `${base}/api/videos/${bvid}/p/${item.p}`;
}

async function putItem(baseUrl: string, item: SyncQueueItem): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetch(endpointFor(baseUrl, item), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item.payload),
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error('companion 请求超时');
      throw error;
    }
    if (!response.ok) {
      let detail = '';
      try {
        const text = await response.text();
        if (text.trim() !== '') detail = `：${text.slice(0, 200)}`;
      } catch {
        // 忽略读错误响应体失败。
      }
      throw new Error(`companion HTTP ${response.status}${detail}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function removeQueueItem(id: string): Promise<void> {
  await withQueueLock(async () => {
    const queue = await readQueue();
    const next = queue.filter(item => item.id !== id);
    if (next.length !== queue.length) await writeQueue(next);
  });
}

async function failQueueItem(item: SyncQueueItem, message: string): Promise<void> {
  await withQueueLock(async () => {
    const queue = await readQueue();
    const current = queue.find(entry => entry.id === item.id);
    if (!current) return;
    const attempts = current.attempts + 1;
    if (attempts >= SYNC_MAX_ATTEMPTS) {
      const next = queue.filter(entry => entry.id !== item.id);
      await writeQueue(next);
      const failed = await readFailed();
      await writeFailed([
        { ...current, attempts, lastError: message, failedAt: Date.now() },
        ...failed,
      ]);
      return;
    }
    current.attempts = attempts;
    current.lastError = message;
    await writeQueue(queue);
  });
  await setLastError(message);
}

async function cleanLastErrorIfEmpty(): Promise<void> {
  const [queue, failed] = await Promise.all([readQueue(), readFailed()]);
  if (queue.length === 0 && failed.length === 0) await clearLastError();
}

export async function getSyncStatus(): Promise<SyncStatus> {
  const settings = await loadSettings();
  const [queue, failed, lastError] = await Promise.all([readQueue(), readFailed(), readLastError()]);
  const status: SyncStatus = {
    enabled: settings.syncEnabled,
    url: settings.companionUrl,
    pending: queue.length,
    failed: failed.length,
  };
  if (lastError) status.lastError = lastError;
  return status;
}

let flushPromise: Promise<SyncStatus> | null = null;

/** 每次最多 20 条，逐条 PUT；失败累计 3 次移入 sync:failed。 */
export function flushQueue(): Promise<SyncStatus> {
  if (flushPromise) return flushPromise;
  flushPromise = doFlush().finally(() => {
    flushPromise = null;
  });
  return flushPromise;
}

async function doFlush(): Promise<SyncStatus> {
  const settings = await loadSettings();
  if (!settings.syncEnabled) return getSyncStatus();

  const queue = await withQueueLock(readQueue);
  const batch = queue.slice(0, SYNC_FLUSH_LIMIT);
  let failures = 0;

  for (const item of batch) {
    try {
      await putItem(settings.companionUrl, item);
      await removeQueueItem(item.id);
    } catch (error) {
      failures += 1;
      await failQueueItem(item, error instanceof Error ? error.message : String(error));
    }
  }

  if (failures === 0) await cleanLastErrorIfEmpty();
  return getSyncStatus();
}

/** 入队后立即尝试一次；调用方通常 `void enqueueAndFlush(...)`，不阻塞问答。 */
export async function enqueueAndFlush(input: EnqueueSyncInput): Promise<void> {
  const queued = await enqueueSync(input);
  if (queued) void flushQueue().catch(() => undefined);
}
