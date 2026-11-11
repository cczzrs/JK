/**
 * 浏览器页面脚本：在 WebGPU 上运行 GPU 后端的验收案例，或按任务运行一个运行脚本。
 * 由 tools/gpu.ts 自动打开时从 /__job 取任务并把结果交回 /__result；手动打开时直接运行验收案例。
 */

import { type Jkm, type RunScript, type Snapshot, parseJson } from "../src/model.ts";
import { docBlock } from "../src/doc.ts";
import { scriptModel } from "../src/executor.ts";
import { formatRecords } from "../src/record.ts";
import { GpuExecutor, type GpuOptions, requestDevice } from "../src/gpu/backend.ts";
import { gpuThroughput, runGpuCases } from "../src/testing/gpu-cases.ts";

type Job =
  | { mode: "check"; count?: number }
  | { mode: "script"; script: RunScript; model: unknown; start?: Snapshot; options?: GpuOptions };

const out = document.getElementById("log")!;
const job = (await (await fetch("/__job")).json()) as Job | null;
const automated = job !== null;

function log(line: string): void {
  out.textContent += line + "\n";
  if (automated) void fetch("/__log", { method: "POST", body: line });
}

async function finish(result: unknown): Promise<void> {
  if (automated) await fetch("/__result", { method: "POST", body: JSON.stringify(result) });
}

async function text(path: string): Promise<string> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`无法读取 ${path}`);
  return res.text();
}

try {
  const { adapter, device } = await requestDevice();
  device.addEventListener("uncapturederror", (e) => log("WebGPU 错误：" + (e as GPUUncapturedErrorEvent).error.message));
  const info = adapter.info;
  const adapterInfo = { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description };
  log(`WebGPU 适配器：${JSON.stringify(adapterInfo)}`);

  const task: Job = job ?? { mode: "check" };
  if (task.mode === "script") {
    const model = scriptModel(task.script, task.model); // 与 CPU 后端相同的模型与运行脚本检查
    const r = await GpuExecutor.runScript(device, model, task.script, task.start, task.options);
    await finish({ records: formatRecords(r.records), error: r.error, snapshot: r.snapshot });
  } else {
    const doc = await text("/JKRD7.md");
    const ascii = parseJson(await text("/assets/ascii-bit-design/digits.jkm.json")) as Jkm;
    const script = docBlock<RunScript>(doc, "run");
    const cache = new Map<string, unknown>([[script.model, parseJson(await text("/" + script.model))]]);
    const ctx = {
      doc, ascii,
      loadModel: (path: string) => {
        if (!cache.has(path)) throw new Error(`页面没有预先读取 ${path}`);
        return cache.get(path);
      },
    };
    const cases = await runGpuCases(ctx, device, log);
    const t = await gpuThroughput(ctx, device, task.count ?? 16384);
    log(`吞吐参考：十选一 ${t.instances} 个实例（每个一批 3 个重叠请求，每实例占 ${t.bytesPerInstance} 字节），GPU 后端 ${t.gpuMs.toFixed(0)} ms`
      + `（其中 GPU 执行与取回 ${t.kernelMs.toFixed(0)} ms、主机解码记录 ${t.decodeMs.toFixed(0)} ms，调度 ${t.dispatches} 次），`
      + `同一页面的 CPU 后端 ${t.cpuMs.toFixed(0)} ms，记录${t.same ? "全部相同" : "不同"}`);
    const passed = cases.filter((c) => c.passed).length;
    log(`\n${passed}/${cases.length} 项通过`);
    await finish({
      adapter: adapterInfo,
      limits: {
        maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
        maxBufferSize: device.limits.maxBufferSize,
        maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
      },
      userAgent: navigator.userAgent,
      cases,
      throughput: t,
    });
  }
  device.destroy();
} catch (e) {
  const message = e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e);
  log("失败：" + message);
  await finish({ fatal: message });
}
