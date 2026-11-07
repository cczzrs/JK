/**
 * 执行器入口：按运行脚本（JKRD7 §9.4）运行，后端可选 CPU（默认）或 GPU（WebGPU）。
 * 两个后端对同一运行脚本必须产生逐字节相同的执行记录（§7.5）。
 */

import { type RunScript, type Snapshot, Model, checkRunScript } from "./model.ts";
import { CpuExecutor } from "./cpu.ts";
import type { RecordEntry } from "./record.ts";

export type Backend = "cpu" | "gpu";

export interface ScriptOptions {
  /** CPU 后端：按 §7.5 的可并行批执行。 */
  batch?: boolean;
  /** 从快照（§9.5）继续。 */
  start?: Snapshot;
}

/** 加载并检查运行脚本所指的模型。 */
export function scriptModel(script: RunScript, data: unknown): Model {
  const model = new Model(data, script.model);
  if (model.errors.length) throw new Error("模型未通过静态检查：\n" + model.errors.join("\n"));
  const problems = checkRunScript(script, model);
  if (problems.length) throw new Error("运行脚本不合法：\n" + problems.join("\n"));
  return model;
}

/** 用 CPU 后端运行一个运行脚本，返回运行结束时的执行器。data 是脚本 model 字段所指的 JKM。 */
export function runScriptCpu(script: RunScript, data: unknown, options: ScriptOptions = {}): CpuExecutor {
  const model = scriptModel(script, data);
  const ref = new CpuExecutor(model, { watch: script.observe.watch, read: script.observe.read, batch: options.batch });
  if (options.start) ref.loadSnapshot(options.start);
  for (const batch of script.batches) {
    for (const item of batch) ref.inject(item);
    ref.run();
  }
  return ref;
}

/** 一次运行的结果：执行记录，以及运行结束时的快照。 */
export interface RunResult {
  records: RecordEntry[];
  snapshot: Snapshot;
}
