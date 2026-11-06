/**
 * 课程 / 分 P 快照在 chrome.storage 里的读写。
 *
 * 历史：这里原本是 D6「本地同步」——把快照推进队列再 PUT 给 companion，由 companion 落盘到
 * `data/videos/`。2026-11-06 起落盘并入知识库（见 `docs/decisions-storage.md`），
 * 队列 / 重试 / 失败列表整条路子取消，只保留 `chrome.storage` 这一层缓存。
 *
 * 这里只依赖 chrome.storage（MV3 service worker 原生提供），不引第三方库。
 * `buildCoursePayload` / `buildPagePayload` 是纯函数，e2e 可直接断言结构。
 */
import type { OutlineSegment } from './outline';
import type { SubtitleCue, VideoMeta } from './types';

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
  /** 上面 cues 的来源；不传按官方字幕处理。 */
  subtitleSource?: CompanionSubtitle['source'];
  subtitle?: CompanionSubtitle;
  outline?: OutlineSegment[];
  qa?: CompanionQa[];
  marks?: CompanionMark[];
  indexedAt?: string;
}

export function pageStorageKey(bvid: string, p: number, cid?: number): string {
  return `page:${bvid}:${p}:${cid ?? 'nocid'}`;
}

/** chrome.storage.local 里属于「看视频留下的缓存」的键前缀：问答、字幕、页面记录。 */
export const CACHE_KEY_PREFIXES = ['qa:', 'sub:', 'page:'];

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
      source: input.subtitleSource ?? 'bilibili',
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
