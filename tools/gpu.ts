/**
 * GPU 后端命令行：启动本机 Chrome，在 WebGPU 上运行。
 *
 *   node tools/gpu.ts                         运行 GPU 验收案例（与 CPU 后端逐字节对拍）
 *   node tools/gpu.ts --write-report          同时写入 reports/gpu-run.json
 *   node tools/gpu.ts --script RUN.json [--start SNAPSHOT.json] [--save SNAPSHOT.json]
 *                                             用 GPU 后端运行一个运行脚本，输出执行记录（JSON 行）
 *
 * 其他参数：--chrome <路径>（或环境变量 CHROME）、--headed（显示浏览器窗口）、--timeout <秒>、
 * --count <实例数>（吞吐参考的实例数）。
 */

import type { RunScript, Snapshot } from "../src/model.ts";
import { formatSnapshot } from "../src/record.ts";
import { SOURCE_FILES, exists, nowUtc, readJson, sha256, writeText } from "./common.ts";
import { serve } from "./server.ts";
import { runInChrome } from "./chrome.ts";

const REPORT = "reports/gpu-run.json";

interface Args {
  script?: string;
  start?: string;
  save?: string;
  chrome?: string;
  headed: boolean;
  writeReport: boolean;
  timeout: number;
  count?: number;
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
    if (a === "--script") args.script = value();
    else if (a === "--start") args.start = value();
    else if (a === "--save") args.save = value();
    else if (a === "--chrome") args.chrome = value();
    else if (a === "--timeout") args.timeout = Number(value());
    else if (a === "--count") args.count = Number(value());
    else if (a === "--headed") args.headed = true;
    else if (a === "--write-report") args.writeReport = true;
    else throw new Error(`未知参数 ${a}`);
  }
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  let job: unknown;
  let script: RunScript | undefined;
  if (args.script) {
    script = readJson<RunScript>(args.script);
    job = {
      mode: "script", script, model: readJson(script.model),
      start: args.start ? readJson<Snapshot>(args.start) : undefined,
    };
  } else {
    job = { mode: "check", count: args.count };
  }

  const served = await serve({ job, onLog: (line) => (script ? undefined : console.log(line)) });
  const result = await runInChrome(`${served.url}/web/index.html`, served, args);

  if (result.fatal) {
    console.error("GPU 运行失败：" + String(result.fatal));
    return 1;
  }
  if (script) {
    process.stdout.write(String(result.records));
    if (result.error) {
      console.error("GPU 实例出错：" + JSON.stringify(result.error));
      return 1;
    }
    if (args.save && result.snapshot) {
      writeText(args.save, formatSnapshot({ ...(result.snapshot as Snapshot), snapshot: script.run }));
    }
    return 0;
  }

  const cases = result.cases as { case: string; passed: boolean; detail: string }[];
  const failed = cases.filter((c) => !c.passed);
  if (args.writeReport) {
    const files = ["JKRD7.md", "assets/ascii-bit-design/digits.jkm.json", "tools/gpu.ts", "web/gpu.ts",
      "src/testing/gpu-cases.ts", ...SOURCE_FILES].filter(exists);
    const report = {
      status: failed.length ? "failed" : "passed",
      generated_at_utc: nowUtc(),
      semantics: "GPU backend (WebGPU, one invocation per instance, serial micro-steps of JKRD7 §7) compared byte for byte "
        + "with the CPU backend in the same page: records, end-of-run snapshots, snapshot resume, capacity errors",
      scope: "single-thread models; this machine's Chrome and GPU only; throughput figures are indicative, not a benchmark",
      adapter: result.adapter,
      limits: result.limits,
      user_agent: result.userAgent,
      cases,
      throughput: result.throughput,
      sha256: Object.fromEntries(files.map((p) => [p, sha256(p)])),
    };
    writeText(REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(`报告已写入 ${REPORT}`);
  }
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
