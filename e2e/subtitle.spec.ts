import { expect, test } from '@playwright/test';
import type { BrowserContext, Page } from '@playwright/test';
import { resolve } from 'node:path';
import {
  VIDEO_URL,
  fetchSubtitlesFromOptions,
  getExtensionId,
  hasLoginCookie,
  isOursError,
  launchWithExtension,
} from './helpers';

/**
 * D2 验收：字幕列表 → 字幕文件 → 缓存整条链路跑通。
 * 调试按钮已移到设置页，这里直接给 background 发 video-meta / subtitle:list。
 */
test.describe('D2 字幕抓取', () => {
  let context: BrowserContext;
  let page: Page;
  let extensionId = '';
  const ourErrors: string[] = [];

  test.beforeAll(async () => {
    context = await launchWithExtension();
    if (!(await hasLoginCookie(context))) {
      await context.close();
      throw new Error('未登录 B 站：先跑 `pnpm e2e:login` 扫码一次，登录态会存进 .e2e/profile');
    }
    extensionId = await getExtensionId(context);

    // 每次从冷缓存开始，确保测的是「新拉取」而不是上一轮留下的缓存。
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    await options.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      await api.storage.local.clear();
    });
    await options.close();

    page = await context.newPage();
    page.on('console', message => {
      if (message.type() === 'error' && isOursError(message.text())) ourErrors.push(message.text());
    });
    page.on('pageerror', error => {
      if (isOursError(String(error))) ourErrors.push(String(error));
    });

    await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
  });

  test.afterAll(async () => {
    await context?.close();
  });
  test('设置页诊断能拉到字幕并写进 chrome.storage.local', async () => {
    const host = page.locator('#suitang-host');
    await expect(host, '悬浮球没注入，检查 content script 是否加载').toBeAttached({ timeout: 60_000 });

    await host.locator('.vt-ball').click();
    await expect(host.locator('.vt-panel')).toBeVisible();
    await page.screenshot({ path: resolve('e2e', 'screenshots', 'd2-panel.png') });

    // 字幕文件要下载、解析，给足时间；失败原因落在返回值里。
    const result = await fetchSubtitlesFromOptions(context, extensionId);
    expect(result.ok, `字幕失败：${result.error ?? '未知错误'}`).toBe(true);
    expect(result.total ?? 0).toBeGreaterThan(0);
    expect(result.cached).toBe(false);
    // 只校条数不够：B 站接口会偶发返回别的视频的地址，正文必须对得上。
    expect((result.cues ?? []).map(cue => cue.content).join('')).toContain('零基础学AI');

    // 缓存真的落盘了：从扩展自己的页面读 storage。
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId}/src/options/index.html`);
    const keys = (await options.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      return Object.keys(await api.storage.local.get(null));
    })) as string[];

    expect(keys.filter(key => key.startsWith('sub:BV1sHU9BmEne:'))).toHaveLength(1);
    await options.close();

    expect(ourErrors, `扩展自身控制台报错：${ourErrors.join(' | ')}`).toHaveLength(0);
  });
});

/**
 * B 站自动生成的中文轨 lan 是 `ai-zh`，不是 `zh-CN`。
 * 只认 `zh` 开头的写法会把「有中文字幕」误判成没字幕，白掉到转写或抽帧去。
 */
test('pickTrack 认 ai-zh 这类自动生成的中文轨，但不会拿日语轨凑数', async () => {
  const { pickTrack } = await import('../src/shared/subtitles');
  const track = (lan: string) => ({ lan, lan_doc: lan, subtitle_url: 'https://example.com' });

  expect(pickTrack([track('ai-zh')])?.lan).toBe('ai-zh');
  expect(pickTrack([track('ja'), track('ai-zh')])?.lan).toBe('ai-zh');
  expect(pickTrack([track('zh-CN')])?.lan).toBe('zh-CN');
  // 真没有中文时，普通调用返回 null（交给 ASR），只有诊断才允许兜底取任意轨。
  expect(pickTrack([track('ja')])).toBeNull();
  expect(pickTrack([track('ja')], true)?.lan).toBe('ja');
});

/**
 * B 站 AI 字幕对纯音乐/无语音段会写「♪ 音乐 ♪」（BV1ECQ9B5EKe 的 P6 整段 19 行都是），
 * 这种 cue 不能拿去切段：模型面对 19 行音乐标记只能胡编，最后报「模型输出格式不对」。
 */
test('音乐/环境声占位不算可用字幕内容', async () => {
  const { hasMeaningfulCueText } = await import('../src/shared/subtitles');
  expect(hasMeaningfulCueText('♪ 音乐 ♪')).toBe(false);
  expect(hasMeaningfulCueText('♪♪♪')).toBe(false);
  expect(hasMeaningfulCueText('[Music]')).toBe(false);
  expect(hasMeaningfulCueText('[掌声]')).toBe(false);
  expect(hasMeaningfulCueText('...')).toBe(false);
  expect(hasMeaningfulCueText('All LLMs do is predict the next word.')).toBe(true);
  expect(hasMeaningfulCueText('♪ 音乐 ♪ 大家好')).toBe(true);
});

/**
 * 字幕行很少时（BV1ECQ9B5EKe P6 的自动转写只有 3 句），模型会把一段写成一行：
 * `{"start_line": 0, "end_line": 0, "title": "..."}`。
 * 这种输出在语义上是合法的，不能因为「行号不递增」「段数没到 6」就整条判失败。
 */
test('少数字幕行也接受一行一段，并按可用行数放宽段数下限', async () => {
  const { parseOutline, segmentRange } = await import('../src/shared/outline');
  const lines = [
    { from: 0, to: 40, text: '大语言模型只是在预测下一个词' },
    { from: 40, to: 200, text: '自回归生成与训练原理' },
    { from: 200, to: 581, text: '幻觉成因与上下文窗口' },
  ];
  const range = segmentRange(581);
  const text = JSON.stringify([
    { start_line: 0, end_line: 0, title: '大语言模型预测下一个词' },
    { start_line: 1, end_line: 1, title: '自回归生成与训练原理' },
    { start_line: 2, end_line: 2, title: '幻觉成因与上下文窗口' },
  ]);
  const segments = parseOutline(text, 581, range, lines);
  expect(segments).not.toBeNull();
  expect(segments?.length).toBe(3);
  expect(segments?.[0].start).toBe(0);
  // 最后一段要覆盖到片尾（原来的「大纲必须覆盖全片」约束不变）。
  expect(segments?.[segments.length - 1].end).toBe(581);
});

/**
 * 英文讲课视频（吴恩达 RAG 课这类）ASR 出来的是英文：旧的切句正则只认中文标点，
 * 整段英文切不开，大纲会退化成 1–2 段。改成按标点打包成 ≤80 字符的字幕行
 * （参照 Bilitato），英文逗号也参与断行；连标点都没有时按空格硬切。
 */
test('英文转写按标点打包成不超过 80 字符的字幕行', async () => {
  const { splitIntoSentences } = await import('../src/shared/asr');
  const english = splitIntoSentences(
    'LLMs are just fancy autocomplete. They predict the next token, not facts. Is that useless? No!',
    0,
    60,
  );
  expect(english.length).toBeGreaterThanOrEqual(3);
  for (const row of english) expect(row.text.length).toBeLessThanOrEqual(80);
  expect(english[0].text.startsWith('LLMs are just fancy autocomplete.')).toBe(true);
  expect(english[0].start).toBe(0);
  expect(english[english.length - 1].end).toBe(60);

  const long =
    'this is a long english sentence without any ending punctuation and it keeps going, ' +
    'with a comma in the middle, and more words after that to make it long enough';
  const fallback = splitIntoSentences(long, 0, 300);
  expect(fallback.length).toBeGreaterThan(2);
  for (const row of fallback) expect(row.text.length).toBeLessThanOrEqual(80);
  expect(fallback[0].start).toBe(0);
  expect(fallback[fallback.length - 1].end).toBe(300);
});
