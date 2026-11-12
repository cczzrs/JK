/**
 * GPU 后端的快照（snapshot/Snapshot.md 第 4 节）：快照与 GPU 实例状态区之间的转换，
 * 以及带起始快照、交回结束快照的运行。状态区的布局见 WebGPU.md 第 6 节。
 */

import { type Bit, VERSION } from "../src/model.ts";
import { compareRoundKeys } from "../src/cpu.ts";
import { F_ALL, H, NONE } from "../src/gpu/compile.ts";
import type { GpuExecutor, GpuResult } from "../src/gpu/backend.ts";
import { type Snapshot, requireSnapshot } from "./snapshot.ts";

export interface GpuSnapshotInstance {
  batches: readonly (readonly string[])[];
  start?: Snapshot;
}

/** 运行结束时的快照；出错的实例没有快照。 */
export type GpuSnapshotResult = GpuResult & { snapshot: Snapshot | null };

/** 把快照编码成一个实例的起始状态。 */
export function encodeSnapshot(gpu: GpuExecutor, snap: Snapshot): Uint32Array {
  const { c, l } = gpu;
  requireSnapshot(snap, c.model);
  const st = new Uint32Array(l.stateWords);
  gpu.initState(st);
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
  return st;
}

/** 由一个实例的状态区生成快照；实例正处于事务中时不是合法的快照点，返回 null。 */
export function decodeSnapshot(gpu: GpuExecutor, st: Uint32Array, name = "S1"): Snapshot | null {
  const { c, l } = gpu;
  if (st[H.MODE] !== 0) return null;
  const q: Record<string, Bit> = {};
  c.paths.forEach((p, i) => (q[p] = st[l.s.Q + i] as Bit));
  const triggerAll: Record<string, (Bit | null)[]> = {};
  c.paths.forEach((p, i) => {
    if (!(c.flags[i] & F_ALL)) return;
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
  return { snapshot: name, jkm: c.name, version: VERSION, q, trigger_all: triggerAll, rounds, threads };
}

/**
 * 执行一组实例：每个实例可以从快照开始；运行结束时为没有出错的实例生成快照。
 * 从快照开始的实例先运行到静止，再注入第一批（JKRD7 §9.4）：在它的各批之前加一个空批，GPU 后端对空批只运行到静止。
 */
export async function runWithSnapshots(gpu: GpuExecutor, instances: readonly GpuSnapshotInstance[]): Promise<GpuSnapshotResult[]> {
  const results = await gpu.run(instances.map((inst) => ({
    batches: inst.start ? [[], ...inst.batches] : inst.batches, start: inst.start && encodeSnapshot(gpu, inst.start),
  })));
  return results.map((r) => ({ ...r, snapshot: r.state && decodeSnapshot(gpu, r.state) }));
}
