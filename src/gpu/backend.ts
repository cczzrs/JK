/**
 * GPU 后端主机端（WebGPU.md §7）：建立缓冲区、按输入批反复调度内核、取回并解码记录，
 * 以及在快照（JKRD7 §9.5）与 GPU 状态之间转换。
 *
 * 一个调用（invocation）执行一个实例；同一次运行可以同时执行许多实例，每个实例有自己的
 * 输入批和起始快照。只依赖 WebGPU 接口，浏览器中直接使用 navigator.gpu 得到的设备。
 */

import { type Bit, type Model, type RunScript, type Snapshot, checkSnapshot } from "../model.ts";
import { TX_LIMITS, compareRoundKeys } from "../cpu.ts";
import type { RecordEntry } from "../record.ts";
import {
  type Capacity, Compiled, ERRORS, F_INPUT, H, type Layout, NONE, REC_INJECT, REC_NOTIFY, REC_Q, layout,
} from "./compile.ts";
import { PARAM_WORDS, WORKGROUP_SIZE, kernelSource } from "./kernel.ts";

export interface GpuOptions {
  capacity?: Partial<Capacity>;
  /** 每次调度每个实例最多执行的微步数。 */
  budget?: number;
  /** 每批的微步上限；超过时报错并停下该实例。 */
  stepLimit?: number;
  /** 事务的步数上限（JKRD7 §6.4），默认与 CPU 后端相同。 */
  txSteps?: number;
}

export interface GpuInstance {
  batches: readonly (readonly string[])[];
  start?: Snapshot;
}

export interface GpuError {
  code: number;
  message: string;
  /** 出错时所在的输入批（从 0 开始）。 */
  batch: number;
}

export interface GpuResult {
  records: RecordEntry[];
  error: GpuError | null;
  /** 运行结束时的快照；出错的实例没有快照。 */
  snapshot: Snapshot | null;
}

export interface GpuStats {
  dispatches: number;
  instances: number;
  /** run() 的总耗时。 */
  milliseconds: number;
  /** 其中等待 GPU 执行并取回记录缓冲区的时间。 */
  gpuMilliseconds: number;
  /** 其中在主机端解码记录的时间。 */
  decodeMilliseconds: number;
}

const BYTES = 4;

export class GpuExecutor {
  readonly device: GPUDevice;
  readonly l: Layout;
  readonly c: Compiled;
  readonly budget: number;
  readonly stepLimit: number;
  readonly txSteps: number;
  readonly pipeline: GPUComputePipeline;
  readonly modelBuffer: GPUBuffer;
  readonly source: string;
  stats: GpuStats = { dispatches: 0, instances: 0, milliseconds: 0, gpuMilliseconds: 0, decodeMilliseconds: 0 };

  private constructor(device: GPUDevice, l: Layout, pipeline: GPUComputePipeline, source: string, options: GpuOptions) {
    this.device = device;
    this.l = l;
    this.c = l.c;
    this.pipeline = pipeline;
    this.source = source;
    this.budget = options.budget ?? 4096;
    this.stepLimit = options.stepLimit ?? 1_000_000;
    this.txSteps = options.txSteps ?? TX_LIMITS.steps;
    this.modelBuffer = device.createBuffer({
      size: l.modelData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.modelBuffer, 0, l.modelData);
  }

  /** 编译模型并建立计算管线。输出观察取自模型的 output（§8.1）。 */
  static async create(device: GPUDevice, model: Model, options: GpuOptions = {}): Promise<GpuExecutor> {
    const l = layout(new Compiled(model), options.capacity);
    const source = kernelSource(l);
    const module = device.createShaderModule({ code: source });
    const info = await module.getCompilationInfo();
    const errors = info.messages.filter((m) => m.type === "error");
    if (errors.length) {
      throw new Error("WGSL 编译失败：\n" + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("\n"));
    }
    device.pushErrorScope("validation");
    const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
    const problem = await device.popErrorScope();
    if (problem) throw new Error("计算管线创建失败：" + problem.message);
    return new GpuExecutor(device, l, pipeline, source, options);
  }

  /** 运行脚本（§9.4）：一个实例。 */
  static async runScript(device: GPUDevice, model: Model, script: RunScript, start?: Snapshot,
    options: GpuOptions = {}): Promise<GpuResult> {
    const gpu = await GpuExecutor.create(device, model, options);
    try {
      const [result] = await gpu.run([{ batches: script.batches, start }]);
      return result;
    } finally {
      gpu.destroy();
    }
  }

  destroy(): void {
    this.modelBuffer.destroy();
  }

  /** 每个实例占用的字节数（状态、记录、输入）。 */
  bytesPerInstance(inWords: number): number {
    return (this.l.stateWords + this.l.recWords + inWords) * BYTES;
  }

  /** 执行一组实例；实例过多时自动分组，使每个缓冲区不超过设备限制。 */
  async run(instances: readonly GpuInstance[]): Promise<GpuResult[]> {
    const inWords = 1 + Math.max(0, ...instances.flatMap((i) => i.batches.map((b) => b.length)));
    const limits = this.device.limits;
    const maxBinding = Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize);
    const perInstance = Math.max(this.l.stateWords, this.l.recWords, inWords) * BYTES;
    const group = Math.max(1, Math.min(
      Math.floor(maxBinding / perInstance),
      limits.maxComputeWorkgroupsPerDimension * WORKGROUP_SIZE,
      1 << 16,
    ));
    if (perInstance > maxBinding) throw new Error("单个实例的状态超过设备的存储缓冲区上限；请减小容量");
    const results: GpuResult[] = [];
    this.stats = { dispatches: 0, instances: 0, milliseconds: 0, gpuMilliseconds: 0, decodeMilliseconds: 0 };
    const t0 = performance.now();
    for (let k = 0; k < instances.length; k += group) {
      results.push(...await this.runGroup(instances.slice(k, k + group), inWords));
    }
    this.stats = { ...this.stats, instances: instances.length, milliseconds: performance.now() - t0 };
    return results;
  }

  private async runGroup(instances: readonly GpuInstance[], inWords: number): Promise<GpuResult[]> {
    const { device, l } = this;
    const n = instances.length;
    const state = new Uint32Array(n * l.stateWords);
    instances.forEach((inst, i) => this.encodeState(state.subarray(i * l.stateWords, (i + 1) * l.stateWords), inst.start));

    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const stateBuf = device.createBuffer({ size: state.byteLength, usage });
    device.queue.writeBuffer(stateBuf, 0, state);
    const inBuf = device.createBuffer({ size: n * inWords * BYTES, usage });
    const recBuf = device.createBuffer({ size: n * l.recWords * BYTES, usage });
    const recRead = device.createBuffer({ size: n * l.recWords * BYTES, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const paramBuf = device.createBuffer({ size: PARAM_WORDS * BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bindGroup = device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [this.modelBuffer, stateBuf, inBuf, recBuf].map((buffer, binding) => ({ binding, resource: { buffer } }))
        .concat([{ binding: 4, resource: { buffer: paramBuf } }]),
    });

    const results: GpuResult[] = instances.map(() => ({ records: [], error: null, snapshot: null }));
    const batches = Math.max(0, ...instances.map((i) => i.batches.length));
    try {
      for (let b = 0; b < batches; b++) {
        const input = new Uint32Array(n * inWords);
        instances.forEach((inst, i) => {
          const batch = inst.batches[b] ?? [];
          input[i * inWords] = batch.length;
          batch.forEach((ref, k) => {
            const x = this.c.index.get(ref);
            if (x === undefined || !(this.c.flags[x] & F_INPUT)) throw new Error(`${ref} 不是输入入口（JKRD7 §3.2）`);
            input[i * inWords + 1 + k] = x;
          });
        });
        device.queue.writeBuffer(inBuf, 0, input);
        for (;;) {
          device.queue.writeBuffer(paramBuf, 0, new Uint32Array([n, b, this.budget, this.stepLimit, inWords, this.txSteps, 0, 0]));
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          pass.setPipeline(this.pipeline);
          pass.setBindGroup(0, bindGroup);
          pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP_SIZE));
          pass.end();
          encoder.copyBufferToBuffer(recBuf, 0, recRead, 0, recRead.size);
          const t0 = performance.now();
          device.queue.submit([encoder.finish()]);
          this.stats.dispatches++;
          await recRead.mapAsync(GPUMapMode.READ);
          const words = new Uint32Array(recRead.getMappedRange().slice(0));
          recRead.unmap();
          const t1 = performance.now();
          this.stats.gpuMilliseconds += t1 - t0;
          let active = 0;
          for (let i = 0; i < n; i++) {
            const base = i * l.recWords;
            const flags = words[base + 1];
            this.decodeRecords(words, base + 2, words[base], results[i].records);
            const code = flags >>> 8;
            if (code && !results[i].error) results[i].error = { code, message: ERRORS[code] ?? `错误 ${code}`, batch: b };
            if (!code && flags & 1) active++;
          }
          this.stats.decodeMilliseconds += performance.now() - t1;
          if (!active) break;
        }
      }
      // 运行结束：取回状态并生成快照
      const stateRead = device.createBuffer({ size: state.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const encoder = device.createCommandEncoder();
      encoder.copyBufferToBuffer(stateBuf, 0, stateRead, 0, state.byteLength);
      device.queue.submit([encoder.finish()]);
      await stateRead.mapAsync(GPUMapMode.READ);
      const final = new Uint32Array(stateRead.getMappedRange().slice(0));
      stateRead.unmap();
      stateRead.destroy();
      for (let i = 0; i < n; i++) {
        if (!results[i].error) results[i].snapshot = this.decodeState(final.subarray(i * l.stateWords, (i + 1) * l.stateWords));
      }
    } finally {
      for (const buf of [stateBuf, inBuf, recBuf, recRead, paramBuf]) buf.destroy();
    }
    return results;
  }

  // -- 记录解码 -----------------------------------------------------------------

  private decodeRecords(words: Uint32Array, start: number, count: number, out: RecordEntry[]): void {
    const { c, l } = this;
    const mask = (1 << 28) - 1;
    for (let k = start; k < start + count; k++) {
      const w = words[k];
      const kind = w >>> 30;
      const path = c.paths[w & mask];
      if (kind === REC_INJECT) out.push({ inject: path });
      else if (kind === REC_NOTIFY) out.push({ notify: path });
      else if (kind === REC_Q) out.push({ q: path, from: ((w >>> 28) & 1) as Bit, to: ((w >>> 29) & 1) as Bit });
      else {
        const values: Bit[] = [];
        for (let r = 0; r < l.output.length; r++) values.push(((words[k + 1 + (r >> 5)] >>> (r & 31)) & 1) as Bit);
        out.push({ output: path, values: c.model.groupOutput(values) });
        k += l.outWords;
      }
    }
  }

  // -- 快照与状态（§9.5） -----------------------------------------------------------

  /** 把起始状态（模型初值或快照）写入一个实例的状态区。 */
  encodeState(st: Uint32Array, snap?: Snapshot): void {
    const { c, l } = this;
    st.fill(0);
    st[H.BATCH] = NONE;
    for (let i = 0; i < c.n; i++) st[l.s.Q + i] = c.q0[i];
    st.fill(NONE, l.s.SLOT, l.s.SLOT + c.nSlots);
    if (!snap) return;
    const problems = checkSnapshot(snap, c.model);
    if (problems.length || snap.jkm !== c.name) {
      throw new Error("快照不合法：\n" + (problems.length ? problems : ["快照与模型不对应"]).join("\n"));
    }
    const idx = (p: string) => c.index.get(p)!;
    for (const [p, v] of Object.entries(snap.q)) st[l.s.Q + idx(p)] = v;
    for (const [p, record] of Object.entries(snap.trigger_all)) {
      const i = idx(p);
      record.forEach((v, k) => (st[l.s.SLOT + c.slotBase[i] + k] = v === null ? NONE : v));
    }
    c.roundNeed.forEach((_, r) => {
      const saved = snap.rounds[c.jksPaths[c.roundJks[r]]]?.[c.roundKind[r]] ?? [];
      const b = l.s.ROUND + c.roundBase[r];
      st[b] = saved.length;
      saved.forEach((p, k) => (st[b + 1 + k] = idx(p)));
    });
    const fifo = (c.thread !== undefined ? snap.threads[c.thread] : undefined) ?? { events: [], tasks: [] };
    if (fifo.events.length > l.cap.events) throw new Error("快照中的事件数超过 GPU 事件 FIFO 容量");
    if (fifo.tasks.length > l.cap.tasks) throw new Error("快照中的任务数超过 GPU 任务 FIFO 容量");
    fifo.events.forEach((e, k) => (st[l.s.EV + k] = idx(e.source)));
    st[H.EV_LEN] = fifo.events.length;
    fifo.tasks.forEach((t, k) => {
      const o = l.s.TK + k * l.tkStride;
      if ("node" in t) {
        st[o + 1] = idx(t.node);
      } else {
        st[o] = 1;
        st[o + 1] = c.jksIndex.get(t.tx)!;
        st[o + 2] = t.prereqs.length;
        t.prereqs.forEach((p, j) => (st[o + 3 + j] = idx(p)));
      }
    });
    st[H.TK_LEN] = fifo.tasks.length;
  }

  /** 由一个实例的状态区生成快照；实例正处于事务中时不是合法的快照点。 */
  decodeState(st: Uint32Array, name = "S1"): Snapshot | null {
    const { c, l } = this;
    if (st[H.MODE] !== 0) return null;
    const q: Record<string, Bit> = {};
    c.paths.forEach((p, i) => (q[p] = st[l.s.Q + i] as Bit));
    const triggerAll: Record<string, (Bit | null)[]> = {};
    c.paths.forEach((p, i) => {
      if (!c.slotLen[i] || !(c.flags[i] & 1)) return;
      const record = Array.from({ length: c.slotLen[i] }, (_, k) => {
        const v = st[l.s.SLOT + c.slotBase[i] + k];
        return v === NONE ? null : (v as Bit);
      });
      if (record.some((v) => v !== null)) triggerAll[p] = record;
    });
    const keys = c.roundNeed.map((_, r) => [c.jksPaths[c.roundJks[r]], c.roundKind[r], r] as const)
      .sort((a, b) => compareRoundKeys([a[0], a[1]], [b[0], b[1]]));
    const rounds: Snapshot["rounds"] = {};
    for (const [g, kind, r] of keys) {
      const b = l.s.ROUND + c.roundBase[r];
      if (st[b]) (rounds[g] ??= {})[kind] = Array.from({ length: st[b] }, (_, k) => c.paths[st[b + 1 + k]]);
    }
    const events: Snapshot["threads"][string]["events"] = [];
    for (let k = 0; k < st[H.EV_LEN]; k++) events.push({ source: c.paths[st[l.s.EV + (st[H.EV_HEAD] + k) % l.cap.events]] });
    const tasks: Snapshot["threads"][string]["tasks"] = [];
    for (let k = 0; k < st[H.TK_LEN]; k++) {
      const o = l.s.TK + ((st[H.TK_HEAD] + k) % l.cap.tasks) * l.tkStride;
      if (st[o] === 0) tasks.push({ node: c.paths[st[o + 1]] });
      else tasks.push({ tx: c.jksPaths[st[o + 1]], prereqs: Array.from({ length: st[o + 2] }, (_, j) => c.paths[st[o + 3 + j]]) });
    }
    const threads: Snapshot["threads"] = {};
    if (c.thread !== undefined) threads[c.thread] = { events, tasks };
    return { snapshot: name, jkm: c.name, version: "7.0.0", q, trigger_all: triggerAll, rounds, threads };
  }
}

/** 请求一个 WebGPU 设备，并把存储缓冲区上限提高到适配器允许的最大值。 */
export async function requestDevice(gpu: GPU | undefined = globalThis.navigator?.gpu): Promise<{ adapter: GPUAdapter; device: GPUDevice }> {
  if (!gpu) throw new Error("当前环境没有 WebGPU（navigator.gpu 不存在）");
  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("没有可用的 WebGPU 适配器");
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  return { adapter, device };
}
