/**
 * 本地用量账本：单键 `usage:ledger`。
 * 金额单位是元；只记估算值，跨天/跨月用本地时区，日/月字段与当前时间不一致时归零。
 */

export const USAGE_LEDGER_KEY = 'usage:ledger';
export const USAGE_SCHEMA = 2;

export interface UsageLedger {
  schema: 2;
  /** 本地日期 YYYY-MM-DD。 */
  day: string;
  dayCny: number;
  /** 本地月份 YYYY-MM。 */
  month: string;
  monthCny: number;
  totalCny: number;
  updatedAt: number;
}

const EMPTY_LEDGER: UsageLedger = {
  schema: USAGE_SCHEMA,
  day: '',
  dayCny: 0,
  month: '',
  monthCny: 0,
  totalCny: 0,
  updatedAt: 0,
};

function localDay(atMs: number): string {
  const date = new Date(atMs);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function localMonth(atMs: number): string {
  const date = new Date(atMs);
  if (!Number.isFinite(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

function amountOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeLedger(raw: unknown): UsageLedger {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_LEDGER };
  const saved = raw as Partial<UsageLedger>;
  if (saved.schema !== USAGE_SCHEMA) return { ...EMPTY_LEDGER };
  return {
    schema: USAGE_SCHEMA,
    day: textOf(saved.day),
    dayCny: amountOf(saved.dayCny),
    month: textOf(saved.month),
    monthCny: amountOf(saved.monthCny),
    totalCny: amountOf(saved.totalCny),
    updatedAt: typeof saved.updatedAt === 'number' && Number.isFinite(saved.updatedAt) ? saved.updatedAt : 0,
  };
}

export async function readLedger(): Promise<UsageLedger> {
  try {
    const stored = await chrome.storage.local.get(USAGE_LEDGER_KEY);
    return normalizeLedger(stored[USAGE_LEDGER_KEY]);
  } catch {
    return { ...EMPTY_LEDGER };
  }
}

// 问答和大纲可能同时完成，串行化 read-modify-write，避免后写覆盖前写。
let writeChain: Promise<unknown> = Promise.resolve();

export function recordUsage(cny: number, atMs: number): Promise<UsageLedger> {
  const run = writeChain.then(async () => {
    const current = await readLedger();
    const stamp = Number.isFinite(atMs) ? atMs : Date.now();
    const day = localDay(stamp);
    const month = localMonth(stamp);
    const amount = Number.isFinite(cny) ? Math.max(0, cny) : 0;
    const next: UsageLedger = {
      schema: USAGE_SCHEMA,
      day,
      dayCny: current.day === day ? current.dayCny + amount : amount,
      month,
      monthCny: current.month === month ? current.monthCny + amount : amount,
      totalCny: current.totalCny + amount,
      updatedAt: stamp,
    };
    await chrome.storage.local.set({ [USAGE_LEDGER_KEY]: next });
    return next;
  });
  writeChain = run.catch(() => undefined);
  return run;
}
