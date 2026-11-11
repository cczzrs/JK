/**
 * 执行记录（JKRD7 §9.4）：四种记录项，以及逐字节固定的 JSON 行格式。
 * CPU 与 GPU 两个后端输出同一种记录，比较时按这里的格式逐字节比较。
 */

import type { Bit } from "./model.ts";

export type RecordEntry =
  | { inject: string }
  | { notify: string }
  | { q: string; from: Bit; to: Bit }
  | { output: string; values: Record<string, Bit[]> };

/**
 * 固定的 JSON 文本：逗号和冒号后各一个空格，键按记录项定义的顺序，非 ASCII 字符原样输出。
 * 执行记录、快照之外的输出不要求这种格式。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(", ")}]`;
  if (typeof value === "object") {
    const parts = Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${JSON.stringify(k)}: ${canonicalJson(v)}`);
    return `{${parts.join(", ")}}`;
  }
  return JSON.stringify(value);
}

/** 一条记录的 JSON 行（不含换行）。 */
export function formatRecord(entry: RecordEntry): string {
  return canonicalJson(entry);
}

/** 全部记录的 JSON 行文本，每行以换行结尾。 */
export function formatRecords(entries: readonly RecordEntry[]): string {
  return entries.map((e) => formatRecord(e) + "\n").join("");
}

/** 快照文件文本：两格缩进，末尾一个换行。 */
export function formatSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot, null, 2) + "\n";
}

/** 输出记录中读到的 bit 拼成的整数（高位在前），例如十选一的 ASCII 码。 */
export function bitsToInt(values: readonly Bit[]): number {
  return values.reduce<number>((acc, v) => acc * 2 + v, 0);
}
