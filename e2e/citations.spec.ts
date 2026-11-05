import { expect, test } from '@playwright/test';
import {
  extractCitationSeconds,
  formatTimestamp,
  parseCitations,
  renderAnswerHtml,
} from '../src/shared/citations';

test('[mm:ss] / [hh:mm:ss] / 全角括号都能解析', () => {
  const tokens = parseCitations('开头 [00:12]，中段 ［02:30］，后面 [1:02:03]。');
  expect(tokens.map(token => token.seconds)).toEqual([12, 150, 3723]);
  expect(tokens.map(token => token.raw)).toEqual(['[00:12]', '［02:30］', '[1:02:03]']);
});

test('秒位越界或格式不对的引用不算时间戳', () => {
  expect(parseCitations('假的 [02:99]，缺括号 12:30，空的 [--:--]')).toEqual([]);
});

test('formatTimestamp 输出可读的 mm:ss', () => {
  expect(formatTimestamp(0)).toBe('00:00');
  expect(formatTimestamp(12.7)).toBe('00:12');
  expect(formatTimestamp(150)).toBe('02:30');
  expect(formatTimestamp(3723)).toBe('62:03');
});

test('extractCitationSeconds 去重升序并剔除时长外的引用', () => {
  const text = '[00:12] 说了 A，[00:12] 又重复，[05:00] 超出。';
  expect(extractCitationSeconds(text, 100)).toEqual([12]);
  expect(extractCitationSeconds(text)).toEqual([12, 300]);
});

test('回答渲染成可点击的锚点，并转义模型输出的 HTML', () => {
  const html = renderAnswerHtml('结论 [00:12]\n\n补充：<img src=x onerror=alert(1)>');
  expect(html).toContain('<a class="vt-cite" data-t="12"');
  expect(html).toContain('[00:12]');
  expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(html).not.toContain('<img');
});

test('超出视频时长的引用只留灰字，不可点', () => {
  const html = renderAnswerHtml('这段在 [10:00] 才有', 60);
  expect(html).toContain('vt-cite-off');
  expect(html).not.toContain('<a class="vt-cite"');
});
