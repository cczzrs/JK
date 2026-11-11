/**
 * 展示页验收：启动本机 Chrome 打开 web/show/index.html，通过页面控件执行运行脚本（跳过动画、逐单元动画、
 * 发送输入＋单步）与 GPU 对拍，把页面导出的执行记录和页面显示的状态，同 CPU 后端（src/executor.ts）的结果比较。
 *
 *   node tools/show.ts                 运行验收
 *   node tools/show.ts --write-report  同时写入 reports/show-run.json
 *
 * 其他参数：--chrome <路径>（或环境变量 CHROME）、--headed（显示浏览器窗口）、--timeout <秒>。
 */

import { type Bit, type Jkm, type RunScript, Model, docBlock, docModels, isInputEntry, sortPaths } from "../src/model.ts";
import { formatRecords } from "../src/record.ts";
import { runScriptCpu } from "../src/executor.ts";
import { CpuExecutor, TxLimit } from "../src/cpu.ts";
import { exitLoopModel } from "../src/testing/fixtures.ts";
import { ASCII_MODEL, DOC, SOURCE_FILES, exists, nowUtc, readJson, readText, sha256, writeText } from "./common.ts";
import { serve } from "./server.ts";
import { runInChrome } from "./chrome.ts";
import type { CaseResult, ShowCase, ShowJob } from "../web/show/verify.ts";

const REPORT = "reports/show-run.json";
/** 第 10 节的示例（工厂附录不在内）。 */
const DOC_EXAMPLES = ["M_FLOW", "M_PATH", "M_SYNC", "M_TX", "M_NEST", "M_REG"];

interface Args {
  chrome?: string;
  headed: boolean;
  writeReport: boolean;
  timeout: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { headed: false, writeReport: false, timeout: 600 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} 需要一个参数`);
      return v;
    };
    if (a === "--chrome") args.chrome = value();
    else if (a === "--timeout") args.timeout = Number(value());
    else if (a === "--headed") args.headed = true;
    else if (a === "--write-report") args.writeReport = true;
    else throw new Error(`未知参数 ${a}`);
  }
  return args;
}

type Kind = ShowCase["kind"];

function qOf(ex: CpuExecutor): Record<string, Bit> {
  return Object.fromEntries(sortPaths(ex.q.keys()).map((p) => [p, ex.q.get(p)!]));
}

function expectation(ex: CpuExecutor): Omit<ShowCase, "name" | "kind" | "script"> {
  const counts: Record<string, number> = {};
  for (const e of ex.log) if (e.kind === "q") counts[e.path] = (counts[e.path] ?? 0) + 1;
  return {
    expected: formatRecords(ex.record()), units: ex.units, outputs: ex.outputs.length, q: qOf(ex), counts,
    observeNodes: ex.m.output.length,
  };
}

/** 用 CPU 后端（与 node tools/reference.ts --script 相同的入口）得到页面应当显示的结果。 */
function showCase(name: string, kind: Kind, example: string, data: Jkm, script: RunScript, extra: Partial<ShowCase> = {}): ShowCase {
  return { name, kind, example, script, ...expectation(runScriptCpu(script, data)), ...extra };
}

/** 按运行脚本的方式执行，记下第 k 个处理单元完成时的 q（下一批输入注入之前）。 */
function qAtUnits(data: Jkm, script: RunScript, ks: readonly number[]): Map<number, Record<string, Bit>> {
  const ex = new CpuExecutor(new Model(data, script.model));
  const out = new Map<number, Record<string, Bit>>();
  if (ks.includes(0)) out.set(0, qOf(ex));
  for (const batch of script.batches) {
    for (const p of batch) ex.inject(p);
    while (ex.step()) if (ks.includes(ex.units)) out.set(ex.units, qOf(ex));
  }
  return out;
}

/** 每个处理单元的步数：执行细节中 take 的个数（投递一条事件或执行一个任务各算一步）。 */
function unitSteps(data: Jkm, script: RunScript): number[] {
  const ex = new CpuExecutor(new Model(data, script.model));
  let takes = 0;
  ex.trace = (e) => {
    if (e.kind === "take") takes++;
  };
  const out: number[] = [];
  for (const batch of script.batches) {
    for (const p of batch) ex.inject(p);
    for (;;) {
      takes = 0;
      if (!ex.step()) break;
      out.push(takes);
    }
  }
  return out;
}

function buildCases(): ShowCase[] {
  const doc = readText(DOC);
  const models = docModels(doc);
  const cases: ShowCase[] = [];
  const ascii = readJson<Jkm>(ASCII_MODEL);
  const asciiScript = docBlock<RunScript>(doc, "run");
  cases.push(showCase("十选一 ASCII：JKRD7 §9.4 运行脚本，GPU 64 个实例对拍", "script", "ASCII_DIGITS", ascii, asciiScript, { gpu: 64 }));
  const scripts = new Map<string, RunScript>();
  for (const name of DOC_EXAMPLES) {
    const data = models.get(name);
    if (!data) throw new Error(`JKRD7 中没有 ${name}`);
    const model = new Model(data, name);
    const paths = sortPaths(model.jki.keys());
    const inputs = paths.filter((p) => isInputEntry(model, p));
    // 输出观察取自各模型的 output（§8.1）。
    const script: RunScript = {
      run: `show-${name}`, model: `${name}.jkm.json`,
      batches: [...inputs.map((p) => [p]), ...(inputs.length > 1 ? [inputs] : []), [inputs[0]]],
    };
    scripts.set(name, script);
    cases.push(showCase(`${name}：运行脚本 ${script.batches.length} 批，GPU 2 个实例对拍`, "script", name, data, script, { gpu: 2 }));
  }
  const flow = models.get("M_FLOW")!;
  const flowScript = { ...scripts.get("M_FLOW")!, run: "show-M_FLOW-animate", batches: [scripts.get("M_FLOW")!.batches[0]] };
  cases.push(showCase("M_FLOW：关闭跳过动画，逐单元播放", "animate", "M_FLOW", flow, flowScript));
  for (const name of ["M_TX", "M_SYNC", "M_NEST"]) {
    const data = models.get(name)!;
    const script = { ...scripts.get(name)!, run: `show-${name}-manual` };
    cases.push(showCase(`${name}：逐批发送信号，再逐个单步（本单元的步数）`, "manual", name, data, script, { steps: unitSteps(data, script) }));
  }
  // 时间轴：跳到中间、后退一步、再跳回终点。
  const total = runScriptCpu(asciiScript, ascii).units;
  const k = Math.max(1, Math.floor(total / 2));
  const at = qAtUnits(ascii, asciiScript, [k, k - 1]);
  cases.push(showCase(`十选一 ASCII：时间轴跳到第 ${k} 个处理单元、后退、再跳回`, "timeline", "ASCII_DIGITS", ascii, asciiScript,
    { timeline: { k, qAt: at.get(k)!, qBefore: at.get(k - 1)! } }));
  cases.push(showCase("M_NEST：Canvas 2D 渲染下运行，再恢复 WebGPU", "canvas", "M_NEST", models.get("M_NEST")!, scripts.get("M_NEST")!));
  // 图片转输入：2×4 的黑白图，白取第二个入口、黑取第一个入口。
  const reg = models.get("M_REG")!;
  const regModel = new Model(reg, "M_REG");
  const [zero, one] = sortPaths([...regModel.jki.keys()].filter((p) => isInputEntry(regModel, p)));
  const pixels: Bit[] = [1, 0, 1, 1, 0, 0, 1, 0];
  const imageScript: RunScript = { run: "show-run", model: "M_REG.jkm.json", batches: pixels.map((b) => [b ? one : zero]) };
  cases.push(showCase("M_REG：图片转输入（8 个像素）后运行", "image", "M_REG", reg, imageScript, { image: { pixels, width: 4, height: 2, zero, one } }));
  // 事务超限（§6.4）：环有退出结构但永不退出，执行器停在上限之前。
  const loop = exitLoopModel("always_changed");
  const loopScript: RunScript = { run: "show-txlimit", model: "M_EXIT.jkm.json", batches: [["G1.Q1"]] };
  const stopped = new CpuExecutor(new Model(loop, "M_EXIT"), {});
  stopped.inject("G1.Q1");
  try {
    while (stopped.step()) { /* 运行到出错 */ }
  } catch (error) {
    if (!(error instanceof TxLimit)) throw error;
  }
  cases.push({ name: "M_EXIT：事务超过步数上限时停止", kind: "txlimit", model: loop, script: loopScript, ...expectation(stopped), error: "事务超过步数上限" });
  // 旧格式（queue、没有 output）的模型被拒绝。
  const old = { jkm: "OLD", version: "7.0.0", queues: ["work"], roots: [{ id: "G1", queue: "work", trigger: {}, members: [{ id: "Q1", q: 0, trigger: { any: [] } }] }] };
  cases.push({ name: "旧格式模型：静态检查拒绝，当前模型保留", kind: "invalid", model: old, script: asciiScript, expected: "", units: 0, outputs: 0, q: {}, counts: {}, observeNodes: 0, error: "未通过 JKRD7 静态检查" });
  cases.push(showCase("十选一 ASCII：六种布局与 JKS 详情", "layouts", "ASCII_DIGITS", ascii, asciiScript));
  return cases;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const cases = buildCases();
  const job: ShowJob = { mode: "show", cases, timeoutMs: 60000 };
  const served = await serve({ job, onLog: (line) => console.log(line) });
  const result = await runInChrome(`${served.url}/web/show/index.html`, served, args);
  if (result.fatal) {
    console.error("展示页验收失败：" + String(result.fatal));
    return 1;
  }
  const results = result.cases as CaseResult[];
  const failed = results.filter((c) => !c.passed);
  for (const c of failed) console.error(`失败  ${c.case}\n      ${c.detail}`);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过（渲染：${String(result.render)}）`);
  if (args.writeReport) {
    const files = ["JKRD7.md", "assets/ascii-bit-design/digits.jkm.json", "tools/show.ts", "tools/server.ts", "tools/chrome.ts",
      "web/show/index.html", "web/show/main.ts", "web/show/session.ts", "web/show/panels.ts", "web/show/playback.ts",
      "web/show/scene/view.ts", "web/show/verify.ts", ...SOURCE_FILES].filter(exists);
    const report = {
      status: failed.length ? "failed" : "passed",
      generated_at_utc: nowUtc(),
      semantics: "display page (web/show) driven through its own controls: run scripts with and without animation, "
        + "input batches sent between units and stepped one unit at a time (step counts from the executor's trace), "
        + "timeline jump/back/forward by re-execution, Canvas 2D fallback, image-to-input, a transaction stopped at the step limit, "
        + "an old-format model rejected, all layouts, JKS details, GPU backend instances; the page's exported records are compared "
        + "byte for byte with the CPU backend (src/executor.ts), and the displayed units, FIFO sizes, outputs, last history row, "
        + "per-node q in the inspector and q/count labels in the 3D scene with the CPU backend's state",
      scope: "single-thread models from JKRD7 §9.4/§10 and the ASCII attachment; this machine's Chrome and GPU only; "
        + "snapshot export/restore and the shared model pool are not part of the page yet",
      render: result.render,
      user_agent: result.userAgent,
      cases: results,
      sha256: Object.fromEntries(files.map((p) => [p, sha256(p)])),
    };
    writeText(REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(`报告已写入 ${REPORT}`);
  }
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
