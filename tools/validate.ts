/**
 * JKRD7 静态检查（JKRD7 §11.1）。
 *
 * 检查 JKRD7.md 中的全部 JSON 块、十选一模型附件、§2/§3/§5/§6.2/§8 规则的负例与正例、
 * 待适配工厂附件的 JSON 语法、本地 Markdown 链接和 jk.config.json 中的路径。不执行模型。
 *
 *   node tools/validate.ts [--write-report]
 */

import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Model, checkJki, checkRunScript, checkSnapshot, isObj, jsonBlocks } from "../src/model.ts";
import { NEGATIVE, POSITIVE } from "../src/testing/static.ts";
import { ROOT, exists, nowUtc, readJson, readText, rel, sha256, writeText } from "./common.ts";

const DOC_MODELS = ["M1", "M_FLOW", "M_PATH", "M_SYNC", "M_TX", "M_NEST", "M_REG"];
const MODEL_ASSETS = ["assets/ascii-bit-design/digits.jkm.json"];
const PENDING_ASSETS = [
  "assets/jks-factory-v7-design/JKI.FACTORY.json",
  "assets/jks-factory-v7-design/RAM.FACTORY.json",
  "assets/jks-factory-v7-design/design-contract.json",
  "assets/jks-factory-v7-design/generation-example.json",
];
const MARKDOWN = ["*.md", "docs/*.md", "docs/modules/*.md"];
const REPORT = "reports/static-validation.json";

class Checker {
  readonly errors: string[] = [];
  readonly items: { check: string; passed: boolean }[] = [];
  readonly files = new Set(["JKRD7.md", "jk.config.json"]);

  record(name: string, problems: string[]): void {
    this.items.push({ check: name, passed: problems.length === 0 });
    this.errors.push(...problems.map((p) => `${name}: ${p}`));
  }

  docBlocks(): void {
    const parsed: unknown[] = [];
    jsonBlocks(readText("JKRD7.md")).forEach((block, i) => {
      try {
        parsed.push(JSON.parse(block));
      } catch (e) {
        this.record(`JKRD7 JSON 块 ${i + 1}`, [`无法解析：${(e as Error).message}`]);
      }
    });
    const models = new Map<string, unknown>();
    for (const d of parsed) if (isObj(d) && "roots" in d && typeof d.jkm === "string") models.set(d.jkm, d);
    parsed.forEach((data, i) => {
      let name: string;
      let problems: string[] = [];
      if (isObj(data) && "snapshot" in data) {
        name = `JKRD7 快照 ${String(data.snapshot)}`;
        const base = models.get(data.jkm as string);
        problems = base ? checkSnapshot(data, new Model(base, data.jkm as string)) : [`快照对应的模型 ${String(data.jkm)} 不在正文中`];
      } else if (isObj(data) && "run" in data) {
        name = `JKRD7 运行脚本 ${String(data.run)}`;
        const path = String(data.model);
        if (exists(path)) {
          this.files.add(rel(path));
          problems = checkRunScript(data, new Model(readJson(path), path));
        } else {
          problems = [`模型文件 ${path} 不存在`];
        }
      } else if (isObj(data) && "jkm" in data) {
        name = `JKRD7 模型 ${String(data.jkm)}`;
        problems = new Model(data, String(data.jkm)).errors;
      } else if (isObj(data) && !("members" in data)) {
        name = `JKRD7 JKI 片段 ${String(data.id)}`;
        checkJki(data, `片段 ${String(data.id)}`, problems);
      } else {
        name = `JKRD7 JSON 块 ${i + 1}`;
        problems = ["正文 JSON 块只能是 JKM、JKI 片段、运行脚本或快照"];
      }
      this.record(name, problems);
    });
    this.record("JKRD7 第 10 节模型齐全", DOC_MODELS.filter((m) => !models.has(m)).map((m) => `缺少 ${m}`));
  }

  assets(): void {
    for (const path of MODEL_ASSETS) {
      this.files.add(path);
      this.record(`模型附件 ${path}`, new Model(readJson(path), path).errors);
    }
    for (const path of PENDING_ASSETS) {
      this.files.add(path);
      let problems: string[] = [];
      try {
        readJson(path);
      } catch (e) {
        problems = [(e as Error).message];
      }
      this.record(`待适配附件 JSON 语法 ${path}`, problems);
    }
  }

  fixtures(): void {
    for (const [name, build] of POSITIVE) this.record(`正例：${name}`, new Model(build(), name).errors);
    for (const [name, build, fragment] of NEGATIVE) {
      const errors = new Model(build(), name).errors;
      const ok = errors.some((e) => e.includes(fragment));
      this.record(`负例：${name}`, ok ? [] : [`预期包含“${fragment}”的错误，实际 ${JSON.stringify(errors)}`]);
    }
  }

  links(): void {
    const problems: string[] = [];
    const files = MARKDOWN.flatMap((pattern) => globSync(pattern, { cwd: ROOT })).sort();
    for (const md of files) {
      this.files.add(rel(md));
      for (const m of readText(md).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^[a-z]+:/.test(target) || target.startsWith("#")) continue;
        const local = target.replace(/(#.*|:\d+)$/, "");
        if (!exists(resolve(dirname(resolve(ROOT, md)), local))) problems.push(`${rel(md)} → ${target}`);
      }
    }
    this.record("本地链接", problems);
  }

  config(): void {
    const data = readJson<Record<string, unknown>>("jk.config.json");
    const problems: string[] = [];
    const walk = (value: unknown) => {
      if (isObj(value)) Object.values(value).forEach(walk);
      else if (typeof value === "string" && /\.(md|json|ts|html)$/.test(value) && !exists(value)) problems.push(value);
    };
    walk(data);
    if ((data.canonical as Record<string, unknown> | undefined)?.rules_version !== "7.0.0") problems.push("rules_version 不是 7.0.0");
    this.record("jk.config.json 索引", problems);
  }

  run(): string[] {
    this.docBlocks();
    this.assets();
    this.fixtures();
    this.links();
    this.config();
    return this.errors;
  }
}

function main(): number {
  const writeReport = process.argv.includes("--write-report");
  const checker = new Checker();
  const errors = checker.run();
  const passed = checker.items.filter((i) => i.passed).length;
  for (const e of errors) console.log("错误", e);
  console.log(`${passed}/${checker.items.length} 项静态检查通过（负例 ${NEGATIVE.length} 个，正例 ${POSITIVE.length} 个）`);
  if (writeReport) {
    const files = [...new Set([...checker.files, "tools/validate.ts", "src/model.ts", "src/testing/static.ts"])].sort();
    const report = {
      status: errors.length ? "failed" : "passed",
      generated_at_utc: nowUtc(),
      scope: "JKRD7 §2/§3/§5/§6.2/§8 static rules, document JSON, model asset, fixtures, links and index; "
        + "no execution (see reports/reference-run.json and reports/gpu-run.json)",
      checks: checker.items,
      errors,
      sha256: Object.fromEntries(files.filter(exists).map((p) => [p, sha256(p)])),
    };
    writeText(REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(`报告已写入 ${REPORT}`);
  }
  return errors.length ? 1 : 0;
}

process.exitCode = main();
