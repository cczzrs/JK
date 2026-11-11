/**
 * 执行会话：展示页与 JK 执行器之间的只读适配层。
 *
 * 执行全部由 src/cpu.ts（CPU 后端，默认）完成：注入用 inject，推进用 step，一次一个处理单元。
 * 本文件只读取执行器的公开状态、运行日志，以及执行器自己报告的执行细节（CpuExecutor.trace），
 * 整理成展示用的数据（执行记录、计数、FIFO 列表、逐步的动画与说明），不参与执行，也不补充规则。
 */

import { CpuExecutor, type TaskItem, type TraceEntry, compareRoundKeys } from "../../src/cpu.ts";
import { type Bit, type Model, isInputEntry, sortPaths } from "../../src/model.ts";
import type { RecordEntry } from "../../src/record.ts";
import { observeKey } from "./scene/model-view.ts";

/** 一次动画用的传递：沿某条连线移动的标记。只用于画图。 */
export interface Transfer {
  source: string;
  target: string;
  /** 通知是投递序号（#1、#2……，§7.3），EX 读取是“读”加读到的值，输出是读到的值。 */
  value: string;
  relation: "trigger" | "source" | "observe";
  /** 来源在 sources.s 中的位置（relation 为 source 时）。 */
  index?: number;
  /** 这条输出记录在本会话中的序号（从 0 起，relation 为 observe 时）。 */
  output?: number;
}

/** 节点上的短暂标记：q 写入或发布。 */
export interface Pulse {
  path: string;
  text: string;
  kind: "write" | "publish";
}

/** 一层事务 FIFO 的内容。 */
export interface FifoLevel {
  depth: number;
  events: string[];
  tasks: TaskItem[];
}

/** 处理单元内的一步：投递一条事件，或执行一个节点任务、一个（嵌套）事务任务。 */
export interface Step {
  /** 取自哪一层 FIFO：0 为 thread，k 为第 k 层事务。 */
  depth: number;
  kind: "event" | "node" | "tx";
  path: string;
  /** 这一步的执行细节与运行日志项，按执行顺序（不含开始时的 take）。 */
  entries: TraceEntry[];
  transfers: Transfer[];
  pulses: Pulse[];
  /** 这一步结束时各层事务 FIFO 的内容（第 1 层起）。 */
  levels: FifoLevel[];
}

/** 一个已完成的处理单元（§7.1）。 */
export interface Unit {
  n: number;
  kind: "event" | "node" | "tx";
  path: string;
  /** 是否记录了执行细节（跳过动画运行时不记录）。 */
  detailed: boolean;
  steps: Step[];
}

/** 一次输入：at 为注入时已完成的处理单元数，script 表示来自运行脚本。 */
export interface Injection {
  at: number;
  paths: string[];
  script: boolean;
}

/** 一条输出记录（§9.4）及产生它的处理单元编号（从 1 起）。 */
export interface OutputRow {
  unit: number;
  source: string;
  values: Bit[];
}

export interface Stats {
  /** 执行过的节点任务（q 记录条数，含事务内）。 */
  evaluations: number;
  /** 执行过的事务（含嵌套事务）。 */
  transactions: number;
  /** 执行过的 EX 操作项（每个节点任务按其 sources.ex 的长度计）。 */
  operations: number;
}

export interface FifoRow {
  kind: "EV" | "EX" | "TX";
  target: string;
  detail: string;
  item: unknown;
}

/** 把一个单元的执行细节分成步，并整理出动画数据与各层事务 FIFO 的内容。 */
/** firstOutput：本单元第一条输出记录在本会话中的序号。 */
function buildSteps(model: Model, trace: readonly TraceEntry[], firstOutput: number): Step[] {
  let output = firstOutput;
  const steps: Step[] = [];
  const levels = new Map<number, { events: string[]; tasks: TaskItem[] }>();
  const level = (depth: number) => {
    let found = levels.get(depth);
    if (!found) {
      found = { events: [], tasks: [] };
      levels.set(depth, found);
    }
    return found;
  };
  let current: Step | null = null;
  let order = 0;
  const finish = () => {
    if (!current) return;
    current.levels = [...levels].sort((a, b) => a[0] - b[0])
      .map(([depth, l]) => ({ depth, events: [...l.events], tasks: [...l.tasks] }));
  };
  for (const e of trace) {
    if (e.kind === "take") {
      finish();
      if (e.depth > 0) {
        const l = level(e.depth);
        if (e.fifo === "events") l.events.shift();
        else l.tasks.shift();
      }
      const item = e.item;
      current = {
        depth: e.depth,
        kind: e.fifo === "events" ? "event" : (item as TaskItem).kind === "tx" ? "tx" : "node",
        path: typeof item === "string" ? item : item.kind === "node" ? item.node : item.g,
        entries: [], transfers: [], pulses: [], levels: [],
      };
      steps.push(current);
      order = 0;
      continue;
    }
    const step: Step | null = current;
    if (!step) continue; // 单元开始的 unit 项
    step.entries.push(e);
    if (e.kind === "push" && e.depth > 0) {
      const l = level(e.depth);
      if (e.fifo === "events") l.events.push(e.item as string);
      else l.tasks.push(e.item as TaskItem);
    } else if (e.kind === "tx") {
      level(e.depth);
    } else if (e.kind === "tx_end") {
      levels.delete(e.depth);
    } else if (e.kind === "receive") {
      step.transfers.push({ source: e.source, target: e.path, value: `#${++order}`, relation: "trigger" });
    } else if (e.kind === "compute") {
      const refs = model.sourceRefs.get(e.path) ?? [];
      e.x.forEach((value, index) => step.transfers.push({ source: refs[index], target: e.path, value: `读${value}`, relation: "source", index }));
    } else if (e.kind === "output") { // 输出模块按 JKM.output 的顺序读取（§9.1）
      const n = output++;
      model.output.forEach((path, i) => step.transfers.push({ source: path, target: observeKey(path), value: String(e.values[i]), relation: "observe", output: n }));
    } else if (e.kind === "q") {
      step.pulses.push({ path: e.path, text: `${e.from}→${e.to}`, kind: "write" });
    } else if (e.kind === "notify") {
      step.pulses.push({ path: e.path, text: "发布", kind: "publish" });
    }
  }
  finish();
  return steps;
}

export class Session {
  readonly model: Model;
  readonly ex: CpuExecutor;
  /** 最近的执行记录（显示用，最多 historyRows 条）；完整记录用 ex.record()。 */
  readonly recent: RecordEntry[] = [];
  /** 执行记录的总条数。 */
  recordCount = 0;
  /** 每个 JKI 的 q 写入次数。 */
  readonly counts = new Map<string, number>();
  readonly stats: Stats = { evaluations: 0, transactions: 0, operations: 0 };
  /** 本会话的全部输入，按发生顺序。 */
  readonly journal: Injection[] = [];
  /** 本会话的全部输出记录，按发生顺序。 */
  readonly outputs: OutputRow[] = [];
  /** 执行出错（例如超过事务上限，§6.4）后停止：执行器停在出错的那一步之前，不再推进。 */
  stopped: Error | null = null;
  private readonly historyRows: number;
  private readonly dirty = new Set<string>();
  private cursor = 0;
  /** 运行日志中最近一个处理单元的编号。 */
  private unit = 0;

  constructor(model: Model, historyRows = 120) {
    this.model = model;
    this.historyRows = historyRows;
    this.ex = new CpuExecutor(model); // 输出观察取自模型的 output（§8.1）
  }

  /** 两个 FIFO 都为空（静止）。 */
  get idle(): boolean {
    return this.ex.events.length === 0 && this.ex.tasks.length === 0;
  }

  get units(): number {
    return this.ex.units;
  }

  get thread(): string | undefined {
    return this.ex.thread;
  }

  latestOutput(): { source: string; values: Bit[] } | undefined {
    return this.ex.outputs.at(-1);
  }

  /** 在处理单元之间追加一批输入（§9.1）。先检查全部入口再逐条追加，不会因中途出错留下半批。 */
  injectBatch(paths: unknown, script = false): number {
    if (this.stopped) throw new Error("执行已停止，请重载后再发送输入");
    if (!Array.isArray(paths) || paths.length === 0) throw new Error("输入必须是非空的输入入口路径数组");
    const bad = paths.filter((p) => !isInputEntry(this.model, p)).map((p) => JSON.stringify(p));
    if (bad.length) throw new Error(`${bad.join("、")} 不是输入入口（JKRD7 §3.2、§9.1）`);
    for (const path of paths as string[]) this.ex.inject(path);
    this.journal.push({ at: this.ex.units, paths: [...paths as string[]], script });
    this.sync();
    return paths.length;
  }

  /** 推进一个处理单元；静止时返回 null。detail 为 false 时不记录执行细节（更快）。 */
  step(detail = true): Unit | null {
    if (this.stopped) throw this.stopped;
    if (this.idle) return null;
    const ex = this.ex;
    const start = ex.log.length;
    const trace: TraceEntry[] = [];
    ex.trace = detail ? (entry) => {
      trace.push(entry);
    } : undefined;
    try {
      ex.step();
    } catch (error) {
      this.stopped = error instanceof Error ? error : new Error(String(error));
      throw this.stopped;
    } finally {
      ex.trace = undefined;
      this.sync();
    }
    const head = ex.log[start];
    if (head.kind !== "unit") throw new Error("运行日志缺少处理单元项");
    const first = this.outputs.length - trace.filter((e) => e.kind === "output").length;
    return { n: head.n, kind: head.unit, path: head.path, detailed: detail, steps: detail ? buildSteps(this.model, trace, first) : [] };
  }

  /** 把新增的运行日志并入执行记录与计数。 */
  private sync(): void {
    const log = this.ex.log;
    for (; this.cursor < log.length; this.cursor++) {
      const e = log[this.cursor];
      let record: RecordEntry | null = null;
      if (e.kind === "unit") this.unit = e.n;
      else if (e.kind === "inject") record = { inject: e.path };
      else if (e.kind === "notify") record = { notify: e.path };
      else if (e.kind === "output") {
        record = { output: e.path, values: this.model.groupOutput(e.values) };
        this.outputs.push({ unit: this.unit, source: e.path, values: [...e.values] });
      }
      else if (e.kind === "tx") this.stats.transactions += 1;
      else if (e.kind === "q") {
        record = { q: e.path, from: e.from, to: e.to };
        this.counts.set(e.path, (this.counts.get(e.path) ?? 0) + 1);
        this.stats.evaluations += 1;
        this.stats.operations += this.model.jki.get(e.path)!.sources?.ex?.length ?? 0;
        this.dirty.add(e.path);
      }
      if (record) {
        this.recordCount += 1;
        this.recent.push(record);
        if (this.recent.length > this.historyRows) this.recent.shift();
      }
    }
  }

  /** 自上次取出以来 q 被写入过的 JKI（场景只更新这些节点）。 */
  takeDirty(): string[] {
    const paths = [...this.dirty];
    this.dirty.clear();
    return paths;
  }

  /** thread 的任务 FIFO 中以 path 为目标的节点任务个数（一个节点可以同时有多个排队任务，§9.2）。 */
  pendingTasks(path: string): number {
    return this.ex.tasks.toArray().filter((t) => t.kind === "node" && t.node === path).length;
  }

  /** 事件 FIFO 的展示行（来源 JKI）。 */
  eventRows(): FifoRow[] {
    return this.ex.events.toArray().map((source) => ({ kind: "EV", target: source, detail: "待投递", item: { source } }));
  }

  /** 任务 FIFO 的展示行。 */
  taskRows(): FifoRow[] {
    return this.ex.tasks.toArray().map(taskRow);
  }

  /** 未到齐的 all 到达记录与登记轮记录，顺序与快照相同（§9.5）。 */
  roundsView(): { trigger_all: Record<string, (Bit | null)[]>; rounds: Record<string, Partial<Record<string, string[]>>> } {
    const triggerAll: Record<string, (Bit | null)[]> = {};
    for (const p of sortPaths(this.ex.triggerAll.keys())) {
      const record = this.ex.triggerAll.get(p)!;
      if (record.some((v) => v !== null)) triggerAll[p] = [...record];
    }
    const rounds: Record<string, Partial<Record<string, string[]>>> = {};
    const keys = [...this.ex.rounds.keys()].map((k) => k.split("|") as [string, string]).sort(compareRoundKeys);
    for (const [g, kind] of keys) {
      const record = this.ex.rounds.get(`${g}|${kind}`)!;
      if (record.length) (rounds[g] ??= {})[kind] = [...record];
    }
    return { trigger_all: triggerAll, rounds };
  }

  /** 一个 JKS 的 all、transaction 本轮记录（§5.4）。 */
  groupRounds(g: string): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const kind of ["all", "transaction"]) {
      const record = this.ex.rounds.get(`${g}|${kind}`);
      if (record) out[kind] = [...record];
    }
    return out;
  }
}

export function taskRow(task: TaskItem): FifoRow {
  return task.kind === "node"
    ? { kind: "EX", target: task.node, detail: "待执行", item: { node: task.node } }
    : { kind: "TX", target: task.g, detail: `${task.prereqs.length} 前置`, item: { tx: task.g, prereqs: [...task.prereqs] } };
}
