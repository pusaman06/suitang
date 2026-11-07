import type { SubtitleCue, SubtitleTrack } from './types';

export function normalizeSubtitleUrl(url: string): string {
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('http://')) return url.replace(/^http:\/\//, 'https://');
  return url;
}

/**
 * 只认中文字幕。
 *
 * B 站会给一部分视频生成「翻译成其它语言」的 AI 字幕轨道：一个中文视频可能
 * 只有一条 `ja` 轨道（内容是中文原话的日文翻译）。这种轨道对我们没用——拿它
 * 生成的大纲和底稿全是日文。所以没有中文轨道就当「没有字幕」，交给 ASR 出中文。
 */
export function pickTrack(tracks: SubtitleTrack[], allowAnyLanguage = false): SubtitleTrack | null {
  const zh =
    tracks.find(track => track.lan.toLowerCase() === 'zh-cn') ??
    tracks.find(track => track.lan.toLowerCase().startsWith('zh')) ??
    // B 站自动生成的中文轨 lan 是 `ai-zh`，不是 `zh-CN`；不带这条判断会把
    // 「有中文字幕」误判成没字幕，白白掉到转写或抽帧去。
    tracks.find(track => /(^|-)zh(-|$)/i.test(track.lan)) ??
    null;
  if (zh) return zh;
  // 设置页的「测试字幕」只验证链路通不通，抓什么语言都算成功。
  return allowAnyLanguage ? (tracks[0] ?? null) : null;
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

/**
 * 「♪ 音乐 ♪」「[掌声]」这类占位不是可用内容：B 站 AI 字幕对纯音乐/无语音段会这么标，
 * 拿它切段模型只能胡编，最后报「模型输出格式不对」。
 */
const MUSIC_PLACEHOLDER_RE =
  /^(音乐|music|bgm|applause|掌声|笑声|silence|backgroundmusic|音乐声)$/i;

export function hasMeaningfulCueText(text: string): boolean {
  const cleaned = text
    .replace(/[♪♫♬♩🎵🎶]/gu, ' ')
    .replace(/[\[【(（][^\]】)）]*[\]】)）]/g, ' ')
    .trim();
  if (cleaned === '') return false;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return false;
  return !MUSIC_PLACEHOLDER_RE.test(cleaned.replace(/\s+/g, ''));
}

/** 00:01.2，用于面板里快速核对时间轴。 */
export function formatCueTime(seconds: number): string {
  const totalTenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = Math.floor(totalTenths / 600);
  const secs = Math.floor((totalTenths % 600) / 10);
  const tenths = totalTenths % 10;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths}`;
}
