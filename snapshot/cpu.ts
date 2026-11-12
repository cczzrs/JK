/**
 * CPU 后端的快照导出与载入（snapshot/Snapshot.md 第 4 节）。只在两个处理单元之间调用。
 */

import { type Bit, VERSION, sortPaths } from "../src/model.ts";
import { type CpuExecutor, Fifo, type TaskItem } from "../src/cpu.ts";
import { type Snapshot, type SnapshotTask, requireSnapshot } from "./snapshot.ts";

/** 导出执行器当前的运行现场。 */
export function takeSnapshot(ex: CpuExecutor, name = "S1"): Snapshot {
  const task = (item: TaskItem): SnapshotTask =>
    item.kind === "node" ? { node: item.node } : { tx: item.g, prereqs: [...item.prereqs] };
  const q: Record<string, Bit> = {};
  for (const p of sortPaths(ex.q.keys())) q[p] = ex.q.get(p)!;
  const { trigger_all, rounds } = ex.arrivals();
  const threads: Snapshot["threads"] = {};
  if (ex.thread !== undefined) {
    threads[ex.thread] = { events: ex.events.toArray().map((source) => ({ source })), tasks: ex.tasks.toArray().map(task) };
  }
  return { snapshot: name, jkm: ex.m.name, version: VERSION, q, trigger_all, rounds, threads };
}

/** 用快照替换执行器的运行现场；执行记录与处理单元计数不变。 */
export function loadSnapshot(ex: CpuExecutor, snap: Snapshot): void {
  requireSnapshot(snap, ex.m);
  ex.q = new Map(Object.entries(snap.q));
  for (const [path, record] of ex.triggerAll) {
    const saved = snap.trigger_all[path];
    record.splice(0, record.length, ...(saved ?? record.map(() => null)));
  }
  for (const [key, record] of ex.rounds) {
    const [g, kind] = key.split("|");
    const saved = snap.rounds[g]?.[kind as "all" | "transaction"] ?? [];
    record.splice(0, record.length, ...saved);
  }
  const fifo = (ex.thread !== undefined ? snap.threads[ex.thread] : undefined) ?? { events: [], tasks: [] };
  ex.events = new Fifo();
  for (const e of fifo.events) ex.events.push(e.source);
  ex.tasks = new Fifo();
  for (const t of fifo.tasks) {
    ex.tasks.push("node" in t ? { kind: "node", node: t.node } : { kind: "tx", g: t.tx, prereqs: [...t.prereqs] });
  }
}
