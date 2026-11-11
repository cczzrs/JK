/**
 * JKRD7 静态检查（JKRD7 §11.1）。
 *
 * 检查 JKRD7.md 中的全部 JSON 块、十选一模型附件、§2/§3/§5/§6.4/§8 规则的负例与正例、bit 的原文写法、
 * 快照（§9.5）的正例与负例、待适配工厂附件的 JSON 语法、展示页的内置示例、本地 Markdown 链接和
 * jk.config.json 中的路径。不执行模型。
 *
 *   node tools/validate.ts [--write-report]
 */

import { globSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Model, checkJki, checkRunScript, checkSnapshot, isObj, parseJson } from "../src/model.ts";
import { DOC_MODELS, jsonBlocks } from "../src/doc.ts";
import { NEGATIVE, POSITIVE, SNAPSHOT_CASES, TEXT_CASES } from "../src/testing/static.ts";
import { ASCII_MODEL, DOC, ROOT, exists, parseArgs, readJson, readText, rel, writeReport } from "./common.ts";
import { EXAMPLES_FILE, examplesText } from "./examples.ts";

/** 正文中必须有的完整模型：§8.1 的 M1 与第 10 节的模型。 */
const REQUIRED_MODELS = ["M1", ...DOC_MODELS];
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
  readonly files = new Set([DOC, "jk.config.json"]);

  record(name: string, problems: string[]): void {
    this.items.push({ check: name, passed: problems.length === 0 });
    for (const p of problems) this.errors.push(`${name}: ${p}`);
  }

  /** fragment 为 null 时应当没有错误；否则应当有一条含 fragment 的错误。 */
  expect(name: string, errors: string[], fragment: string | null): void {
    if (fragment === null) this.record(name, errors);
    else this.record(name, errors.some((e) => e.includes(fragment)) ? [] : [`预期包含“${fragment}”的错误，实际 ${JSON.stringify(errors)}`]);
  }

  docBlocks(): void {
    const parsed: unknown[] = [];
    jsonBlocks(readText(DOC)).forEach((block, i) => {
      try {
        parsed.push(parseJson(block));
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
    this.record("JKRD7 正文模型齐全", REQUIRED_MODELS.filter((m) => !models.has(m)).map((m) => `缺少 ${m}`));
  }

  assets(): void {
    this.files.add(ASCII_MODEL);
    this.record(`模型附件 ${ASCII_MODEL}`, new Model(readJson(ASCII_MODEL), ASCII_MODEL).errors);
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
    for (const [name, build] of POSITIVE) this.expect(`正例：${name}`, new Model(build(), name).errors, null);
    for (const [name, build, fragment] of NEGATIVE) this.expect(`负例：${name}`, new Model(build(), name).errors, fragment);
    // bit 的原文写法（§2 第 2 条）：文本先经 parseJson 解析
    for (const [name, text, fragment] of TEXT_CASES) this.expect(`原文：${name}`, new Model(parseJson(text()), name).errors, fragment);
    // 快照（§9.5）
    for (const [name, build, fragment] of SNAPSHOT_CASES) {
      const { model, snapshot } = build();
      const loaded = new Model(model, name);
      if (loaded.errors.length) this.record(`快照：${name}`, ["夹具的模型不合法", ...loaded.errors]);
      else this.expect(`快照：${name}`, checkSnapshot(snapshot, loaded), fragment);
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

  /** 展示页的内置示例文件与 JKRD7 第 10 节、十选一附件逐项相同。 */
  examples(): void {
    this.files.add(EXAMPLES_FILE);
    const problems: string[] = [];
    if (!exists(EXAMPLES_FILE)) problems.push(`${EXAMPLES_FILE} 不存在，请运行 node tools/examples.ts`);
    else if (readText(EXAMPLES_FILE) !== examplesText()) problems.push(`${EXAMPLES_FILE} 与 JKRD7、附件不一致，请运行 node tools/examples.ts 重新生成`);
    this.record("展示页示例文件", problems);
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
    this.examples();
    this.config();
    return this.errors;
  }
}

function main(): number {
  const args = parseArgs(process.argv.slice(2), { writeReport: "flag" });
  const checker = new Checker();
  const errors = checker.run();
  const passed = checker.items.filter((i) => i.passed).length;
  for (const e of errors) console.log("错误", e);
  console.log(`${passed}/${checker.items.length} 项静态检查通过（负例 ${NEGATIVE.length} 个，正例 ${POSITIVE.length} 个，`
    + `原文 ${TEXT_CASES.length} 例，快照 ${SNAPSHOT_CASES.length} 例）`);
  if (args.writeReport) {
    writeReport(REPORT, errors.length > 0, {
      scope: "JKRD7 §2/§3/§5/§6.4/§8 static rules, bit spelling in the JSON source text, §9.5 snapshot checks, document JSON, "
        + "model asset, fixtures, display-page examples, links and index; "
        + "no execution (see reports/reference-run.json and reports/gpu-run.json)",
      checks: checker.items,
      errors,
    }, [...checker.files, "tools/validate.ts", "src/model.ts", "src/doc.ts", "src/testing/static.ts", "src/testing/fixtures.ts"]);
  }
  return errors.length ? 1 : 0;
}

process.exitCode = main();
