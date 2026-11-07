/**
 * CPU 后端（串行参考）命令行：验收案例（JKRD7 §11.2）与运行脚本（§9.4）。
 *
 *   node tools/reference.ts                      运行验收案例
 *   node tools/reference.ts --write-report       同时写入 reports/reference-run.json
 *   node tools/reference.ts --script RUN.json [--batch] [--start SNAPSHOT.json] [--save SNAPSHOT.json]
 *                                                输出运行脚本的执行记录（JSON 行）
 *   node tools/reference.ts --model M.json --inject G1.Q1 G1.Q2 …   把这些输入作为一批运行
 */

import { basename, extname } from "node:path";
import type { Jkm, RunScript, Snapshot } from "../src/model.ts";
import { runScriptCpu } from "../src/executor.ts";
import { formatRecords, formatSnapshot } from "../src/record.ts";
import { runCases } from "../src/testing/cases.ts";
import { ASCII_MODEL, DOC, SOURCE_FILES, exists, nowUtc, readJson, readText, rel, sha256, writeText } from "./common.ts";

const REPORT = "reports/reference-run.json";

interface Args {
  script?: string;
  model?: string;
  inject: string[];
  start?: string;
  save?: string;
  batch: boolean;
  writeReport: boolean;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { inject: [], batch: false, writeReport: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} 需要一个参数`);
      return v;
    };
    if (a === "--script") args.script = value();
    else if (a === "--model") args.model = value();
    else if (a === "--start") args.start = value();
    else if (a === "--save") args.save = value();
    else if (a === "--batch") args.batch = true;
    else if (a === "--write-report") args.writeReport = true;
    else if (a === "--inject") while (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args.inject.push(argv[++i]);
    else throw new Error(`未知参数 ${a}`);
  }
  return args;
}

/** --script 或 --model/--inject 给出的运行脚本。 */
export function scriptFromArgs(args: Args): RunScript {
  if (args.script) return readJson<RunScript>(args.script);
  const model = args.model!;
  return {
    run: basename(model, extname(model)),
    model: rel(model),
    observe: { watch: [], read: [] },
    batches: args.inject.length ? [args.inject] : [],
  };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  if (args.script || args.model) {
    const script = scriptFromArgs(args);
    const start = args.start ? readJson<Snapshot>(args.start) : undefined;
    const ref = runScriptCpu(script, readJson(script.model), { batch: args.batch, start });
    process.stdout.write(formatRecords(ref.record()));
    if (args.save) writeText(args.save, formatSnapshot(ref.snapshot(script.run)));
    return 0;
  }

  const results = runCases({
    doc: readText(rel(DOC)),
    ascii: readJson<Jkm>(rel(ASCII_MODEL)),
    loadModel: (path) => readJson(path),
  });
  const failed = results.filter((r) => !r.passed);
  for (const r of results) console.log(`${r.passed ? "通过" : "失败"}  ${r.case}：${r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (args.writeReport) {
    const files = ["JKRD7.md", rel(ASCII_MODEL), "tools/reference.ts", ...SOURCE_FILES].filter(exists);
    const report = {
      status: failed.length ? "failed" : "passed",
      generated_at_utc: nowUtc(),
      semantics: "JKRD7 §4–§7 serial reference (CPU backend): one unit at a time, event-first, path-ordered delivery, "
        + "JKS integration, transactions with local sequences and a single commit; §7.5 batches; "
        + "§9.4 run scripts and records; §9.5 snapshots",
      scope: "single-queue models; CPU backend in TypeScript on Node; GPU backend is checked separately (reports/gpu-run.json)",
      cases: results,
      sha256: Object.fromEntries(files.map((p) => [p, sha256(p)])),
    };
    writeText(REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(`报告已写入 ${REPORT}`);
  }
  return failed.length ? 1 : 0;
}

if (import.meta.main) process.exitCode = main();
