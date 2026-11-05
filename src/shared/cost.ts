/**
 * DeepSeek 用量估算。
 * 单价来自 api-docs.deepseek.com/zh-cn/quick_start/pricing，单位是「元 / 百万 tokens」。
 * 中文定价页直接给人民币，不做汇率换算。
 * 只做估算，实际扣费以 DeepSeek 账单为准。
 */

import type { QaUsage } from './qa';

export interface ModelPrice {
  /** 输入 cache hit，元 / 1M tokens。 */
  hit: number;
  /** 输入 cache miss，元 / 1M tokens。 */
  miss: number;
  /** 输出，元 / 1M tokens。 */
  out: number;
}

/** 人民币单价，照抄中文定价页。 */
export const PRICES: Record<'peak' | 'off', ModelPrice> = {
  peak: { hit: 0.04, miss: 2, out: 8 },
  off: { hit: 0.02, miss: 1, out: 4 },
};

/**
 * 高峰时段按北京时间算：周一至周五 9:00–12:00、14:00–18:00。
 * 用 UTC 判断时对应 01:00–04:00 和 06:00–10:00。
 * 不扣中国法定节假日，只按周末 + 时段判断。
 */
export function isPeakHour(atMs: number): boolean {
  const date = new Date(atMs);
  if (!Number.isFinite(date.getTime())) return false;
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/** reasoning_tokens 已包含在 completion_tokens 里，不另计。返回元。 */
export function estimateCostCny(usage: QaUsage, atMs: number): number {
  const price = PRICES[isPeakHour(atMs) ? 'peak' : 'off'];
  const hit = Math.max(0, usage.cacheHitTokens || 0);
  // 有些代理只给 prompt_tokens，没有 cache miss 字段；把剩余输入都按 miss 算。
  const miss =
    usage.cacheMissTokens > 0
      ? Math.max(0, usage.cacheMissTokens)
      : Math.max(0, (usage.promptTokens || 0) - hit);
  const out = Math.max(0, usage.completionTokens || 0);
  return (hit * price.hit + miss * price.miss + out * price.out) / 1_000_000;
}

/** 传入元，返回带 ¥ 的展示文本；小于 1 分时保留 4 位，避免显示成一堆 0。 */
export function formatCny(amount: number): string {
  const value = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  if (value <= 0) return '¥0.00';
  if (value < 0.01) return `¥${value.toFixed(4)}`;
  return `¥${value.toFixed(2)}`;
}
