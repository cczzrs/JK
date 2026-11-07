/**
 * CPU 后端：JKRD7 §4—§7 的串行参考执行（默认后端）。
 *
 * 一次一个处理单元；事件优先；同一通知按订阅者绝对路径的顺序投递；JKS 整合
 * （any／all／transaction／transaction_any）；事务用局部序列执行，结束时统一提交。
 * batch=true 时节点任务按 §7.5 的可并行批执行，执行记录不变。
 * 只执行单 queue 模型（§9.3）。
 */

import {
  type Bit, GATED_TYPES, type Jki, type Model, type Snapshot, type SnapshotEvent, type SnapshotTask,
  checkSnapshot, depth, hasEx, publishMode, publishes, segments, sortPaths, isInputEntry,
} from "./model.ts";
import type { RecordEntry } from "./record.ts";

export class Unsupported extends Error {}

/** 简单的先进先出队列。 */
export class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(...values: T[]): void {
    this.items.push(...values);
  }

  shift(): T {
    if (this.head >= this.items.length) throw new Error("队列为空");
    const value = this.items[this.head++];
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return value;
  }

  peek(): T {
    return this.items[this.head];
  }

  toArray(): T[] {
    return this.items.slice(this.head);
  }
}

/** 事件项：committed 的事件带接收者列表（§6.3、§9.5）。 */
export interface EventItem {
  source: string;
  receivers: string[] | null;
  out: boolean;
}

export type TaskItem = { kind: "node"; node: string } | { kind: "tx"; g: string; prereqs: string[] };

/** 运行日志：执行记录的四种项，加上处理单元、事务等实现细节（不进入执行记录）。 */
export type LogEntry =
  | { kind: "inject"; path: string }
  | { kind: "notify"; path: string }
  | { kind: "q"; path: string; from: Bit; to: Bit }
  | { kind: "output"; path: string; values: Bit[] }
  | { kind: "unit"; n: number; unit: "event" | "node" | "tx"; path: string }
  | { kind: "tx_enqueue"; g: string; prereqs: string[] }
  | { kind: "tx"; g: string; prereqs: string[] }
  | { kind: "commit"; g: string; count: number };

/** 一个进行中的事务：局部序列与暂存的范围外投递（§6.3）。 */
class Tx {
  readonly events = new Fifo<EventItem>();
  readonly tasks = new Fifo<TaskItem>();
  readonly committed: EventItem[] = [];
  readonly target: string;
  readonly scope: Set<string>;
  constructor(target: string, scope: Set<string>) {
    this.target = target;
    this.scope = scope;
  }
}

export interface CpuOptions {
  watch?: readonly string[];
  read?: readonly string[];
  /** 按 §7.5 的可并行批执行节点任务。 */
  batch?: boolean;
  /** 一次 run() 的处理单元上限。 */
  maxUnits?: number;
}

export class CpuExecutor {
  readonly m: Model;
  readonly queue: string | undefined;
  readonly batch: boolean;
  readonly maxUnits: number;
  q = new Map<string, Bit>();
  readonly triggerAll = new Map<string, (Bit | null)[]>();
  /** 键为 `${JKS 路径}|${类型}`，值为本轮已到达的前置（按到达顺序）。 */
  readonly rounds = new Map<string, string[]>();
  events = new Fifo<EventItem>();
  tasks = new Fifo<TaskItem>();
  readonly watch: Set<string>;
  readonly read: string[];
  readonly log: LogEntry[] = [];
  readonly outputs: { source: string; values: Bit[] }[] = [];
  units = 0;
  readonly batchSizes: number[] = [];

  constructor(model: Model, options: CpuOptions = {}) {
    if (model.errors.length) throw new Error("模型未通过静态检查：\n" + model.errors.join("\n"));
    const queue = model.singleQueue();
    if (queue === null) {
      const names = [...new Set([...model.jks.values()].map((g) => g.queue))].sort();
      throw new Unsupported(`使用了多个 queue ${JSON.stringify(names)}；queue 之间的调度由队列模块规定（JKRD7 §7.4、§9.3）`);
    }
    this.m = model;
    this.queue = queue;
    this.batch = options.batch ?? false;
    this.maxUnits = options.maxUnits ?? 100000;
    for (const [p, node] of model.jki) {
      this.q.set(p, node.q);
      if ("all" in node.trigger) this.triggerAll.set(p, [...node.runtime!.trigger_all!]);
    }
    for (const [g, kinds] of model.regTypes) {
      for (const kind of kinds.keys()) {
        if (kind === "all" || kind === "transaction") this.rounds.set(`${g}|${kind}`, []);
      }
    }
    this.watch = new Set((options.watch ?? []).map((x) => this.abs(x)));
    this.read = (options.read ?? []).map((x) => this.abs(x));
  }

  // -- 小工具 -------------------------------------------------------------

  private abs(ref: string): string {
    if (!this.m.isJkiPath(ref)) throw new Error(`${ref} 不是模型中的 JKI 绝对路径`);
    return ref;
  }

  private node(path: string): Jki {
    return this.m.jki.get(path)!;
  }

  // -- 外部接口（§9.1） ------------------------------------------------------

  inject(ref: string): void {
    const path = this.abs(ref);
    if (!isInputEntry(this.m, path)) throw new Error(`${ref} 不是输入入口（JKRD7 §3.2、§9.1）`);
    this.log.push({ kind: "inject", path });
    this.events.push({ source: path, receivers: null, out: true });
  }

  /** 一个处理单元（批执行时，一批中的每个任务各算一个单元）。没有可处理的单元时返回 false。 */
  step(): boolean {
    if (this.events.length) {
      this.eventUnit();
    } else if (this.tasks.length) {
      const head = this.tasks.peek();
      if (head.kind === "tx") {
        this.tasks.shift();
        this.units += 1;
        this.log.push({ kind: "unit", n: this.units, unit: "tx", path: head.g });
        this.runTx(head.g, head.prereqs);
      } else {
        this.runBatch(this.takeBatch(this.tasks), null);
      }
    } else {
      return false;
    }
    return true;
  }

  /** 运行到静止。 */
  run(): void {
    const start = this.units;
    while (this.step()) {
      if (this.units - start > this.maxUnits) {
        throw new Error("超过处理单元上限；事务范围以外的环由结构自身负责终止（JKRD7 §6.2）");
      }
    }
  }

  private eventUnit(): void {
    this.units += 1;
    this.log.push({ kind: "unit", n: this.units, unit: "event", path: this.events.peek().source });
    this.deliver(this.events.shift(), null);
  }

  // -- 投递（§7.3）与整合（§5.3） ---------------------------------------------

  private deliver(item: EventItem, tx: Tx | null): void {
    const { source, receivers, out } = item;
    if (tx === null && out && this.watch.has(source)) {
      const values = this.read.map((p) => this.q.get(p)!);
      this.outputs.push({ source, values });
      this.log.push({ kind: "output", path: source, values });
    }
    if (receivers !== null) { // 事务提交的事件：只投给记录的接收者
      for (const sub of receivers) this.receive(sub, source, null);
      return;
    }
    const reg = this.m.regOf.get(source);
    const gate = reg && GATED_TYPES.has(reg[1]) ? reg : null;
    if (gate) this.feed(gate[0], gate[1], source, tx); // §7.3 第 2 步：先整合
    const deferred: string[] = [];
    for (const sub of this.m.subscribers.get(source) ?? []) { // 第 3 步：再照常投递
      if (gate && this.m.gated(gate[0], sub)) continue;
      this.offer(sub, source, tx, deferred);
    }
    if (tx !== null && (deferred.length || this.watch.has(source))) {
      tx.committed.push({ source, receivers: deferred, out: true });
    }
  }

  private offer(sub: string, source: string, tx: Tx | null, deferred: string[]): void {
    if (tx !== null && !tx.scope.has(sub)) deferred.push(sub);
    else this.receive(sub, source, tx);
  }

  private feed(g: string, kind: string, source: string, tx: Tx | null): void {
    const inline = tx !== null && depth(g) > depth(tx.target) && g.startsWith(tx.target + ".");
    let order: string[];
    if (kind === "transaction_any") {
      order = [source];
    } else {
      const record = this.rounds.get(`${g}|${kind}`)!;
      if (!record.includes(source)) record.push(source);
      if (record.length < this.m.regTypes.get(g)!.get(kind)!.length) return;
      order = [...record];
      record.length = 0;
    }
    if (kind === "all" || inline) {
      this.release(g, order, tx);
    } else {
      this.log.push({ kind: "tx_enqueue", g, prereqs: order });
      this.tasks.push({ kind: "tx", g, prereqs: order });
    }
  }

  private release(g: string, order: string[], tx: Tx | null): void {
    for (const prereq of order) {
      const deferred: string[] = [];
      for (const sub of this.m.subscribers.get(prereq) ?? []) {
        if (this.m.gated(g, sub)) this.offer(sub, prereq, tx, deferred);
      }
      if (tx !== null && deferred.length) tx.committed.push({ source: prereq, receivers: deferred, out: false });
    }
  }

  /** §4.1：一次到达。 */
  private receive(path: string, source: string, tx: Tx | null): void {
    const node = this.node(path);
    if ("all" in node.trigger) {
      const record = this.triggerAll.get(path)!;
      const i = this.m.triggerRefs.get(path)!.indexOf(source);
      record[i] = record[i] === null ? 0 : 1;
      if (record.some((v) => v === null)) return;
      record.fill(null);
    }
    if (hasEx(node)) {
      (tx ? tx.tasks : this.tasks).push({ kind: "node", node: path });
    } else if (publishes(publishMode(node), null, this.q.get(path)!)) {
      this.emit(path, tx);
    }
  }

  private emit(path: string, tx: Tx | null): void {
    this.log.push({ kind: "notify", path });
    (tx ? tx.events : this.events).push({ source: path, receivers: null, out: true });
  }

  // -- 任务（§4.3、§6.3）与可并行批（§7.5） --------------------------------------

  private takeBatch(queue: Fifo<TaskItem>): string[] {
    const first = queue.shift() as { kind: "node"; node: string };
    if (!this.batch) return [first.node];
    const batch = [first.node];
    const written = new Set([first.node]);
    while (queue.length && queue.peek().kind === "node") {
      const path = (queue.peek() as { node: string }).node;
      if (written.has(path) || this.m.sourceRefs.get(path)!.some((s) => written.has(s))) break;
      batch.push(path);
      written.add(path);
      queue.shift();
    }
    return batch;
  }

  private compute(path: string): [Bit, Bit, boolean] {
    const node = this.node(path);
    const sources = node.sources!;
    const qBefore = this.q.get(path)!;
    let acc: Bit = sources.seed ?? qBefore;
    const refs = this.m.sourceRefs.get(path)!;
    sources.ex!.forEach((op, i) => {
      const x = this.q.get(refs[i])!;
      acc = (op === "J" ? acc & x : acc ^ x) as Bit;
    });
    return [qBefore, acc, publishes(publishMode(node), qBefore, acc)];
  }

  private runBatch(batch: string[], tx: Tx | null): void {
    const results = batch.map((p) => [p, ...this.compute(p)] as const); // 全部从批开始时的 q 计算
    this.batchSizes.push(batch.length);
    for (const [path, qBefore, acc, publish] of results) {
      if (tx === null) {
        this.units += 1;
        this.log.push({ kind: "unit", n: this.units, unit: "node", path });
      }
      if (publish) this.emit(path, tx);
      this.q.set(path, acc);
      this.log.push({ kind: "q", path, from: qBefore, to: acc });
      if (this.batch) { // 批内每个任务之后先排空事件
        if (tx === null) {
          while (this.events.length) this.eventUnit();
        } else {
          while (tx.events.length) this.deliver(tx.events.shift(), tx);
        }
      }
    }
  }

  private runTx(g: string, order: string[]): void {
    const tx = new Tx(g, this.m.range.get(g)!);
    this.log.push({ kind: "tx", g, prereqs: order });
    this.release(g, order, tx);
    while (tx.events.length || tx.tasks.length) {
      if (tx.events.length) this.deliver(tx.events.shift(), tx);
      else this.runBatch(this.takeBatch(tx.tasks), tx);
    }
    this.events.push(...tx.committed);
    this.log.push({ kind: "commit", g, count: tx.committed.length });
  }

  // -- 执行记录（§9.4）与快照（§9.5） --------------------------------------------

  record(): RecordEntry[] {
    const out: RecordEntry[] = [];
    for (const e of this.log) {
      if (e.kind === "inject") out.push({ inject: e.path });
      else if (e.kind === "notify") out.push({ notify: e.path });
      else if (e.kind === "q") out.push({ q: e.path, from: e.from, to: e.to });
      else if (e.kind === "output") out.push({ output: e.path, values: e.values });
    }
    return out;
  }

  snapshot(name = "S1"): Snapshot {
    const event = (item: EventItem): SnapshotEvent =>
      item.receivers === null ? { source: item.source } : { source: item.source, to: [...item.receivers], out: item.out };
    const task = (item: TaskItem): SnapshotTask =>
      item.kind === "node" ? { node: item.node } : { tx: item.g, prereqs: [...item.prereqs] };
    const rounds: Snapshot["rounds"] = {};
    const keys = [...this.rounds.keys()].map((k) => k.split("|") as [string, string]).sort(compareRoundKeys);
    for (const [g, kind] of keys) {
      const record = this.rounds.get(`${g}|${kind}`)!;
      if (record.length) (rounds[g] ??= {})[kind as "all" | "transaction"] = [...record];
    }
    const q: Record<string, Bit> = {};
    for (const p of sortPaths(this.q.keys())) q[p] = this.q.get(p)!;
    const triggerAll: Record<string, (Bit | null)[]> = {};
    for (const p of sortPaths(this.triggerAll.keys())) {
      const r = this.triggerAll.get(p)!;
      if (r.some((v) => v !== null)) triggerAll[p] = [...r];
    }
    const queues: Snapshot["queues"] = {};
    if (this.queue !== undefined) {
      queues[this.queue] = { events: this.events.toArray().map(event), tasks: this.tasks.toArray().map(task) };
    }
    return { snapshot: name, jkm: this.m.name, version: "7.0.0", q, trigger_all: triggerAll, rounds, queues };
  }

  loadSnapshot(snap: Snapshot): void {
    const problems = checkSnapshot(snap, this.m);
    if (problems.length || snap.jkm !== this.m.name) {
      throw new Error("快照不合法：\n" + (problems.length ? problems : ["快照与模型不对应"]).join("\n"));
    }
    this.q = new Map(Object.entries(snap.q));
    for (const [path, record] of this.triggerAll) {
      const saved = snap.trigger_all[path];
      record.splice(0, record.length, ...(saved ?? record.map(() => null)));
    }
    for (const [key, record] of this.rounds) {
      const [g, kind] = key.split("|");
      const saved = snap.rounds[g]?.[kind as "all" | "transaction"] ?? [];
      record.splice(0, record.length, ...saved);
    }
    const fifo = (this.queue !== undefined ? snap.queues[this.queue] : undefined) ?? { events: [], tasks: [] };
    this.events = new Fifo();
    for (const e of fifo.events) {
      this.events.push("to" in e ? { source: e.source, receivers: [...e.to], out: e.out } : { source: e.source, receivers: null, out: true });
    }
    this.tasks = new Fifo();
    for (const t of fifo.tasks) {
      this.tasks.push("node" in t ? { kind: "node", node: t.node } : { kind: "tx", g: t.tx, prereqs: [...t.prereqs] });
    }
  }

  // -- 观察 ---------------------------------------------------------------------

  writes(ref: string): Bit[] {
    return this.log.flatMap((e) => (e.kind === "q" && e.path === ref ? [e.to] : []));
  }

  notifications(ref?: string): string[] {
    return this.log.flatMap((e) => (e.kind === "notify" && (ref === undefined || e.path === ref) ? [e.path] : []));
  }

  count(kind: LogEntry["kind"]): number {
    return this.log.filter((e) => e.kind === kind).length;
  }
}

/** 快照中 rounds 的键顺序：先按 JKS 层数，再逐段比较路径文本，最后比较类型名。 */
export function compareRoundKeys([g1, k1]: [string, string], [g2, k2]: [string, string]): number {
  const a = segments(g1);
  const b = segments(g2);
  if (a.length !== b.length) return a.length - b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return k1 < k2 ? -1 : k1 > k2 ? 1 : 0;
}

