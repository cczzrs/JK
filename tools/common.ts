/** 命令行工具共用的文件读写、参数解析与报告写出（只在 Node 中使用）。 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseJson } from "../src/model.ts";

export const ROOT = resolve(import.meta.dirname, "..");
/** 规则正文与十选一附件；与下面各函数的参数一样，都是相对仓库根目录的路径。 */
export const DOC = "JKRD7.md";
export const SNAPSHOT_DOC = "snapshot/Snapshot.md";
export const ASCII_MODEL = "assets/ascii-bit-design/digits.jkm.json";

export function readText(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

/** 读取 JSON 文件；bit 按原文核对（JKRD7 §2 第 2 条，见 src/model.ts 的 parseJson）。 */
export function readJson<T = unknown>(path: string): T {
  return parseJson(readText(path)) as T;
}

export function writeText(path: string, text: string): void {
  const full = resolve(ROOT, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text, "utf8");
}

export function exists(path: string): boolean {
  return existsSync(resolve(ROOT, path));
}

/** 仓库相对路径（正斜杠）。 */
export function rel(path: string): string {
  return relative(ROOT, resolve(ROOT, path)).split("\\").join("/");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(ROOT, path))).digest("hex");
}

/** 报告中记录的源文件（规则、模型、实现）。 */
export const SOURCE_FILES = [
  "src/model.ts", "src/doc.ts", "src/record.ts", "src/cpu.ts", "src/executor.ts",
  "src/gpu/compile.ts", "src/gpu/kernel.ts", "src/gpu/backend.ts",
  "snapshot/snapshot.ts", "snapshot/cpu.ts", "snapshot/gpu.ts",
  "src/testing/cases.ts", "src/testing/fixtures.ts", "src/testing/random.ts", "src/testing/static.ts",
];

/** 写出核对报告：status、生成时间、调用方给出的各项，以及所列文件的 SHA-256（去重、排序，只列存在的文件）。 */
export function writeReport(path: string, failed: boolean, body: Record<string, unknown>, files: readonly string[]): void {
  const report = {
    status: failed ? "failed" : "passed",
    generated_at_utc: new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00"),
    ...body,
    sha256: Object.fromEntries([...new Set(files)].filter(exists).sort().map((p) => [p, sha256(p)])),
  };
  writeText(path, JSON.stringify(report, null, 2) + "\n");
  console.log(`报告已写入 ${path}`);
}

type ArgKind = "flag" | "value" | "list";
type Parsed<S extends Record<string, ArgKind>> = {
  [K in keyof S]: S[K] extends "flag" ? boolean : S[K] extends "list" ? string[] : string | undefined;
};

/**
 * 解析命令行参数。spec 的键是参数名（--write-report 写成 writeReport），值为
 * "flag"（开关）、"value"（后跟一个值）或 "list"（后跟若干个值，到下一个 -- 参数为止）。
 */
export function parseArgs<const S extends Record<string, ArgKind>>(argv: readonly string[], spec: S): Parsed<S> {
  const out: Record<string, boolean | string | string[] | undefined> = {};
  for (const [name, kind] of Object.entries(spec)) out[name] = kind === "flag" ? false : kind === "list" ? [] : undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const name = arg.startsWith("--") ? arg.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) : "";
    const kind = Object.hasOwn(spec, name) ? spec[name] : undefined;
    if (kind === undefined) throw new Error(`未知参数 ${arg}`);
    if (kind === "flag") {
      out[name] = true;
    } else if (kind === "list") {
      while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) (out[name] as string[]).push(argv[++i]);
    } else {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new Error(`${arg} 需要一个参数`);
      out[name] = value;
    }
  }
  return out as Parsed<S>;
}
