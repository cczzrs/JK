/**
 * GPU 编译：把已通过静态检查的模型编译成平铺的 u32 数组（WebGPU.md §3），并确定
 * 每个实例的状态布局与记录布局（§4、§5）。主机端与 WGSL 内核共用这里的偏移。
 *
 * 节点编号 = JKRD7 §7.3 的路径顺序，所以订阅者列表天然有序，每个 JKS 的成员 JKI
 * 是一段连续编号，整合判定只需比较区间。
 */

import { type Model, PUBLISH_MODES, comparePaths, hasEx, isInputEntry, publishMode, segments, triggerOf } from "../model.ts";
import { TX_LIMITS, TX_LIMIT_MESSAGES } from "../cpu.ts";

export const NONE = 0xffffffff;
export const GATE_NONE = 0;
export const GATE_ALL = 1;
export const GATE_TX = 2;
export const GATE_TX_ANY = 3;
const GATE_CODE: Record<string, number> = { all: GATE_ALL, transaction: GATE_TX, transaction_any: GATE_TX_ANY };

/** 节点标志位。 */
export const F_ALL = 1;
export const F_EX = 2;
export const F_INPUT = 4;
/** JKM.output 的成员：它的通知投递时写一条输出记录（§9.1）。 */
export const F_WATCH = 8;

/**
 * 每个实例状态区开头的头部字（WebGPU.md §5）。MODE 是当前事务层数：0 表示不在事务中。
 * 各层事务 FIFO 的位置在状态区的 LV 段（每层 4 个字：事件头、事件数、任务头、任务数）。
 */
export const H = {
  STATUS: 0, MODE: 1, EV_HEAD: 2, EV_LEN: 3, TK_HEAD: 4, TK_LEN: 5, INJ_POS: 6, INJ_LEN: 7, STEPS: 8, BATCH: 9,
  TX_STEPS: 10,
} as const;
export const HEADER_WORDS = 11;

/** 记录字的种类（高 2 位）；低 28 位是节点编号。 */
export const REC_INJECT = 0;
export const REC_NOTIFY = 1;
export const REC_Q = 2;
export const REC_OUTPUT = 3;
export const NODE_BITS = 28;

/** 错误码（状态字）。 */
export const ERRORS: Record<number, string> = {
  1: "事件 FIFO 溢出",
  2: "任务 FIFO 溢出",
  3: "事务事件 FIFO 溢出",
  4: "事务任务 FIFO 溢出",
  6: "超过一批的步数上限",
  7: "记录缓冲溢出",
  8: TX_LIMIT_MESSAGES.depth,
  9: TX_LIMIT_MESSAGES.steps,
};

/** 每个实例的容量（项数）。容量是运行配置，不属于模型。 */
export interface Capacity {
  events: number;
  tasks: number;
  /** 每一层的事务事件 FIFO 与事务任务 FIFO（JKRD7 §6.2）。 */
  localEvents: number;
  localTasks: number;
  /** 事务嵌套的层数上限（JKRD7 §6.3、§6.4），默认与 CPU 后端相同。 */
  depth: number;
  /** 每次调度可写入的记录字数；不足一步的最大记录量时自动加大。 */
  records: number;
}

export const DEFAULT_CAPACITY: Capacity = {
  events: 64, tasks: 64, localEvents: 64, localTasks: 64, depth: TX_LIMITS.depth, records: 2048,
};

/** 模型的结构数组（与观察、容量无关）。 */
export class Compiled {
  readonly n: number;
  readonly paths: string[];
  readonly index = new Map<string, number>();
  readonly flags: number[];
  readonly q0: number[];
  readonly seed: number[];
  readonly pub: number[];
  readonly srcOff: number[] = [0];
  readonly src: number[] = [];
  readonly slotBase: number[] = [];
  readonly slotLen: number[] = [];
  readonly nSlots: number;
  readonly subOff: number[] = [0];
  readonly sub: number[] = [];
  readonly subSlot: number[] = [];
  readonly jksPaths: string[];
  readonly jksIndex = new Map<string, number>();
  readonly jksLo: number[] = [];
  readonly jksHi: number[] = [];
  readonly regJks: number[];
  readonly regGate: number[];
  readonly regRound: number[];
  /** 每轮：所需前置数、所属 JKS、类型、在状态区中的偏移（相对 rounds 段）。 */
  readonly roundNeed: number[] = [];
  readonly roundJks: number[] = [];
  readonly roundKind: ("all" | "transaction")[] = [];
  readonly roundBase: number[] = [];
  readonly roundWords: number;
  /** 最大扇出（一个节点的订阅者数），至少 1。 */
  readonly maxFan: number;
  /** 事务任务中前置列表的最大长度，至少 1。 */
  readonly maxOrder: number;
  /** 全部 all／transaction 登记中最大的前置数，至少 1（用于记录量上界）。 */
  readonly maxRound: number;
  readonly thread: string | undefined;
  readonly name: string | null;
  readonly model: Model;

  constructor(model: Model) {
    this.model = model;
    if (model.errors.length) throw new Error("模型未通过静态检查：\n" + model.errors.join("\n"));
    const thread = model.singleThread();
    if (thread === null) throw new Error("GPU 后端只执行单 thread 模型（JKRD7 §9.3）");
    this.thread = thread;
    this.name = model.name;
    const nodes = [...model.jki.keys()].sort(comparePaths);
    if (nodes.length >= 2 ** NODE_BITS) throw new Error("节点数超过 GPU 后端的编号范围");
    this.n = nodes.length;
    this.paths = nodes;
    nodes.forEach((p, i) => this.index.set(p, i));
    const idx = (p: string) => this.index.get(p)!;

    this.q0 = nodes.map((p) => model.jki.get(p)!.q);
    this.seed = nodes.map((p) => model.jki.get(p)!.sources?.seed ?? NONE);
    this.pub = nodes.map((p) => PUBLISH_MODES.indexOf(publishMode(model.jki.get(p)!)));
    this.flags = nodes.map((p) => {
      const node = model.jki.get(p)!;
      return ("all" in node.trigger ? F_ALL : 0) | (hasEx(node) ? F_EX : 0) | (isInputEntry(model, p) ? F_INPUT : 0);
    });

    // sources（只有带 EX 的节点）：低 31 位来源编号，最高位 0=J、1=K
    for (const p of nodes) {
      const node = model.jki.get(p)!;
      if (hasEx(node)) {
        model.sourceRefs.get(p)!.forEach((s, k) => this.src.push((idx(s) | (node.sources!.ex![k] === "K" ? 0x80000000 : 0)) >>> 0));
      }
      this.srcOff.push(this.src.length);
    }

    // trigger_all 槽位
    let slots = 0;
    for (const p of nodes) {
      const node = model.jki.get(p)!;
      const k = "all" in node.trigger ? triggerOf(node)[1].length : 0;
      this.slotBase.push(slots);
      this.slotLen.push(k);
      slots += k;
    }
    this.nSlots = slots;

    // JKS：成员 JKI 的编号区间
    const groups = [...model.jks.keys()].sort((a, b) => segments(a).length - segments(b).length || comparePaths(a, b));
    this.jksPaths = groups;
    groups.forEach((g, k) => this.jksIndex.set(g, k));
    for (const g of groups) {
      const members = [...model.members.get(g)!].map(idx).sort((a, b) => a - b);
      const lo = members[0] ?? 0;
      const hi = members.length ? members[members.length - 1] + 1 : 0;
      if (members.some((v, k) => v !== lo + k)) throw new Error(`${g} 的成员编号不连续`);
      this.jksLo.push(lo);
      this.jksHi.push(hi);
    }

    // 登记：节点 → JKS、整合类型、轮编号
    this.regJks = nodes.map(() => NONE);
    this.regGate = nodes.map(() => GATE_NONE);
    this.regRound = nodes.map(() => NONE);
    let roundWords = 0;
    let maxOrder = 1;
    let maxRound = 1;
    for (const [g, kinds] of model.regTypes) {
      for (const [kind, prereqs] of kinds) {
        let rid = NONE;
        if (kind === "all" || kind === "transaction") {
          rid = this.roundNeed.length;
          this.roundNeed.push(prereqs.length);
          this.roundJks.push(this.jksIndex.get(g)!);
          this.roundKind.push(kind);
          this.roundBase.push(roundWords);
          roundWords += 1 + prereqs.length;
          maxRound = Math.max(maxRound, prereqs.length);
          if (kind === "transaction") maxOrder = Math.max(maxOrder, prereqs.length);
        }
        for (const p of prereqs) {
          const i = idx(p);
          this.regJks[i] = this.jksIndex.get(g)!;
          this.regGate[i] = GATE_CODE[kind] ?? GATE_NONE;
          this.regRound[i] = rid;
        }
      }
    }
    this.roundWords = roundWords;
    this.maxOrder = maxOrder;
    this.maxRound = maxRound;

    // 订阅者：低 31 位订阅者编号，最高位 = 该连接受来源的登记整合；另存来源在订阅者 trigger 中的位置
    let maxFan = 1;
    for (const p of nodes) {
      const x = idx(p);
      const subs = (model.subscribers.get(p) ?? []).map(idx).sort((a, b) => a - b);
      maxFan = Math.max(maxFan, subs.length);
      for (const s of subs) {
        const gated = this.regGate[x] !== GATE_NONE && this.inScope(this.regJks[x], s);
        this.sub.push((s | (gated ? 0x80000000 : 0)) >>> 0);
        const sNode = model.jki.get(nodes[s])!;
        this.subSlot.push("all" in sNode.trigger ? model.triggerRefs.get(nodes[s])!.indexOf(p) : 0);
      }
      this.subOff.push(this.sub.length);
    }
    this.maxFan = maxFan;
  }

  /** JKI i 是否是 JKS g 的成员且不是 g 的前置（受整合的订阅者，§5.3）。 */
  inScope(g: number, i: number): boolean {
    return this.jksLo[g] <= i && i < this.jksHi[g] && this.regJks[i] !== g;
  }

}

/** 一次运行的布局：模型缓冲区内各段的偏移、每个实例的状态与记录布局。 */
export interface Layout {
  c: Compiled;
  cap: Capacity;
  /** JKM.output 成员的节点编号，按 output 的顺序。 */
  output: number[];
  /** 模型缓冲区的段偏移（字）。 */
  m: Record<
    "FLAGS" | "SEED" | "PUB" | "SRC_OFF" | "SRC" | "SLOT_BASE" | "SLOT_LEN" | "SUB_OFF" | "SUB" | "SUB_SLOT"
    | "REG_JKS" | "REG_GATE" | "REG_ROUND" | "ROUND_NEED" | "ROUND_BASE" | "JKS_LO" | "JKS_HI" | "OUTPUT",
    number
  >;
  modelData: Uint32Array;
  /** 状态区的段偏移（字，相对实例开头）。 */
  s: Record<"Q" | "SLOT" | "ROUND" | "EV" | "TK" | "LV" | "LEV" | "LTK", number>;
  stateWords: number;
  tkStride: number;
  outWords: number;
  /** 一个微步最多写入的记录字数。 */
  maxRecStep: number;
  /** 每个实例记录区的字数（含 2 字头部）。 */
  recWords: number;
}

export function layout(c: Compiled, capacity: Partial<Capacity> = {}): Layout {
  const cap: Capacity = { ...DEFAULT_CAPACITY, ...capacity };
  const o = c.model.output.map((p) => c.index.get(p)!); // 静态检查已保证都是 JKI 绝对路径

  const sections: [keyof Layout["m"], number[]][] = [
    ["FLAGS", c.flags.map((f, i) => f | (o.includes(i) ? F_WATCH : 0))],
    ["SEED", c.seed], ["PUB", c.pub], ["SRC_OFF", c.srcOff], ["SRC", c.src],
    ["SLOT_BASE", c.slotBase], ["SLOT_LEN", c.slotLen], ["SUB_OFF", c.subOff], ["SUB", c.sub], ["SUB_SLOT", c.subSlot],
    ["REG_JKS", c.regJks], ["REG_GATE", c.regGate], ["REG_ROUND", c.regRound],
    ["ROUND_NEED", c.roundNeed], ["ROUND_BASE", c.roundBase],
    ["JKS_LO", c.jksLo], ["JKS_HI", c.jksHi], ["OUTPUT", o],
  ];
  const m = {} as Layout["m"];
  const words: number[] = [];
  for (const [name, data] of sections) {
    m[name] = words.length;
    words.push(...data);
  }
  if (!words.length) words.push(0);
  const modelData = new Uint32Array(words.map((v) => v >>> 0));

  const tkStride = 3 + c.maxOrder;
  const s = {} as Layout["s"];
  let off = HEADER_WORDS;
  const segs: [keyof Layout["s"], number][] = [
    ["Q", c.n], ["SLOT", c.nSlots], ["ROUND", c.roundWords], ["EV", cap.events], ["TK", cap.tasks * tkStride],
    ["LV", 4 * cap.depth], ["LEV", cap.depth * cap.localEvents], ["LTK", cap.depth * cap.localTasks * tkStride],
  ];
  for (const [name, size] of segs) {
    s[name] = off;
    off += size;
  }
  const outWords = Math.ceil(o.length / 32);
  // 一个微步：注入 1；投递 = 输出（1+outWords）+ 整合放行与照常投递时每个订阅者至多一条通知；任务 2；
  // 事务开始 = 放行时每个订阅者至多一条通知
  const maxRecStep = 1 + outWords + (c.maxRound + 1) * c.maxFan + 2;
  const recWords = 2 + Math.max(cap.records, maxRecStep);
  return { c, cap, output: o, m, modelData, s, stateWords: off, tkStride, outWords, maxRecStep, recWords };
}
