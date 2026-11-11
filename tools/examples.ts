/**
 * 生成展示页的内置示例文件 web/show/examples.json：JKRD7 第 10 节的模型与十选一附件的副本，按页面的显示顺序排列。
 * 示例的来源仍是 JKRD7 与附件；node tools/validate.ts 核对该文件与来源逐项相同。
 *
 *   node tools/examples.ts
 */

import type { Jkm } from "../src/model.ts";
import { DOC_MODELS, docModels, formatJkmJson } from "../src/doc.ts";
import { ASCII_MODEL, DOC, readJson, readText, writeText } from "./common.ts";

export const EXAMPLES_FILE = "web/show/examples.json";
/** 示例名称与顺序；ASCII_DIGITS 取自附件，其余取自 JKRD7 第 10 节。 */
const EXAMPLE_NAMES = ["ASCII_DIGITS", ...DOC_MODELS];

/** 按来源组装示例：名称 → JKM。 */
function buildExamples(): Record<string, Jkm> {
  const models = docModels(readText(DOC));
  const out: Record<string, Jkm> = {};
  for (const name of EXAMPLE_NAMES) {
    const model = name === "ASCII_DIGITS" ? readJson<Jkm>(ASCII_MODEL) : models.get(name);
    if (!model) throw new Error(`JKRD7 中没有模型 ${name}`);
    out[name] = model;
  }
  return out;
}

/** examples.json 的完整文本。 */
export function examplesText(): string {
  return formatJkmJson(buildExamples()) + "\n";
}

if (import.meta.main) {
  writeText(EXAMPLES_FILE, examplesText());
  console.log(`已写入 ${EXAMPLES_FILE}（${EXAMPLE_NAMES.length} 个示例）`);
}
