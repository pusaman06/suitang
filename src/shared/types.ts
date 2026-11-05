export interface VideoPage {
  page: number;
  cid: number;
  part: string;
  duration: number;
}

export interface VideoMeta {
  bvid: string;
  aid?: number;
  title: string;
  owner?: string;
  duration?: number;
  pages: VideoPage[];
}

export interface VideoInfo {
  bvid: string;
  aid?: number;
  p: number;
  cid?: number;
  title: string;
  partTitle?: string;
  owner?: string;
  duration?: number;
  pageCount?: number;
}

export interface SubtitleTrack {
  lan: string;
  lan_doc: string;
  subtitle_url: string;
}

export interface SubtitleCue {
  from: number;
  to: number;
  content: string;
}

export interface SubtitleCache {
  bvid: string;
  p: number;
  cid: number;
  fetchedAt: number;
  track: SubtitleTrack;
  total: number;
  cues: SubtitleCue[];
}

export interface SubtitleResult {
  ok: boolean;
  cached?: boolean;
  track?: SubtitleTrack;
  total?: number;
  cues?: SubtitleCue[];
  needLogin?: boolean;
  error?: string;
}
