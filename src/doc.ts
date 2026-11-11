/**
 * JKRD7 正文与附件的文本：取出正文里的 JSON 块，以及按正文的排版输出 JKM。
 * 这里不含规则；规则检查在 model.ts。只依赖语言本身，命令行（Node）与浏览器共用。
 */

import { type Jki, type Jkm, isObj, parseJson } from "./model.ts";

/** JKRD7 第 10 节的完整模型（§10.1、§10.3—§10.6、§10.8），按正文顺序。 */
export const DOC_MODELS = ["M_FLOW", "M_PATH", "M_SYNC", "M_TX", "M_NEST", "M_REG"] as const;

/** Markdown 中全部 ```json 代码块的原文。 */
export function jsonBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
}

/** JKRD7 正文中按 jkm 名称索引的模型。 */
export function docModels(markdown: string): Map<string, Jkm> {
  const models = new Map<string, Jkm>();
  for (const block of jsonBlocks(markdown)) {
    const data = parseJson(block);
    if (isObj(data) && typeof data.jkm === "string" && "roots" in data) models.set(data.jkm, data as unknown as Jkm);
  }
  return models;
}

/** JKRD7 正文中第一个含有键 key 的 JSON 块。 */
export function docBlock<T>(markdown: string, key: string): T {
  for (const block of jsonBlocks(markdown)) {
    const data = parseJson(block);
    if (isObj(data) && key in data) return data as T;
  }
  throw new Error(`JKRD7 中没有含 ${key} 的 JSON 块`);
}

/** JKRD7 正文中 id 为 jkiId 的 JKI 片段。 */
export function docFragment(markdown: string, jkiId: string): Jki {
  for (const block of jsonBlocks(markdown)) {
    const data = parseJson(block);
    if (isObj(data) && data.id === jkiId && !("members" in data)) return data as unknown as Jki;
  }
  throw new Error(`JKRD7 中没有 JKI 片段 ${jkiId}`);
}

/** 含组（有 members 的对象）的值。 */
function hasGroup(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasGroup);
  if (typeof value !== "object" || value === null) return false;
  return "members" in value || Object.values(value).some(hasGroup);
}

/**
 * 按 JKRD7 第 10 节与附件的排版输出 JKM 的 JSON 文本（不含末尾换行）：members 数组和含组的对象、数组逐项换行、
 * 缩进 2 格，其余值写成一行。节点因此一行一个，组的字段一行一个。展示页与 web/show/examples.json 共用。
 */
export function formatJkmJson(value: unknown, indent = "", expand = hasGroup(value)): string {
  if (!expand) {
    if (Array.isArray(value)) return `[${value.map((v) => formatJkmJson(v)).join(", ")}]`;
    if (typeof value === "object" && value !== null) {
      return `{${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${formatJkmJson(v)}`).join(", ")}}`;
    }
    return JSON.stringify(value);
  }
  const inner = indent + "  ";
  const items = Array.isArray(value)
    ? value.map((v) => inner + formatJkmJson(v, inner))
    : Object.entries(value as object).map(([k, v]) => `${inner}${JSON.stringify(k)}: ${formatJkmJson(v, inner, k === "members" || hasGroup(v))}`);
  const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"];
  return `${open}\n${items.join(",\n")}\n${indent}${close}`;
}
