/**
 * 回答里 [mm:ss] 引用的解析与渲染。
 * 纯函数，不碰 chrome / DOM，e2e 可以直接 import 做单测。
 */

export interface CitationToken {
  /** 原文，例如 "[12:30]"。 */
  raw: string;
  seconds: number;
  start: number;
  end: number;
  /** 是否落在视频时长内（duration 未知时一律 true）。 */
  valid: boolean;
}

/**
 * 模型可能输出全角括号/全角冒号；秒必须两位且 ≤59，
 * 这样 [02:99] 之类的幻觉不会被当成时间戳。
 */
export const CITATION_RE =
  /(?:\[|［|【)\s*(\d{1,3})\s*[:：]\s*([0-5]\d)(?:\s*[:：]\s*([0-5]\d))?\s*(?:\]|］|】)/g;

export function parseCitations(text: string, duration?: number): CitationToken[] {
  const tokens: CitationToken[] = [];
  for (const match of text.matchAll(CITATION_RE)) {
    const raw = match[0];
    const index = match.index ?? 0;
    const first = Number(match[1] ?? 0);
    const second = Number(match[2] ?? 0);
    const third: string | undefined = match[3];
    // [mm:ss] 或 [hh:mm:ss]；第三段存在时第一段是小时。
    const seconds = third === undefined ? first * 60 + second : first * 3600 + second * 60 + Number(third);
    tokens.push({
      raw,
      seconds,
      start: index,
      end: index + raw.length,
      valid: duration === undefined || duration <= 0 ? true : seconds <= duration + 2,
    });
  }
  return tokens;
}

/** 去重升序，只保留落在时长内的引用（duration 未知时全留）。 */
export function extractCitationSeconds(text: string, duration?: number): number[] {
  const unique = new Set<number>();
  for (const token of parseCitations(text, duration)) {
    if (token.valid) unique.add(token.seconds);
  }
  return [...unique].sort((a, b) => a - b);
}

/** "02:03"；超过 99 分钟时分钟位自然变宽（62:03）。 */
export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function clampSeconds(seconds: number, duration?: number): number {
  const value = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  if (duration === undefined || duration <= 0 || !Number.isFinite(duration)) return value;
  return Math.min(value, Math.max(0, duration - 0.1));
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char] ?? char);
}

function linkify(escaped: string, duration?: number): string {
  return escaped.replace(CITATION_RE, (raw: string) => {
    // 用捕获组重算，避免直接信任 raw 里的数字；时长外的引用只留灰字。
    const token = parseCitations(raw, duration)[0];
    if (!token || !token.valid) {
      return `<span class="vt-cite vt-cite-off">${raw}</span>`;
    }
    return `<a class="vt-cite" data-t="${token.seconds}" role="link" tabindex="0">${raw}</a>`;
  });
}

function inline(escaped: string, duration?: number): string {
  return linkify(escaped, duration)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
}

function renderProse(raw: string, duration?: number): string {
  const out: string[] = [];
  let paragraph: string[] = [];
  let listOpen = false;

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flushParagraph();
      closeList();
      continue;
    }
    const listItem = trimmed.match(/^[-*]\s+(.*)$/);
    if (listItem) {
      flushParagraph();
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${inline(escapeHtml(listItem[1] ?? ''), duration)}</li>`);
      continue;
    }
    closeList();
    paragraph.push(inline(escapeHtml(trimmed), duration));
  }
  flushParagraph();
  closeList();
  return out.join('');
}

/**
 * 极简 markdown：代码块 / 行内代码 / 粗体 / 无序列表 / 段落。
 * 先转义再插标签，模型输出里的 HTML 不会被执行。
 * 未闭合的代码块按代码渲染，流式过程中不会闪成裸 ```。
 */
export function renderAnswerHtml(text: string, duration?: number): string {
  const segments = text.split('```');
  return segments
    .map((segment, index) => {
      if (index % 2 === 0) return renderProse(segment, duration);
      const newline = segment.indexOf('\n');
      const code = newline >= 0 ? segment.slice(newline + 1) : '';
      return `<pre class="vt-code"><code>${escapeHtml(code)}</code></pre>`;
    })
    .join('');
}
