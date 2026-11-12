/**
 * GPU 后端对拍：在 WebGPU 上从初值整段执行运行脚本（每个实例一个调用），与 CPU 后端逐字节比较。
 * CPU 参考在 Worker 中计算；同一模型的 GPU 管线缓存复用（输出观察取自模型的 output，§8.1）。
 */

import type { Model, RunScript } from "../../src/model.ts";
import { formatRecords } from "../../src/record.ts";
import { GpuExecutor } from "../../src/gpu/backend.ts";
import { type GpuSnapshotResult, runWithSnapshots } from "../../snapshot/gpu.ts";
import type { Loaded } from "./state.ts";

export interface GpuRunResult {
  /** 结果说明。 */
  text: string;
  /** 是否与 CPU 后端逐字节相同。 */
  same: boolean;
  /** 第一个实例的执行记录（出错时为 null）。 */
  records: string | null;
  dispatches: number;
  /** 各实例的结果：执行记录与运行结束时从 GPU 状态缓冲区读回的快照（页面可切换显示）。 */
  results: GpuSnapshotResult[];
}

export class GpuRunner {
  private cache: { device: GPUDevice; model: Model; executor: GpuExecutor } | null = null;
  private worker: Worker | null = null;
  private pending = new Map<number, (data: { records?: string; ms?: number; error?: string }) => void>();
  private nextId = 0;

  /** CPU 后端的参考记录（Worker 中计算）。 */
  private reference(script: RunScript, model: unknown): Promise<{ records: string; ms: number }> {
    if (!this.worker) {
      const worker = new Worker(new URL("./cpu-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = ({ data }: MessageEvent<{ id: number; records?: string; ms?: number; error?: string }>) => {
        this.pending.get(data.id)?.(data);
        this.pending.delete(data.id);
      };
      worker.onerror = (event) => {
        for (const done of this.pending.values()) done({ error: event.message || "CPU 参考计算失败" });
        this.pending.clear();
      };
      this.worker = worker;
    }
    const id = ++this.nextId;
    return new Promise((ok, fail) => {
      this.pending.set(id, (data) => (data.error !== undefined ? fail(new Error(data.error)) : ok({ records: data.records ?? "", ms: data.ms ?? 0 })));
      this.worker!.postMessage({ id, script, model });
    });
  }

  private async executor(device: GPUDevice, model: Model): Promise<GpuExecutor> {
    const cached = this.cache;
    if (cached && cached.device === device && cached.model === model) return cached.executor;
    this.reset();
    const executor = await GpuExecutor.create(device, model);
    this.cache = { device, model, executor };
    return executor;
  }

  async run(device: GPUDevice, loaded: Loaded, script: RunScript, count: number): Promise<GpuRunResult> {
    const [reference, gpu] = await Promise.all([this.reference(script, loaded.raw), this.executor(device, loaded.model)]);
    const results = await runWithSnapshots(gpu, Array.from({ length: count }, () => ({ batches: script.batches })));
    const dispatches = gpu.stats.dispatches;
    const failed = results.find((r) => r.error);
    if (failed?.error) {
      return { text: `GPU 实例出错：${failed.error.message}（第 ${failed.error.batch + 1} 批）。`, same: false, records: null, dispatches, results };
    }
    const texts = results.map((r) => formatRecords(r.records));
    const mismatch = texts.findIndex((text) => text !== reference.records);
    if (mismatch >= 0) {
      const a = texts[mismatch].split("\n");
      const b = reference.records.split("\n");
      const line = a.findIndex((text, i) => text !== b[i]) + 1;
      return { text: `第 ${mismatch + 1} 个实例的执行记录与 CPU 后端不同（自第 ${line} 行起）。`, same: false, records: texts[0], dispatches, results };
    }
    const lines = reference.records ? reference.records.split("\n").length - 1 : 0;
    return {
      text: `${count} 个实例的执行记录与 CPU 后端逐字节相同 · 每个实例 ${lines} 行 · GPU ${gpu.stats.milliseconds.toFixed(1)} ms`
        + `（${dispatches} 次调度）· CPU 单实例 ${reference.ms.toFixed(1)} ms（Worker）`,
      same: true, records: texts[0], dispatches, results,
    };
  }

  /** 换模型或设备时释放缓存的管线。 */
  reset(): void {
    this.cache?.executor.destroy();
    this.cache = null;
  }

  dispose(): void {
    this.reset();
    this.worker?.terminate();
    this.worker = null;
  }
}
