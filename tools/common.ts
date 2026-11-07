/** 命令行工具共用的文件读写（只在 Node 中使用）。 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const DOC = resolve(ROOT, "JKRD7.md");
export const ASCII_MODEL = resolve(ROOT, "assets/ascii-bit-design/digits.jkm.json");

export function readText(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readText(path)) as T;
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

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(ROOT, path))).digest("hex");
}

export function nowUtc(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

/** 报告中记录的源文件（规则、模型、实现）。 */
export const SOURCE_FILES = [
  "src/model.ts", "src/record.ts", "src/cpu.ts", "src/executor.ts",
  "src/gpu/compile.ts", "src/gpu/kernel.ts", "src/gpu/backend.ts",
  "src/testing/cases.ts", "src/testing/fixtures.ts", "src/testing/random.ts", "src/testing/static.ts",
];
