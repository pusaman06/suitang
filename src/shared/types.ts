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
