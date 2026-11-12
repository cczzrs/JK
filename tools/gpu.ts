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

import type { RunScript } from "../src/model.ts";
import { type Snapshot, formatSnapshot } from "../snapshot/snapshot.ts";
import { ASCII_MODEL, DOC, SOURCE_FILES, parseArgs, readJson, writeReport, writeText } from "./common.ts";
import { serve } from "./server.ts";
import { CHROME_ARGS, chromeOptions, runInChrome } from "./chrome.ts";

const REPORT = "reports/gpu-run.json";

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), {
    script: "value", start: "value", save: "value", count: "value", writeReport: "flag", ...CHROME_ARGS,
  });
  let job: unknown;
  let script: RunScript | undefined;
  if (args.script) {
    script = readJson<RunScript>(args.script);
    job = {
      mode: "script", script, model: readJson(script.model),
      start: args.start ? readJson<Snapshot>(args.start) : undefined,
    };
  } else {
    job = { mode: "check", count: args.count === undefined ? undefined : Number(args.count) };
  }

  const served = await serve({ job, onLog: (line) => (script ? undefined : console.log(line)) });
  const result = await runInChrome(`${served.url}/web/index.html`, served, chromeOptions(args));

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
    writeReport(REPORT, failed.length > 0, {
      semantics: "GPU backend (WebGPU, one invocation per instance, serial micro-steps of JKRD7 §7) compared byte for byte "
        + "with the CPU backend in the same page: records, end-of-run snapshots, snapshot resume, capacity errors",
      scope: "single-thread models; this machine's Chrome and GPU only; throughput figures are indicative, not a benchmark",
      adapter: result.adapter,
      limits: result.limits,
      user_agent: result.userAgent,
      cases,
      throughput: result.throughput,
    }, [DOC, ASCII_MODEL, "tools/gpu.ts", "web/gpu.ts", "src/testing/gpu-cases.ts", ...SOURCE_FILES]);
  }
  return failed.length ? 1 : 0;
}

process.exitCode = await main();
