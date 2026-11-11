/**
 * CPU 后端：JKRD7 §4—§7 的串行参考执行（默认后端）。
 *
 * 一次一个处理单元；事件优先；同一通知按订阅者绝对路径的顺序投递；JKS 整合
 * （any／all／transaction／transaction_any）；事务在事务事件 FIFO 与事务任务 FIFO 中
 * 一直执行到本次触发的事件和任务都处理完；事务中满足的事务登记形成嵌套事务，逐层执行（第 6 节）。
 * batch=true 时节点任务按 §7.5 的可并行批执行，执行记录不变。
 * 只执行单 thread 模型（§9.3）。
 * trace 回调可以接收执行细节（FIFO 的追加与取出、登记的整合、每次到达、每次计算），只供展示观察，
 * 不进入运行日志和执行记录，也不改变执行。
 */

import {
  type Bit, GATED_TYPES, type Jki, type Model, type PublishMode, type Snapshot, type SnapshotTask, VERSION,
  checkSnapshot, hasEx, publishMode, publishes, segments, sortPaths, isInputEntry,
} from "./model.ts";
import type { RecordEntry } from "./record.ts";

export class Unsupported extends Error {}

/** 事务的运行上限（JKRD7 §6.4）。两个后端的默认值相同；属于运行配置，不属于模型。 */
export const TX_LIMITS = {
  /** 一个顶层事务（含其中的嵌套事务）最多投递的事件数与执行的节点任务数之和。 */
  steps: 100_000,
  /** 事务最多嵌套的层数（顶层事务为第 1 层）。 */
  depth: 8,
} as const;

export const TX_LIMIT_MESSAGES = { steps: "事务超过步数上限", depth: "事务嵌套超过层数上限" } as const;

/** 超过事务的运行上限。执行器停在出错的那一步之前，已产生的执行记录保留。 */
export class TxLimit extends Error {
  readonly limit: "steps" | "depth";
  constructor(limit: "steps" | "depth") {
    super(TX_LIMIT_MESSAGES[limit] + "（JKRD7 §6.4）");
    this.limit = limit;
  }
}

/** 简单的先进先出队列。 */
export class Fifo<T> {
  private items: T[] = [];
  private head = 0;

  get length(): number {
    return this.items.length - this.head;
  }

  push(value: T): void {
    this.items.push(value);
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

export type TaskItem = { kind: "node"; node: string } | { kind: "tx"; g: string; prereqs: string[] };

/** 运行日志：执行记录的四种项，加上处理单元、事务等实现细节（不进入执行记录）。 */
export type LogEntry =
  | { kind: "inject"; path: string }
  | { kind: "notify"; path: string }
  | { kind: "q"; path: string; from: Bit; to: Bit }
  | { kind: "output"; path: string; values: Bit[] }
  | { kind: "unit"; n: number; unit: "event" | "node" | "tx"; path: string }
  /** depth：事务任务进入的层；0 为 thread 的任务 FIFO，k 为第 k 层事务的事务任务 FIFO。 */
  | { kind: "tx_enqueue"; g: string; prereqs: string[]; depth: number }
  /** depth：事务所在的层，顶层事务为 1。 */
  | { kind: "tx"; g: string; prereqs: string[]; depth: number }
  | { kind: "tx_end"; g: string; depth: number };

/**
 * 执行细节（可选，供展示页逐步显示）：只是观察，不进入运行日志和执行记录，也不改变执行。
 * depth：0 为 thread 的 FIFO，k 为第 k 层事务的事务 FIFO。
 */
export type DetailEntry =
  /** 一项追加到 FIFO。 */
  | { kind: "push"; fifo: "events" | "tasks"; depth: number; item: string | TaskItem }
  /** 取出 FIFO 队首，开始投递这条事件或执行这个任务。 */
  | { kind: "take"; fifo: "events" | "tasks"; depth: number; item: string | TaskItem }
  /** 前置的一次到达记入 JKS 的登记（§5.3、§5.4）；record 为记入后的本轮记录，complete 表示到齐。 */
  | { kind: "feed"; g: string; type: string; source: string; record: string[]; complete: boolean; depth: number }
  /**
   * 一次到达（§4.1）。gated：经整合放行；all：trigger.all 的记录（更新后、重置前）；
   * outcome：wait 未齐备，task 形成节点任务，notify 空 EX 发布，none 空 EX 不发布。
   */
  | { kind: "receive"; path: string; source: string; gated: boolean; all: (Bit | null)[] | null; outcome: "wait" | "task" | "notify" | "none"; depth: number }
  /** 一次计算（§4.2、§4.4）：x 为执行入口读到的来源值，acc 为每一项运算之后的值。 */
  | { kind: "compute"; path: string; qBefore: Bit; start: Bit; x: Bit[]; acc: Bit[]; mode: PublishMode; publish: boolean; depth: number };

/** 交给 trace 的项：运行日志项与执行细节，按执行顺序。 */
export type TraceEntry = LogEntry | DetailEntry;

type ComputeDetail = Omit<Extract<DetailEntry, { kind: "compute" }>, "kind" | "path" | "depth">;

/** 一个执行中的事务（一层）：事务事件 FIFO 与事务任务 FIFO（§6.2）。任务可以是嵌套事务任务（§6.3）。 */
class Tx {
  /** 事件项是来源 JKI 的绝对路径。 */
  readonly events = new Fifo<string>();
  readonly tasks = new Fifo<TaskItem>();
  readonly depth: number;
  constructor(depth: number) {
    this.depth = depth;
  }
}

export interface CpuOptions {
  /** 按 §7.5 的可并行批执行节点任务。 */
  batch?: boolean;
  /** 一次 run() 的处理单元上限。 */
  maxUnits?: number;
  /** 事务的步数上限与嵌套层数上限（§6.4），默认 TX_LIMITS。 */
  txSteps?: number;
  txDepth?: number;
  /** 执行细节的接收者（展示用，可选）。 */
  trace?: (entry: TraceEntry) => void;
}

export class CpuExecutor {
  readonly m: Model;
  readonly thread: string | undefined;
  readonly batch: boolean;
  readonly maxUnits: number;
  readonly txSteps: number;
  readonly txDepth: number;
  /** 当前顶层事务已用的步数。 */
  private steps = 0;
  q = new Map<string, Bit>();
  readonly triggerAll = new Map<string, (Bit | null)[]>();
  /** 键为 `${JKS 路径}|${类型}`，值为本轮已到达的前置（按到达顺序）。 */
  readonly rounds = new Map<string, string[]>();
  /** 事件项是来源 JKI 的绝对路径。 */
  events = new Fifo<string>();
  tasks = new Fifo<TaskItem>();
  /** 输出列表（JKM.output，§8.1）：输出模块订阅其中每个成员，按这个顺序读取它们的 q。 */
  readonly output: readonly string[];
  private readonly watched: Set<string>;
  readonly log: LogEntry[] = [];
  readonly outputs: { source: string; values: Bit[] }[] = [];
  units = 0;
  readonly batchSizes: number[] = [];
  /** 执行细节的接收者；可以随时换掉或设为 undefined。 */
  trace: ((entry: TraceEntry) => void) | undefined;

  constructor(model: Model, options: CpuOptions = {}) {
    if (model.errors.length) throw new Error("模型未通过静态检查：\n" + model.errors.join("\n"));
    const thread = model.singleThread();
    if (thread === null) {
      const names = [...new Set([...model.jks.values()].map((g) => g.thread))].sort();
      throw new Unsupported(`使用了多个 thread ${JSON.stringify(names)}；thread 之间的调度由 thread 模块规定（JKRD7 §7.4、§9.3）`);
    }
    this.m = model;
    this.thread = thread;
    this.batch = options.batch ?? false;
    this.maxUnits = options.maxUnits ?? 100000;
    this.txSteps = options.txSteps ?? TX_LIMITS.steps;
    this.txDepth = options.txDepth ?? TX_LIMITS.depth;
    this.trace = options.trace;
    for (const [p, node] of model.jki) {
      this.q.set(p, node.q);
      if ("all" in node.trigger) this.triggerAll.set(p, [...node.runtime!.trigger_all!]);
    }
    for (const [g, kinds] of model.regTypes) {
      for (const kind of kinds.keys()) {
        if (kind === "all" || kind === "transaction") this.rounds.set(`${g}|${kind}`, []);
      }
    }
    this.output = [...model.output];
    this.watched = new Set(model.output);
  }

  // -- 小工具 -------------------------------------------------------------

  private node(path: string): Jki {
    return this.m.jki.get(path)!;
  }

  /** 写入运行日志，同时交给 trace。 */
  private note(entry: LogEntry): void {
    this.log.push(entry);
    this.trace?.(entry);
  }

  // -- 外部接口（§9.1） ------------------------------------------------------

  inject(path: string): void {
    if (!isInputEntry(this.m, path)) throw new Error(`${path} 不是输入入口（JKRD7 §3.2、§9.1）`);
    this.note({ kind: "inject", path });
    this.events.push(path);
    this.trace?.({ kind: "push", fifo: "events", depth: 0, item: path });
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
        this.note({ kind: "unit", n: this.units, unit: "tx", path: head.g });
        this.trace?.({ kind: "take", fifo: "tasks", depth: 0, item: head });
        this.runTx(head.g, head.prereqs, 1);
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
        throw new Error("超过处理单元上限；环是否终止由结构自身负责（JKRD7 §6.4）");
      }
    }
  }

  private eventUnit(): void {
    this.units += 1;
    const source = this.events.peek();
    this.note({ kind: "unit", n: this.units, unit: "event", path: source });
    this.trace?.({ kind: "take", fifo: "events", depth: 0, item: source });
    this.deliver(this.events.shift(), null);
  }

  // -- 投递（§7.3）与整合（§5.3） ---------------------------------------------

  /** 投递一条事件；事务执行期间（tx 不为 null）形成的任务和事件进入事务 FIFO。 */
  private deliver(source: string, tx: Tx | null): void {
    if (this.watched.has(source)) { // 输出模块：投递时按 output 的顺序读取（§9.1）；事务内也在投递时读取（§6.2）
      const values = this.output.map((p) => this.q.get(p)!);
      this.outputs.push({ source, values });
      this.note({ kind: "output", path: source, values });
    }
    const reg = this.m.regOf.get(source);
    const gate = reg && GATED_TYPES.has(reg[1]) ? reg : null;
    if (gate) this.feed(gate[0], gate[1], source, tx); // §7.3 第 2 步：先整合
    for (const sub of this.m.subscribers.get(source) ?? []) { // 第 3 步：再照常投递
      if (gate && this.m.gated(gate[0], sub)) continue;
      this.receive(sub, source, tx);
    }
  }

  private feed(g: string, kind: string, source: string, tx: Tx | null): void {
    const depth = tx ? tx.depth : 0;
    let order: string[];
    if (kind === "transaction_any") {
      order = [source];
      this.trace?.({ kind: "feed", g, type: kind, source, record: [source], complete: true, depth });
    } else {
      const record = this.rounds.get(`${g}|${kind}`)!;
      if (!record.includes(source)) record.push(source);
      const complete = record.length >= this.m.regTypes.get(g)!.get(kind)!.length;
      this.trace?.({ kind: "feed", g, type: kind, source, record: [...record], complete, depth });
      if (!complete) return;
      order = [...record];
      record.length = 0;
    }
    if (kind === "all") {
      this.release(g, order, tx);
    } else { // 事务任务：不在事务中时进入 thread；事务中进入当前事务的事务任务 FIFO，成为嵌套事务（§6.3）
      this.note({ kind: "tx_enqueue", g, prereqs: order, depth });
      const item: TaskItem = { kind: "tx", g, prereqs: order };
      (tx ? tx.tasks : this.tasks).push(item);
      this.trace?.({ kind: "push", fifo: "tasks", depth, item });
    }
  }

  private release(g: string, order: string[], tx: Tx | null): void {
    for (const prereq of order) {
      for (const sub of this.m.subscribers.get(prereq) ?? []) {
        if (this.m.gated(g, sub)) this.receive(sub, prereq, tx, true);
      }
    }
  }

  /** §4.1：一次到达。 */
  private receive(path: string, source: string, tx: Tx | null, gated = false): void {
    const node = this.node(path);
    const depth = tx ? tx.depth : 0;
    let all: (Bit | null)[] | null = null;
    if ("all" in node.trigger) {
      const record = this.triggerAll.get(path)!;
      const i = this.m.triggerRefs.get(path)!.indexOf(source);
      record[i] = record[i] === null ? 0 : 1;
      if (this.trace) all = [...record];
      if (record.some((v) => v === null)) {
        this.trace?.({ kind: "receive", path, source, gated, all, outcome: "wait", depth });
        return;
      }
      record.fill(null);
    }
    if (hasEx(node)) {
      this.trace?.({ kind: "receive", path, source, gated, all, outcome: "task", depth });
      const item: TaskItem = { kind: "node", node: path };
      (tx ? tx.tasks : this.tasks).push(item);
      this.trace?.({ kind: "push", fifo: "tasks", depth, item });
    } else if (publishes(publishMode(node), null, this.q.get(path)!)) {
      this.trace?.({ kind: "receive", path, source, gated, all, outcome: "notify", depth });
      this.emit(path, tx);
    } else {
      this.trace?.({ kind: "receive", path, source, gated, all, outcome: "none", depth });
    }
  }

  private emit(path: string, tx: Tx | null): void {
    this.note({ kind: "notify", path });
    (tx ? tx.events : this.events).push(path);
    this.trace?.({ kind: "push", fifo: "events", depth: tx ? tx.depth : 0, item: path });
  }

  // -- 任务（§4.3、§6.2）与可并行批（§7.5） --------------------------------------

  private takeBatch(fifo: Fifo<TaskItem>): string[] {
    const first = fifo.shift() as { kind: "node"; node: string };
    if (!this.batch) return [first.node];
    const batch = [first.node];
    const written = new Set([first.node]);
    while (fifo.length && fifo.peek().kind === "node") {
      const path = (fifo.peek() as { node: string }).node;
      if (written.has(path) || this.m.sourceRefs.get(path)!.some((s) => written.has(s))) break;
      batch.push(path);
      written.add(path);
      fifo.shift();
    }
    return batch;
  }

  private compute(path: string): [Bit, Bit, boolean, ComputeDetail | undefined] {
    const node = this.node(path);
    const sources = node.sources!;
    const qBefore = this.q.get(path)!;
    const start: Bit = sources.seed ?? qBefore;
    let acc: Bit = start;
    const refs = this.m.sourceRefs.get(path)!;
    const x: Bit[] | undefined = this.trace ? [] : undefined;
    const steps: Bit[] | undefined = this.trace ? [] : undefined;
    sources.ex!.forEach((op, i) => {
      const value = this.q.get(refs[i])!;
      acc = (op === "J" ? acc & value : acc ^ value) as Bit;
      x?.push(value);
      steps?.push(acc);
    });
    const mode = publishMode(node);
    const publish = publishes(mode, qBefore, acc);
    return [qBefore, acc, publish, x && steps ? { qBefore, start, x, acc: steps, mode, publish } : undefined];
  }

  private runBatch(batch: string[], tx: Tx | null): void {
    const results = batch.map((p) => [p, ...this.compute(p)] as const); // 全部从批开始时的 q 计算
    this.batchSizes.push(batch.length);
    const depth = tx ? tx.depth : 0;
    for (const [path, qBefore, acc, publish, detail] of results) {
      if (tx === null) {
        this.units += 1;
        this.note({ kind: "unit", n: this.units, unit: "node", path });
      } else {
        this.txStep();
      }
      const trace = this.trace;
      if (trace) {
        trace({ kind: "take", fifo: "tasks", depth, item: { kind: "node", node: path } });
        if (detail) trace({ kind: "compute", path, depth, ...detail });
      }
      if (publish) this.emit(path, tx);
      this.q.set(path, acc);
      this.note({ kind: "q", path, from: qBefore, to: acc });
      if (this.batch) { // 批内每个任务之后先排空事件
        if (tx === null) {
          while (this.events.length) this.eventUnit();
        } else {
          while (tx.events.length) {
            this.txStep();
            const source = tx.events.shift();
            this.trace?.({ kind: "take", fifo: "events", depth, item: source });
            this.deliver(source, tx);
          }
        }
      }
    }
  }

  /** §6.4：事务中每投递一条事件、执行一个节点任务算一步。 */
  private txStep(): void {
    if (this.steps >= this.txSteps) throw new TxLimit("steps");
    this.steps += 1;
  }

  /** §6.2：一直执行到本层的事务事件 FIFO 与事务任务 FIFO 都为空；嵌套事务任务在高一层执行（§6.3）。 */
  private runTx(g: string, order: string[], depth: number): void {
    if (depth > this.txDepth) throw new TxLimit("depth");
    if (depth === 1) this.steps = 0;
    const tx = new Tx(depth);
    this.note({ kind: "tx", g, prereqs: order, depth });
    this.release(g, order, tx);
    while (tx.events.length || tx.tasks.length) {
      if (tx.events.length) {
        this.txStep();
        const source = tx.events.shift();
        this.trace?.({ kind: "take", fifo: "events", depth, item: source });
        this.deliver(source, tx);
      } else if (tx.tasks.peek().kind === "tx") {
        const nested = tx.tasks.shift() as { kind: "tx"; g: string; prereqs: string[] };
        this.trace?.({ kind: "take", fifo: "tasks", depth, item: nested });
        this.runTx(nested.g, nested.prereqs, depth + 1);
      } else {
        this.runBatch(this.takeBatch(tx.tasks), tx);
      }
    }
    this.note({ kind: "tx_end", g, depth });
  }

  // -- 执行记录（§9.4）与快照（§9.5） --------------------------------------------

  record(): RecordEntry[] {
    const out: RecordEntry[] = [];
    for (const e of this.log) {
      if (e.kind === "inject") out.push({ inject: e.path });
      else if (e.kind === "notify") out.push({ notify: e.path });
      else if (e.kind === "q") out.push({ q: e.path, from: e.from, to: e.to });
      else if (e.kind === "output") out.push({ output: e.path, values: this.m.groupOutput(e.values) });
    }
    return out;
  }

  snapshot(name = "S1"): Snapshot {
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
    const threads: Snapshot["threads"] = {};
    if (this.thread !== undefined) {
      threads[this.thread] = { events: this.events.toArray().map((source) => ({ source })), tasks: this.tasks.toArray().map(task) };
    }
    return { snapshot: name, jkm: this.m.name, version: VERSION, q, trigger_all: triggerAll, rounds, threads };
  }

  loadSnapshot(snap: Snapshot): void {
    const problems = checkSnapshot(snap, this.m);
    if (problems.length) throw new Error("快照不合法：\n" + problems.join("\n"));
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
    const fifo = (this.thread !== undefined ? snap.threads[this.thread] : undefined) ?? { events: [], tasks: [] };
    this.events = new Fifo();
    for (const e of fifo.events) this.events.push(e.source);
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

