/**
 * GPU 后端的验收案例（WebGPU.md §9）：在浏览器中运行，与同一页面里的 CPU 后端逐字节对拍。
 * 命令行见 tools/gpu.ts（启动本机 Chrome 执行）。
 */

import { Model, type RunScript, type Snapshot, docBlock, docModels } from "../model.ts";
import { CpuExecutor, type CpuOptions, TxLimit } from "../cpu.ts";
import { runScriptCpu } from "../executor.ts";
import { bitsToInt, formatRecords, formatSnapshot } from "../record.ts";
import { GpuExecutor, type GpuInstance, type GpuOptions } from "../gpu/backend.ts";
import { type CaseContext, type CaseResult, DOC_RUNS } from "./cases.ts";
import {
  ASCII_DONE, asciiBatches, clone, exitLoopModel, inlineModel, nestOrderModel, randomBatches, randomModel, runBatches,
} from "./fixtures.ts";
import { Random } from "./random.ts";

/** CPU 后端按 GPU 实例的方式运行：可选起始快照，然后逐批注入并运行到静止。 */
function cpuInstance(data: unknown, inst: GpuInstance): CpuExecutor {
  const ref = new CpuExecutor(new Model(data, "cpu"));
  if (inst.start) ref.loadSnapshot(inst.start);
  for (const batch of inst.batches) {
    for (const item of batch) ref.inject(item);
    ref.run();
  }
  return ref;
}

/** 在 GPU 上执行一组实例，并与 CPU 逐个比较执行记录和结束时的快照。返回不一致的实例数。 */
async function compare(device: GPUDevice, data: unknown, instances: GpuInstance[],
  options: GpuOptions = {}): Promise<{ bad: number; gpu: GpuExecutor; firstBad?: string }> {
  const gpu = await GpuExecutor.create(device, new Model(data, "gpu"), options);
  try {
    const results = await gpu.run(instances);
    let bad = 0;
    let firstBad: string | undefined;
    instances.forEach((inst, i) => {
      const cpu = cpuInstance(data, inst);
      const r = results[i];
      const sameRecords = formatRecords(cpu.record()) === formatRecords(r.records);
      const sameSnap = r.snapshot !== null && formatSnapshot(cpu.snapshot("S1")) === formatSnapshot(r.snapshot);
      if (r.error || !sameRecords || !sameSnap) {
        bad++;
        firstBad ??= r.error ? `实例 ${i}：${r.error.message}` : `实例 ${i}：${sameRecords ? "快照" : "执行记录"}不同`;
      }
    });
    return { bad, gpu, firstBad };
  } finally {
    gpu.destroy();
  }
}

export async function runGpuCases(ctx: CaseContext, device: GPUDevice, log: (line: string) => void = () => {}): Promise<CaseResult[]> {
  const models = docModels(ctx.doc);
  const results: CaseResult[] = [];
  const check = (name: string, passed: boolean, detail: string) => {
    results.push({ case: name, passed, detail });
    log(`${passed ? "通过" : "失败"}  ${name}：${detail}`);
  };

  // 第 10 节模型
  {
    let bad = 0;
    for (const [name, inj] of DOC_RUNS) {
      bad += (await compare(device, models.get(name), [{ batches: [inj] }])).bad;
    }
    bad += (await compare(device, inlineModel(), [{ batches: [["G1.Q1", "G1.Q1"]] }, { batches: [["G1.Q1"], ["G1.Q1"]] }])).bad;
    bad += (await compare(device, nestOrderModel(), [{ batches: [["G1.Q1"]] }, { batches: [["G1.Q1", "G1.Q1"]] }])).bad;
    bad += (await compare(device, exitLoopModel("one_changed"), [{ batches: [["G1.Q1"], ["G1.Q1", "G1.Q1"]] }])).bad;
    check("GPU：第 10 节模型", bad === 0,
      `M_FLOW、M_PATH、M_SYNC、M_TX、M_NEST、M_REG 共 ${DOC_RUNS.length} 个，另加嵌套事务 M_INLINE、M_NEST2 与带退出结构的环 M_EXIT，`
      + `执行记录或结束快照不同的有 ${bad} 个`);
  }

  // 运行脚本（§9.4）
  {
    const script = docBlock<RunScript>(ctx.doc, "run");
    const data = ctx.loadModel(script.model);
    const cpu = runScriptCpu(script, data);
    const gpu = await GpuExecutor.runScript(device, new Model(data, script.model), script);
    const codes = gpu.records.flatMap((e) => ("output" in e && e.output === ASCII_DONE ? [bitsToInt(e.values.data)] : []));
    const same = formatRecords(cpu.record()) === formatRecords(gpu.records);
    check("GPU：运行脚本（§9.4）", same && JSON.stringify(codes) === JSON.stringify([0x30, 0x31, 0x39]),
      `Q24 的输出记录 ${JSON.stringify(codes.map((c) => "0x" + c.toString(16)))}，${gpu.records.length} 条执行记录${same ? "与 CPU 逐字节相同" : "与 CPU 不同"}`);
  }

  // 十选一：一次运行 1000 个实例
  {
    const rng = new Random(11);
    const instances = Array.from({ length: 1000 }, () => ({ batches: asciiBatches(rng) }));
    const { bad, gpu, firstBad } = await compare(device, ctx.ascii, instances);
    check("GPU：十选一多实例", bad === 0,
      `一次运行 ${instances.length} 个实例（各自 1—3 批、每批 1—4 个重叠请求），与 CPU 不同的有 ${bad} 个${firstBad ? `（${firstBad}）` : ""}；`
      + `调度 ${gpu.stats.dispatches} 次`);
  }

  // 随机模型
  {
    const rng = new Random(13);
    let bad = 0;
    let first: string | undefined;
    for (let i = 0; i < 300; i++) {
      const data = randomModel(rng);
      const instances = Array.from({ length: 4 }, () => ({ batches: randomBatches(rng) }));
      const r = await compare(device, data, instances);
      bad += r.bad;
      first ??= r.firstBad && `模型 ${i} ${r.firstBad}`;
    }
    check("GPU：随机模型", bad === 0, `300 个随机模型、每个 4 个实例，执行记录或结束快照与 CPU 不同的有 ${bad} 个${first ? `（${first}）` : ""}`);
  }

  // 从快照继续
  {
    const docSnap = docBlock<Snapshot>(ctx.doc, "snapshot");
    const tx = models.get("M_TX")!;
    let bad = (await compare(device, tx, [{ start: docSnap, batches: [[]] }, { start: docSnap, batches: [[], ["G1.Q10"]] }])).bad;
    const rng = new Random(17);
    let pending = 0;
    for (let i = 0; i < 150; i++) {
      const data = randomModel(rng);
      const batches = randomBatches(rng);
      const cpu = new CpuExecutor(new Model(data, "random"));
      for (const item of batches[0]) cpu.inject(item);
      for (let k = rng.randint(0, 25); k > 0; k--) cpu.step();
      const snap = JSON.parse(JSON.stringify(cpu.snapshot())) as Snapshot;
      const thread = Object.values(snap.threads)[0];
      if (thread && (thread.events.length || thread.tasks.length)) pending++;
      bad += (await compare(device, data, [{ start: snap, batches: [[], ...batches.slice(1)] }])).bad;
    }
    check("GPU：从快照继续", bad === 0,
      `§9.5 的 M_TX 快照与随机模型 150 次中途快照（其中 ${pending} 次带未处理的事件或任务）载入 GPU 后继续运行，与 CPU 不同的有 ${bad} 个`);
  }

  // 容量与错误
  {
    const gpu = await GpuExecutor.create(device, new Model(ctx.ascii, "ascii"), { capacity: { events: 6 } });
    const many = Array.from({ length: 9 }, (_, d) => `G1.Q${d + 1}`);
    const instances: GpuInstance[] = [{ batches: [many] }, { batches: [["G1.Q4"]] }];
    const [overflow, normal] = await gpu.run(instances);
    gpu.destroy();
    const cpu = runBatches(ctx.ascii, [["G1.Q4"]]);
    const limited = await GpuExecutor.create(device, new Model(ctx.ascii, "ascii"), { stepLimit: 10 });
    const [stepped] = await limited.run([{ batches: [["G1.Q1"]] }]);
    limited.destroy();
    // 事务的上限（JKRD7 §6.4）：GPU 与 CPU 停在同一步，报告同样的错误，已有记录相同
    const txLimit = async (data: unknown, cpuOptions: CpuOptions, gpuOptions: GpuOptions, code: number) => {
      const ref = new CpuExecutor(new Model(data, "cpu"), cpuOptions);
      ref.inject("G1.Q1");
      let message = "";
      try {
        ref.run();
      } catch (e) {
        if (!(e instanceof TxLimit)) throw e;
        message = e.message;
      }
      const gpuLimit = await GpuExecutor.create(device, new Model(data, "gpu"), gpuOptions);
      const [r] = await gpuLimit.run([{ batches: [["G1.Q1"]] }]);
      gpuLimit.destroy();
      return { same: r.error?.code === code && message.startsWith(r.error.message) && formatRecords(r.records) === formatRecords(ref.record()),
        message: r.error?.message ?? "无" };
    };
    const txSteps = await txLimit(exitLoopModel("always_changed"), { txSteps: 50 }, { txSteps: 50 }, 9);
    const txDepth = await txLimit(inlineModel(), { txDepth: 2 }, { capacity: { depth: 2 } }, 8);
    const ok = overflow.error?.code === 1 && overflow.snapshot === null && normal.error === null
      && formatRecords(normal.records) === formatRecords(cpu.record()) && stepped.error?.code === 6 && txSteps.same && txDepth.same;
    check("GPU：容量与错误", ok,
      `事件 FIFO 容量设为 6 时，一批 9 个输入的实例报告“${overflow.error?.message ?? "无"}”并停下，同一次运行中的另一个实例`
      + `${normal.error === null && formatRecords(normal.records) === formatRecords(cpu.record()) ? "不受影响，记录与 CPU 相同" : "受到影响"}；`
      + `步数上限设为 10 时报告“${stepped.error?.message ?? "无"}”；事务步数上限设为 50、嵌套层数上限设为 2 时，分别报告`
      + `“${txSteps.message}”“${txDepth.message}”，${txSteps.same && txDepth.same ? "停下的位置与已有记录都与 CPU 相同" : "与 CPU 不同"}`);
  }

  return results;
}

/** 吞吐参考：十选一，每个实例一批 3 个重叠请求。返回说明文字（本机实测，只作参考）。 */
export async function gpuThroughput(ctx: CaseContext, device: GPUDevice, count = 16384): Promise<{
  instances: number; gpuMs: number; kernelMs: number; decodeMs: number; cpuMs: number; dispatches: number; same: boolean;
  bytesPerInstance: number;
}> {
  const rng = new Random(19);
  const instances = Array.from({ length: count }, () => ({
    batches: [Array.from({ length: 3 }, () => `G1.Q${rng.randint(1, 10)}`)],
  }));
  const capacity = { events: 32, tasks: 32, localEvents: 32, localTasks: 32, depth: 1, records: 1024 };
  const gpu = await GpuExecutor.create(device, new Model(ctx.ascii, "ascii"), { capacity });
  await gpu.run(instances.slice(0, 64)); // 预热
  const t0 = performance.now();
  const results = await gpu.run(instances);
  const gpuMs = performance.now() - t0;
  const { dispatches, gpuMilliseconds: kernelMs, decodeMilliseconds: decodeMs } = gpu.stats;
  const bytesPerInstance = gpu.bytesPerInstance(4);
  gpu.destroy();
  const data = clone(ctx.ascii);
  const t1 = performance.now();
  const cpu = instances.map((inst) => runBatches(data, inst.batches));
  const cpuMs = performance.now() - t1;
  const same = cpu.every((c, i) => formatRecords(c.record()) === formatRecords(results[i].records));
  return { instances: count, gpuMs, kernelMs, decodeMs, cpuMs, dispatches, same, bytesPerInstance };
}
