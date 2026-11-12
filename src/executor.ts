/**
 * 按运行脚本（JKRD7 §9.4）运行 CPU 后端（默认后端，串行参考）。
 * GPU 后端按运行脚本运行的入口是 gpu/backend.ts 的 GpuExecutor.runScript；
 * 两个后端对同一运行脚本必须产生逐字节相同的执行记录（§7.5）。
 */

import { type RunScript, Model, checkRunScript } from "./model.ts";
import { CpuExecutor } from "./cpu.ts";

export interface ScriptOptions {
  /** 按 §7.5 的可并行批执行。 */
  batch?: boolean;
  /** 注入第一批之前对执行器做的准备（例如 snapshot/cpu.ts 载入快照）。 */
  before?: (ex: CpuExecutor) => void;
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
  const ref = new CpuExecutor(scriptModel(script, data), { batch: options.batch }); // 输出观察取自模型的 output（§8.1）
  options.before?.(ref);
  for (const batch of script.batches) {
    for (const item of batch) ref.inject(item);
    ref.run();
  }
  return ref;
}
