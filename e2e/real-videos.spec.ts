import { expect, test } from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHOT_DIR,
  clearStorage,
  getExtensionId,
  hasLoginCookie,
  launchWithExtension,
  writeSettings,
} from './helpers';

/**
 * 待办 3a：BV1XnxP6vEdX（0:55，宣传片，无字幕无章节，实际会 302 到 BV1EUxw6BErr）。
 * 这个视频是纯音乐宣传片：自动转写拿不到人声，应明确提示，并给出「按画面生成」的替代路。
 */
test('短视频 BV1XnxP6vEdX（0:55 无人声）明确提示而不是报格式错', async () => {
  test.setTimeout(300_000);
  const sfKey = process.env.SILICONFLOW_KEY ?? '';
  const dsKey = process.env.DS_KEY ?? '';
  test.skip(sfKey === '' || dsKey === '', '需要 .env 里的 SILICONFLOW_KEY 和 DS_KEY');

  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  try {
    expect(await hasLoginCookie(context)).toBe(true);
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: dsKey,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      visionModel: 'deepseek-flash',
      thinking: false,
      frameEnabled: false,
      asrApiKey: sfKey,
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
    });

    const page = await context.newPage();
    await page.goto('https://www.bilibili.com/video/BV1XnxP6vEdX/', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    // 55 秒没有字幕：面板会自动转写再重试。这个视频（BV1XnxP6vEdX 会 302 到
    // BV1EUxw6BErr）是纯音乐宣传片，转写拿不到人声；正确行为是明确告诉用户，
    // 而不是拿空字幕去切段、最后报「模型输出格式不对」。
    await page.waitForTimeout(3000);
    console.log('===SHORT-URL=== ' + page.url());
    console.log('===SHORT-IDS=== ' + (await page.locator('.vt-ids').innerText().catch(() => '?')));
    const t0 = Date.now();
    await page.locator('.vt-outline-generate').click();
    const seen: string[] = [];
    let found = false;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const empty = await page.locator('.vt-outline-empty-text').innerText().catch(() => '');
      const error = await page.locator('.vt-outline-error-text').innerText().catch(() => '');
      if (empty !== '') seen.push(empty);
      if (/没检测到人声|只识别到音乐/.test(empty) || /没检测到人声|只识别到音乐/.test(error)) {
        found = true;
        break;
      }
      await page.waitForTimeout(1000);
    }
    const stateText = await page.locator('.vt-outline-state').innerText().catch(() => '?');
    const itemCount = await page.locator('.vt-outline-item').count();
    const framesVisible = await page.locator('.vt-outline-frames').isVisible().catch(() => false);
    console.log(`===SHORT-STATE=== ${stateText} (${Date.now() - t0}ms)`);
    console.log('===SHORT-NOTICE=== ' + JSON.stringify(seen.slice(-3)));
    console.log(`===SHORT-ITEMS=== ${itemCount}，按画面生成可见=${framesVisible}`);
    await page.screenshot({ path: join(SHOT_DIR, 'd10-short-outline.png') });

    // 没检测到人声要如实说，而且不能把用户堵死：给「按画面生成」这条替代路。
    expect(found).toBe(true);
    expect(JSON.stringify(seen)).not.toContain('格式不对');
    expect(itemCount).toBe(0);
    expect(framesVisible).toBe(true);
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});

/**
 * 待办 3b：BV1aRxX6iE7h（52:08，无字幕无章节，887 句 ASR）。
 * 走「转写 → 生成大纲 → 存知识库」，量笔记和底稿的实际大小回答「会不会撑爆」。
 */
test('长视频 BV1aRxX6iE7h（52:08）转写入库并量 md 大小', async () => {
  test.setTimeout(900_000);
  const sfKey = process.env.SILICONFLOW_KEY ?? '';
  const dsKey = process.env.DS_KEY ?? '';
  test.skip(sfKey === '' || dsKey === '', '需要 .env 里的 SILICONFLOW_KEY 和 DS_KEY');
  const companion = await fetchCompanionStatus();
  test.skip(companion === null, '需要先在终端跑 pnpm companion');

  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  try {
    expect(await hasLoginCookie(context)).toBe(true);
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: dsKey,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      visionModel: 'deepseek-flash',
      thinking: false,
      frameEnabled: false,
      asrApiKey: sfKey,
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
    });

    const page = await context.newPage();
    await page.goto('https://www.bilibili.com/video/BV1aRxX6iE7h/', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();

    // 52 分钟超过自动转写上限（15 分钟），要手动点「转写这段」。
    const t0 = Date.now();
    await expect(page.locator('.vt-outline-asr')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-outline-asr').click();
    await expect(page.locator('.vt-outline-asr')).toHaveText('已转写', { timeout: 600_000 });
    console.log(`===LONG-ASR=== ${Date.now() - t0}ms`);

    const t1 = Date.now();
    await page.locator('.vt-outline-generate').click();
    const state = page.locator('.vt-outline-state');
    await expect(state).toHaveText(/^\d+ 段$/, { timeout: 300_000 });
    console.log(`===LONG-OUTLINE=== ${Date.now() - t1}ms`);
    const count = await page.locator('.vt-outline-item').count();
    const details = (await page.locator('.vt-outline-detail').allInnerTexts()).map(text =>
      text.trim(),
    );
    const conclusions = await page.locator('.vt-conclusions-list li').allInnerTexts();
    console.log(`===LONG-COUNT=== ${count} 段，说明 ${details.filter(t => t !== '').length} 段`);
    await page.screenshot({ path: join(SHOT_DIR, 'd10-long-outline.png') });
    expect(count).toBeGreaterThanOrEqual(3);
    expect(details.filter(text => text !== '').length).toBeGreaterThanOrEqual(3);
    expect(conclusions.length).toBeGreaterThanOrEqual(1);

    // 存到知识库，然后量实际文件大小。
    await page.locator('.vt-kb-open').click();
    await expect(page.locator('.vt-kb')).toBeVisible({ timeout: 60_000 });
    await page.locator('.vt-kb-confirm').click();
    await expect(page.locator('.vt-status')).toContainText(/已存|已覆盖/, { timeout: 180_000 });
    console.log('===LONG-SAVED=== ' + (await page.locator('.vt-status').innerText()));
    await page.screenshot({ path: join(SHOT_DIR, 'd10-long-kb-saved.png') });

    const kbDir = companion?.kbDir ?? 'D:\\knowledge-base';
    const note = latestFile(join(kbDir, '20-知识笔记'), /BV1aRxX6iE7h/);
    const source = latestFile(join(kbDir, '50-底稿', '视频原文', 'BV1aRxX6iE7h'), /-p01/);
    const noteText = note ? readFileSync(note, 'utf8') : '';
    const sourceText = source ? readFileSync(source, 'utf8') : '';
    console.log(`===LONG-SIZES=== 笔记 ${noteText.length} 字符 ${byteSize(note)} 字节；底稿 ${sourceText.length} 字符 ${byteSize(source)} 字节`);
    console.log('===LONG-SOURCE-HEAD===\n' + sourceText.slice(0, 600));
    expect(noteText).toContain('## 核心结论');
    expect(sourceText).toContain('## 字幕');
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});

/**
 * 待办 3d：多 P 视频（185P Python 课，P2 455 秒）在 P2 直接转写。
 * B 站 SPA 切 P 后 __INITIAL_STATE__.videoData.cid 仍是首 P 的 cid，旧逻辑拿它
 * 判断当前分 P，p>1 一律误报「播放地址和当前分 P 不一致」；修好后应能直接转写。
 */
test('多 P BV1sHU9BmEne 在 P2 转写不再误报分 P 不一致', async () => {
  test.setTimeout(600_000);
  const sfKey = process.env.SILICONFLOW_KEY ?? '';
  const dsKey = process.env.DS_KEY ?? '';
  test.skip(sfKey === '' || dsKey === '', '需要 .env 里的 SILICONFLOW_KEY 和 DS_KEY');

  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  try {
    expect(await hasLoginCookie(context)).toBe(true);
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: dsKey,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      visionModel: 'deepseek-flash',
      thinking: false,
      frameEnabled: false,
      asrApiKey: sfKey,
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
    });

    const page = await context.newPage();
    await page.goto('https://www.bilibili.com/video/BV1sHU9BmEne/?p=2', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();
    await expect(page.locator('.vt-part')).toContainText('P2', { timeout: 30_000 });
    await page.waitForTimeout(3000);
    console.log('===MULTIP-IDS=== ' + (await page.locator('.vt-ids').innerText().catch(() => '?')));

    // 手动点「转写这段」，强制走 ASR（P2 是否有官方字幕都覆盖不到这条路径）。
    const t0 = Date.now();
    await page.locator('.vt-outline-asr').click();
    await expect(page.locator('.vt-outline-asr')).toHaveText('已转写', { timeout: 300_000 });
    console.log(`===MULTIP-ASR=== ${Date.now() - t0}ms`);

    // 旧逻辑在这里会直接抛「分 P 不一致」，所以「已转写」本身就证明修复生效。
    const errorText = await page.locator('.vt-outline-error-text').innerText().catch(() => '');
    const emptyText = await page.locator('.vt-outline-empty-text').innerText().catch(() => '');
    console.log(`===MULTIP-TEXT=== 错误=${JSON.stringify(errorText)} 空态=${JSON.stringify(emptyText)}`);
    await page.screenshot({ path: join(SHOT_DIR, 'd10-multip-real-p2.png') });
    expect(errorText).not.toContain('分 P 不一致');
    expect(emptyText).not.toContain('分 P 不一致');
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});

/**
 * 待办 3e：BV1ECQ9B5EKe 的 P6（B 站 AI 字幕整段只有 19 行「♪ 音乐 ♪」）。
 * 旧行为：拿音乐标记去切段，模型只能胡编，最后报「模型输出格式不对」。
 * 新行为：识别出「没有可用文字」→ 当作没字幕，自动转写后重试；转写也没人声就如实提示。
 */
test('字幕只有音乐标记的分 P 不报格式错', async () => {
  test.setTimeout(600_000);
  const sfKey = process.env.SILICONFLOW_KEY ?? '';
  const dsKey = process.env.DS_KEY ?? '';
  test.skip(sfKey === '' || dsKey === '', '需要 .env 里的 SILICONFLOW_KEY 和 DS_KEY');

  const context = await launchWithExtension();
  const extensionId = await getExtensionId(context);
  try {
    expect(await hasLoginCookie(context)).toBe(true);
    await clearStorage(context, extensionId);
    await writeSettings(context, extensionId, {
      apiKey: dsKey,
      apiBaseUrl: 'https://api.deepseek.com',
      textModel: 'deepseek-flash',
      visionModel: 'deepseek-flash',
      thinking: false,
      frameEnabled: false,
      asrApiKey: sfKey,
      asrBaseUrl: 'https://api.siliconflow.cn/v1',
      asrModel: 'FunAudioLLM/SenseVoiceSmall',
    });

    const page = await context.newPage();
    for (const worker of context.serviceWorkers()) {
      worker.on('console', msg => console.log('[SW] ' + msg.text()));
    }
    context.on('serviceworker', worker => {
      worker.on('console', msg => console.log('[SW] ' + msg.text()));
    });
    await page.goto('https://www.bilibili.com/video/BV1ECQ9B5EKe/?p=6', {
      waitUntil: 'domcontentloaded',
    });
    await expect(page.locator('.vt-ball')).toBeVisible({ timeout: 30_000 });
    await page.locator('.vt-ball').click();
    await expect(page.locator('.vt-panel')).toBeVisible();
    await expect(page.locator('.vt-part')).toContainText('P6', { timeout: 30_000 });
    await page.waitForTimeout(3000);
    console.log('===MUSIC-IDS=== ' + (await page.locator('.vt-ids').innerText().catch(() => '?')));

    await page.locator('.vt-outline-generate').click();
    const t0 = Date.now();
    let stateText = '';
    let noticeText = '';
    let errorText = '';
    const deadline = Date.now() + 420_000;
    while (Date.now() < deadline) {
      stateText = (await page.locator('.vt-outline-state').innerText().catch(() => '')).trim();
      noticeText = (await page.locator('.vt-outline-empty-text').innerText().catch(() => '')).trim();
      errorText = (await page.locator('.vt-outline-error-text').innerText().catch(() => '')).trim();
      if (/^\d+ 段$/.test(stateText)) break;
      if (/没检测到人声|只有音乐\/环境声/.test(noticeText + errorText)) break;
      await page.waitForTimeout(2000);
    }
    console.log(`===MUSIC-STATE=== ${JSON.stringify(stateText)} (${Date.now() - t0}ms)`);
    console.log(`===MUSIC-NOTICE=== ${JSON.stringify(noticeText)}`);
    console.log(`===MUSIC-ERROR=== ${JSON.stringify(errorText)}`);
    const itemCount = await page.locator('.vt-outline-item').count();
    console.log(`===MUSIC-ITEMS=== ${itemCount}`);
    await page.screenshot({ path: join(SHOT_DIR, 'd10-music-subtitle.png') });

    // 关键：不能再拿音乐标记去硬切、报「模型输出格式不对」。
    const allText = `${stateText} ${noticeText} ${errorText}`;
    expect(allText).not.toContain('格式不对');
    expect(/^\d+ 段$/.test(stateText) || /没检测到人声|只有音乐\/环境声/.test(allText)).toBe(true);
    if (/^\d+ 段$/.test(stateText)) expect(itemCount).toBeGreaterThan(0);
  } finally {
    await clearStorage(context, extensionId).catch(() => undefined);
    await context.close();
  }
});

async function fetchCompanionStatus(): Promise<{ kbDir?: string } | null> {
  try {
    const response = await fetch('http://127.0.0.1:8787/api/kb/status');
    return response.ok ? ((await response.json()) as { kbDir?: string }) : null;
  } catch {
    return null;
  }
}

function latestFile(dir: string, pattern: RegExp): string | null {
  try {
    const files = readdirSync(dir)
      .filter(name => pattern.test(name))
      .map(name => ({ name, mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? join(dir, files[0].name) : null;
  } catch {
    return null;
  }
}

function byteSize(path: string | null): number {
  if (!path) return 0;
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
