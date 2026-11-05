/**
 * DeepSeek 用量估算。
 * 单价来自 api-docs.deepseek.com/quick_start/pricing，单位 USD / 1M tokens。
 * 只做估算，实际扣费以 DeepSeek 账单为准。
 */

import type { QaUsage } from './qa';

export interface ModelPrice {
  /** 输入 cache hit，USD / 1M tokens。 */
  hit: number;
  /** 输入 cache miss，USD / 1M tokens。 */
  miss: number;
  /** 输出，USD / 1M tokens。 */
  out: number;
}

export const PRICES: Record<'peak' | 'off', ModelPrice> = {
  peak: { hit: 0.006, miss: 0.3, out: 1.2 },
  off: { hit: 0.003, miss: 0.15, out: 0.6 },
};

/** 按 7.2 估算，改这里就行。 */
export const USD_TO_CNY = 7.2;

/**
 * DeepSeek 的 peak 是 UTC 周一至周五 01:00–04:00 和 06:00–10:00。
 * 即北京时间工作日 09:00–12:00、14:00–18:00。
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

/** reasoning_tokens 已包含在 completion_tokens 里，不另计。 */
export function estimateCostUsd(usage: QaUsage, atMs: number): number {
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

/** 传 USD，返回带 ¥ 的人民币估算；小于 1 分时保留 4 位，避免显示成一堆 0。 */
export function formatCny(usd: number): string {
  const amount = Number.isFinite(usd) ? Math.max(0, usd) * USD_TO_CNY : 0;
  if (amount <= 0) return '¥0.00';
  if (amount < 0.01) return `¥${amount.toFixed(4)}`;
  return `¥${amount.toFixed(2)}`;
}
