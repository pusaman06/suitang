import type { SubtitleCue, SubtitleTrack } from './types';

export function normalizeSubtitleUrl(url: string): string {
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return url.replace(/^http:\/\//, 'https://');
  return url;
}

/** 优先中文轨道，其次任意 zh，最后第一条。 */
export function pickTrack(tracks: SubtitleTrack[]): SubtitleTrack | null {
  if (tracks.length === 0) return null;
  return (
    tracks.find(track => track.lan === 'zh-CN') ??
    tracks.find(track => track.lan.toLowerCase().startsWith('zh')) ??
    tracks[0]
  );
}

/**
 * B 站的 AI 字幕地址形如 `/prod/<aid><cid><hash>?auth_key=...`。
 * 实测接口会偶发返回别的视频的地址（内容完全对不上），必须校验前缀；
 * 非 AI 字幕没有这个格式，按可用处理。
 */
export function subtitleUrlMatchesCid(url: string, aid: number, cid: number): boolean {
  const match = url.match(/\/prod\/(\d{19,})/);
  if (!match) return true;
  return match[1].startsWith(`${aid}${cid}`);
}

interface RawSubtitleBody {
  body?: Array<{ from?: unknown; to?: unknown; content?: unknown }>;
}

export function parseSubtitleBody(text: string): SubtitleCue[] {
  const parsed = JSON.parse(text) as RawSubtitleBody;
  const body = Array.isArray(parsed.body) ? parsed.body : [];
  return body
    .filter(
      item =>
        typeof item.from === 'number' &&
        typeof item.to === 'number' &&
        typeof item.content === 'string',
    )
    .map(item => ({
      from: item.from as number,
      to: item.to as number,
      content: (item.content as string).trim(),
    }))
    .filter(item => item.content.length > 0);
}

/** 00:01.2，用于面板里快速核对时间轴。 */
export function formatCueTime(seconds: number): string {
  const totalTenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(totalTenths / 600);
  const secs = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}
