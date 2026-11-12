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
import type { Jkm, RunScript } from "../src/model.ts";
import { type Snapshot, formatSnapshot } from "../snapshot/snapshot.ts";
import { resumeSnapshot, takeSnapshot } from "../snapshot/cpu.ts";
import { runScriptCpu } from "../src/executor.ts";
import { formatRecords } from "../src/record.ts";
import { runCases } from "../src/testing/cases.ts";
import { ASCII_MODEL, DOC, SNAPSHOT_DOC, SOURCE_FILES, parseArgs, readJson, readText, rel, writeReport, writeText } from "./common.ts";

const REPORT = "reports/reference-run.json";

function main(): number {
  const args = parseArgs(process.argv.slice(2), {
    script: "value", model: "value", inject: "list", start: "value", save: "value", batch: "flag", writeReport: "flag",
  });
  if (args.script || args.model) {
    // --script 给出运行脚本；--model 与 --inject 把这些输入作为一批
    const script: RunScript = args.script ? readJson<RunScript>(args.script) : {
      run: basename(args.model!, extname(args.model!)),
      model: rel(args.model!),
      batches: args.inject.length ? [args.inject] : [],
    };
    const start = args.start ? readJson<Snapshot>(args.start) : undefined;
    const ref = runScriptCpu(script, readJson(script.model), { batch: args.batch, before: start && ((ex) => resumeSnapshot(ex, start)) });
    process.stdout.write(formatRecords(ref.record()));
    if (args.save) writeText(args.save, formatSnapshot(takeSnapshot(ref, script.run)));
    return 0;
  }

  const results = runCases({
    doc: readText(DOC),
    snapshotDoc: readText(SNAPSHOT_DOC),
    ascii: readJson<Jkm>(ASCII_MODEL),
    loadModel: (path) => readJson(path),
  });
  const failed = results.filter((r) => !r.passed);
  for (const r of results) console.log(`${r.passed ? "通过" : "失败"}  ${r.case}：${r.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (args.writeReport) {
    writeReport(REPORT, failed.length > 0, {
      semantics: "JKRD7 §4–§7 serial reference (CPU backend): one unit at a time, event-first, path-ordered delivery, "
        + "JKS integration, transactions with their own FIFOs, nested transactions executed layer by layer, transaction limits; "
        + "§7.5 batches; §8.1 output list drives the output records; §9.4 run scripts and records; snapshots (snapshot/Snapshot.md)",
      scope: "single-thread models; CPU backend in TypeScript on Node; GPU backend is checked separately (reports/gpu-run.json)",
      cases: results,
    }, [DOC, SNAPSHOT_DOC, ASCII_MODEL, "tools/reference.ts", ...SOURCE_FILES]);
  }
  return failed.length ? 1 : 0;
}

process.exitCode = main();
