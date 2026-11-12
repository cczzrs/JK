/**
 * 静态检查的正例与负例（JKRD7 §2、§3、§5、§6.4、§8），bit 的原文写法（§2 第 2 条），以及快照（snapshot/Snapshot.md）。
 * 命令行见 tools/validate.ts。
 */

import { type Jki, type Jkm, type Jks, parseJson } from "../model.ts";
import type { Snapshot } from "../../snapshot/snapshot.ts";
import { jkm, jks, syncInput } from "./fixtures.ts";

type Any = Record<string, unknown>;

/** 合法的基准模型：G1 为输入；G2 以 Q1 为事务前置，事务推进到 Q2、Q3、G2.G1.Q1。 */
export function base(): Jkm {
  return jkm("FIX",
    jks("G1", [{ id: "Q1", q: 1, trigger: { any: [] } }, { id: "Q2", q: 1, trigger: { any: [] } }], { any: ["Q1", "Q2"] }),
    jks("G2", [
      { id: "Q1", q: 0, trigger: { any: ["G1.Q1"] } },
      { id: "Q2", q: 0, trigger: { any: ["Q1"] }, sources: { seed: 0, s: ["Q1"], ex: ["K"] } },
      { id: "Q3", q: 0, trigger: { all: ["Q1", "Q2"] }, runtime: { trigger_all: [null, null] } },
      jks("G1", [{ id: "Q1", q: 0, trigger: { any: ["G2.Q2"] } }], { any: ["Q1"] }),
    ], { transaction: ["Q1"] }),
  );
}

/** 根 id 后接各层成员 id 所指的对象。 */
function node(model: Jkm, ...path: string[]): Any {
  let obj = model.roots.find((r) => r.id === path[0]) as unknown as Any;
  for (const part of path.slice(1)) {
    obj = (obj.members as Any[]).find((m) => m.id === part)!;
  }
  return obj;
}

const mutate = (fn: (m: Jkm) => void) => () => {
  const model = base();
  fn(model);
  return model;
};
const set = (obj: Any, fields: Any) => void Object.assign(obj, fields);
const drop = (obj: Any, key: string) => void delete obj[key];
const sources = (m: Jkm, ...path: string[]) => node(m, ...path).sources as Any;
const members = (m: Jkm, ...path: string[]) => node(m, ...path).members as unknown[];

/** [名称, 构造, 预期错误片段] */
export const NEGATIVE: [string, () => unknown, string][] = [
  ["seed 为 null", mutate((m) => set(sources(m, "G2", "Q2"), { seed: null })), "sources.seed 只能是 0 或 1"],
  ["q 为字符串", mutate((m) => set(node(m, "G2", "Q1"), { q: "1" })), "q 必须是整数 0 或 1"],
  ["q 为布尔值", mutate((m) => set(node(m, "G2", "Q1"), { q: true })), "q 必须是整数 0 或 1"],
  ["未批准的 JKI 字段", mutate((m) => set(node(m, "G2", "Q1"), { state: 0 })), "未批准的 JKI 字段"],
  ["trigger 同时有 any 和 all", mutate((m) => set(node(m, "G2", "Q1"), { trigger: { any: ["G1.Q1"], all: ["G1.Q2"] } })),
    "trigger 必须恰好有 any 或 all"],
  ["trigger.all 为空", mutate((m) => set(node(m, "G2", "Q3"), { trigger: { all: [] }, runtime: { trigger_all: [] } })),
    "trigger.all 不得为空"],
  ["ex 与 s 不等长", mutate((m) => set(sources(m, "G2", "Q2"), { ex: ["K", "J"] })), "必须与 s 等长"],
  ["publish 集合错误", mutate((m) => set(node(m, "G2", "Q2"), { publish: { always: [1, 0] } })), "publish 必须是七种模式之一"],
  ["publish 未知模式", mutate((m) => set(node(m, "G2", "Q2"), { publish: { rising: [1] } })), "publish 必须是七种模式之一"],
  ["all 节点缺少记录", mutate((m) => drop(node(m, "G2", "Q3"), "runtime")), "all 节点必须保留"],
  ["all 记录长度不符", mutate((m) => set(node(m, "G2", "Q3"), { runtime: { trigger_all: [null] } })), "all 节点必须保留"],
  ["any 节点保存记录", mutate((m) => set(node(m, "G2", "Q2"), { runtime: { trigger_all: [null] } })), "any 节点不保存 trigger_all"],
  ["pro 未批准字段", mutate((m) => set(node(m, "G2", "Q2"), { pro: { atomic: true } })), "pro 含未批准字段"],
  ["id 不是 Q＋数字", mutate((m) => set(node(m, "G2", "Q2"), { id: "B1" })), "id 必须是 Q＋不带前导零的正整数"],
  ["JKS id 是 Q＋数字", mutate((m) => set(node(m, "G2", "G1"), { id: "Q9" })), "JKS id 必须是 G＋不带前导零的正整数"],
  ["JKS id 带名称", mutate((m) => set(node(m, "G2"), { id: "G_TX" })), "JKS id 必须是 G＋不带前导零的正整数"],
  ["JKS 缺 thread", mutate((m) => drop(node(m, "G2", "G1"), "thread")), "JKS 缺少必填字段"],
  ["JKS 缺 trigger", mutate((m) => drop(node(m, "G2", "G1"), "trigger")), "JKS 缺少必填字段"],
  ["JKS 多出字段", mutate((m) => set(node(m, "G2", "G1"), { state: {} })), "JKS 含未批准字段"],
  ["JKS.trigger 没有登记", mutate((m) => set(node(m, "G2", "G1"), { trigger: {} })), "JKS.trigger 至少要有一个登记"],
  ["JKS.pro 为 null", mutate((m) => set(node(m, "G2"), { pro: null })), "JKS.pro 必须是对象"],
  ["JKS.runtime 为 null", mutate((m) => set(node(m, "G2"), { runtime: null })), "JKS.runtime 内部格式未定义"],
  ["roots 为空", mutate((m) => void m.roots.splice(0)), "roots 必须是非空数组"],
  ["JKI id 带前导零", mutate((m) => set(node(m, "G2", "Q2"), { id: "Q02" })), "id 必须是 Q＋不带前导零的正整数"],
  ["JKS id 带前导零", mutate((m) => set(node(m, "G2", "G1"), { id: "G01" })), "JKS id 必须是 G＋不带前导零的正整数"],
  ["threads 含空串", mutate((m) => set(m as unknown as Any, { threads: ["work", ""] })), "threads 必须是非空、无重复的数组"],
  ["trigger 含空串", mutate((m) => set(node(m, "G2", "Q2"), { trigger: { any: ["Q1", ""] } })), "trigger.any 必须是非空字符串组成的数组"],
  ["sources.s 含空串", mutate((m) => set(sources(m, "G2", "Q2"), { s: [""] })), "sources.s 必须是非空字符串组成的数组"],
  ["pro.tag 含空串", mutate((m) => set(node(m, "G2", "Q2"), { pro: { tag: [""] } })), "pro.tag 必须是非空字符串组成的数组"],
  ["登记含空串", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["Q1", ""] } })), "必须是非空的前置 ID 数组"],
  ["JKS.pro 未批准字段", mutate((m) => set(node(m, "G2"), { pro: { atomic: true } })), "JKS.pro 含未批准字段"],
  ["JKS.pro.tag 非字符串", mutate((m) => set(node(m, "G2"), { pro: { tag: [1] } })), "JKS.pro.tag 必须是非空字符串"],
  ["JKS.runtime 非空", mutate((m) => set(node(m, "G2"), { runtime: { pending: [] } })), "JKS.runtime 内部格式未定义"],
  ["thread 未声明", mutate((m) => set(node(m, "G2"), { thread: "fast" })), "thread 必须是 JKM.threads 中声明的名称"],
  ["JKM 版本错误", mutate((m) => set(m as unknown as Any, { version: "6.0.0" })), "version 必须是"],
  ["JKM 多出字段", mutate((m) => set(m as unknown as Any, { runtime: {} })), "JKM 字段必须恰好"],
  ["JKM 缺少 input", mutate((m) => drop(m as unknown as Any, "input")), "JKM 字段必须恰好"],
  ["input 不是对象", mutate((m) => set(m as unknown as Any, { input: ["G1.any"] })), "input 必须是对象"],
  ["input 的值为空数组", mutate((m) => set(m as unknown as Any, { input: { "G1.any": [] } })), "input 必须是对象"],
  ["input 漏列含入口的根登记", mutate((m) => set(m as unknown as Any, { input: {} })), "input 缺少 G1.any"],
  ["input 多列不含入口的根登记", mutate((m) => set(m.input, { "G2.transaction": ["Q1"] })), "input.G2.transaction 不是根 JKS.trigger 中含输入入口的登记"],
  ["input 列出子 JKS 的登记", mutate((m) => set(m.input, { "G2.G1.any": ["Q1"] })), "input.G2.G1.any 不是根 JKS.trigger 中含输入入口的登记"],
  ["input 与根登记顺序不同", mutate((m) => set(m.input, { "G1.any": ["Q2", "Q1"] })), "input.G1.any 必须与根 JKS.trigger 中的登记逐项相同"],
  ["input 少写根登记的前置", mutate((m) => set(m.input, { "G1.any": ["Q1"] })), "input.G1.any 必须与根 JKS.trigger 中的登记逐项相同"],
  ["JKM 缺少 output", mutate((m) => drop(m as unknown as Any, "output")), "JKM 字段必须恰好"],
  ["output 不是对象", mutate((m) => set(m as unknown as Any, { output: "G2.Q2" })), "output 必须是对象"],
  ["output 是数组", mutate((m) => set(m as unknown as Any, { output: ["G2.Q2"] })), "output 必须是对象"],
  ["output 的组为空", mutate((m) => set(m as unknown as Any, { output: { data: [] } })), "output 必须是对象"],
  ["output 组内重复", mutate((m) => set(m as unknown as Any, { output: { data: ["G2.Q2", "G2.Q2"] } })), "output 的成员在全部组中不得重复"],
  ["output 组间重复", mutate((m) => set(m as unknown as Any, { output: { data: ["G2.Q2"], done: ["G2.Q2"] } })), "output 的成员在全部组中不得重复"],
  ["output 落到 JKS", mutate((m) => set(m as unknown as Any, { output: { data: ["G2"] } })), "不是 JKI 绝对路径"],
  ["output 写短 ID", mutate((m) => set(m as unknown as Any, { output: { data: ["Q2"] } })), "不是 JKI 绝对路径"],
  ["threads 重复", mutate((m) => set(m as unknown as Any, { threads: ["work", "work"] })), "threads 必须是非空、无重复的数组"],
  ["members 写成 ID", mutate((m) => void members(m, "G2").push("Q9")), "成员必须是完整对象"],
  ["同层 id 重复", mutate((m) => void members(m, "G2").push({ id: "Q2", q: 0, trigger: { any: ["Q1"] } })), "同层成员 id 重复"],
  ["根 id 重复", mutate((m) => void m.roots.push(jks("G1", [{ id: "Q1", q: 1, trigger: { any: [] } }], { any: ["Q1"] }))), "根 id 重复"],
  ["短 ID 跨层", mutate((m) => set(node(m, "G2", "G1", "Q1"), { trigger: { any: ["Q2"] } })), "短 ID Q2 不是"],
  ["引用落到 JKS", mutate((m) => set(node(m, "G2", "Q2"), { trigger: { any: ["G2.G1"] } })), "落到 JKS"],
  ["引用不存在", mutate((m) => set(sources(m, "G2", "Q2"), { s: ["G2.Q7"] })), "绝对路径 G2.Q7 不存在"],
  ["trigger 短 ID 与路径重复", mutate((m) => set(node(m, "G2", "Q2"), { trigger: { any: ["Q1", "G2.Q1"] } })), "属于重复"],
  ["未定义的登记类型", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["Q1"], sync: ["Q2"] } })), "未定义的登记类型"],
  ["登记为空数组", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["Q1"], all: [] } })), "必须是非空的前置 ID 数组"],
  ["登记外部节点", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["G1.Q1"] } })), "登记只能写本层直接成员的短 ID"],
  ["登记直接成员写绝对路径", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["G2.Q1"] } })), "登记只能写本层直接成员的短 ID"],
  ["登记嵌套成员", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["Q1"], all: ["G2.G1.Q1"] } })), "不能登记嵌套成员"],
  ["登记短 ID 不在本层", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["Q1", "Q9"] } })), "短 ID Q9 不是"],
  ["跨类型重复登记", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["Q1"], all: ["Q1"] } })), "重复登记"],
  ["退出节点同时登记为其他类型", mutate((m) => set(node(m, "G2"), { trigger: { transaction: ["Q1"], out: ["Q1"] } })), "重复登记"],
  ["未登记节点写空 any", mutate((m) => set(node(m, "G2", "Q2"), { trigger: { any: [] } })), "只允许用于已登记的输入入口"],
  ["子 JKS 中的待对接入口", mutate((m) => set(node(m, "G2", "G1", "Q1"), { trigger: { any: [] } })), "只允许用于根 JKS 的直接成员"],
  ["事务内的环没有退出节点", mutate((m) => set(node(m, "G2", "Q2"), { trigger: { any: ["Q1", "G2.G1.Q1"] } })), "没有登记为 out 的退出节点"],
  ["事务下游的环没有退出节点", mutate((m) => void m.roots.push(jks("G3", [
    { id: "Q1", q: 0, trigger: { any: ["G2.Q2", "Q2"] }, sources: { seed: 1, s: ["Q1"], ex: ["K"] } },
    { id: "Q2", q: 0, trigger: { any: ["Q1"] }, sources: { seed: 0, s: ["Q1"], ex: ["K"] } },
  ], { any: ["Q1"] }))), "没有登记为 out 的退出节点"],
  ["事务不可达的环没有退出节点", mutate((m) => void members(m, "G1").push(
    { id: "Q3", q: 0, trigger: { any: ["Q1", "Q4"] }, sources: { s: ["Q4"], ex: ["K"] } },
    { id: "Q4", q: 0, trigger: { any: ["Q3"] }, sources: { seed: 1, s: ["Q3"], ex: ["K"] }, publish: { one_changed: [1] } })),
  "没有登记为 out 的退出节点"],
  ["定义中 trigger_all 非 null", mutate((m) => set(node(m, "G2", "Q3"), { runtime: { trigger_all: [0, null] } })),
    "定义中的 runtime.trigger_all 必须全为 null"],
  ["pro.jksid 不存在", mutate((m) => set(node(m, "G2", "Q2"), { pro: { jksid: "G9" } })), "pro.jksid 必须是实际 JKS 的绝对路径"],
  ["pro.jksid 指向 JKI", mutate((m) => set(node(m, "G2", "Q2"), { pro: { jksid: "G2.Q1" } })), "pro.jksid 必须是实际 JKS 的绝对路径"],
  ["纯通知环（已登记退出节点）", mutate((m) => {
    members(m, "G1").push(
      { id: "Q3", q: 1, trigger: { any: ["Q1", "Q4"] } },
      { id: "Q4", q: 0, trigger: { any: ["Q3"] }, publish: { zero: [0] } });
    set(node(m, "G1"), { trigger: { any: ["Q1", "Q2"], out: ["Q4"] } });
  }), "纯通知环"],
];

/** 从事务不可达的环（计数器），退出节点 Q3 登记为 out。 */
function loopModel(): Jkm {
  return jkm("FIX", jks("G1", [
    { id: "Q1", q: 1, trigger: { any: [] } },
    { id: "Q2", q: 0, trigger: { any: ["Q1", "Q3"] }, sources: { s: ["Q3"], ex: ["K"] } },
    { id: "Q3", q: 0, trigger: { any: ["Q2"] }, sources: { seed: 1, s: ["Q2"], ex: ["K"] } },
  ], { any: ["Q1"], out: ["Q3"] }));
}

/** 从事务可达的环，分别以三种退出结构退出（§6.4）；退出节点 Q2 登记为 out。 */
function exitLoop(kind: "publish" | "all" | "gate"): () => Jkm {
  return () => {
    const model = base();
    const q1: Jki = { id: "Q1", q: 0, trigger: { any: ["G2.Q2", "Q2"] }, sources: { seed: 1, s: ["Q1"], ex: ["K"] } };
    const q2: Jki = { id: "Q2", q: 0, trigger: { any: ["Q1"] }, sources: { seed: 0, s: ["Q1"], ex: ["K"] } };
    const members: Jki[] = [q1, q2];
    let trigger: Jks["trigger"] = { any: ["Q1"], out: ["Q2"] };
    if (kind === "publish") q2.publish = { one_changed: [1] }; // 发布取决于结果
    if (kind === "all") { // 等环外的来源 G1.Q2
      q2.trigger = { all: ["Q1", "G1.Q2"] };
      q2.runtime = { trigger_all: [null, null] };
    }
    if (kind === "gate") { // Q1→Q2 经 JKS all 整合，该登记有环外的前置 G3.Q3
      members.push({ id: "Q3", q: 1, trigger: { any: [] } });
      trigger = { all: ["Q1", "Q3"], out: ["Q2"] };
    }
    model.roots.push(jks("G3", members, trigger));
    return model;
  };
}

/** 事务登记的 JKS 的成员由 JKS 以外的节点触发（第 6 节不再限制）。 */
function externalTriggerModel(): Jkm {
  const model = base();
  set(node(model, "G2", "Q2"), { trigger: { any: ["Q1", "G1.Q2"] } });
  return model;
}

/** 会停下的空 EX 环：环上的退出节点 Q4 不发布。 */
function quietLoopModel(): Jkm {
  const model = base();
  members(model, "G1").push(
    { id: "Q3", q: 1, trigger: { any: ["Q1", "Q4"] } },
    { id: "Q4", q: 1, trigger: { any: ["Q3"] }, publish: { zero: [0] } });
  node(model, "G1").trigger = { any: ["Q1", "Q2"], out: ["Q4"] };
  return model;
}

function explicitEmptyModel(): Jkm {
  const model = base();
  model.output = { data: ["G2.Q2"], done: ["G2.G1.Q1"] };
  node(model, "G2", "Q2").pro = { jksid: "G2.G1" };
  set(node(model, "G2", "Q1"), { sources: {}, publish: {}, pro: {} });
  node(model, "G2").trigger = { transaction: ["Q1"], ack: ["Q3"] };
  node(model, "G2").pro = { tag: ["tx"] };
  node(model, "G1").pro = { tag: [] };
  set(node(model, "G2", "G1"), { pro: {}, runtime: {} });
  return model;
}

const POSITIVE_MODELS: [string, () => Jkm][] = [
  ["基准模型", base],
  ["从事务不可达的环，退出节点登记为 out", loopModel],
  ["事务登记的 JKS 的成员由外部触发", externalTriggerModel],
  ["事务可达的环：退出节点按 publish 退出", exitLoop("publish")],
  ["事务可达的环：退出节点 all 等环外来源", exitLoop("all")],
  ["事务可达的环：退出节点经 JKS all 整合，有环外前置", exitLoop("gate")],
  ["显式空对象（含 JKS 的 pro、runtime）、ack 登记、JKS.pro.tag、pro.jksid 与 output", explicitEmptyModel],
  ["会停下的空 EX 环，退出节点登记为 out", quietLoopModel],
];

/** 正例在改动根登记后都按 §8.1 重写 input。 */
export const POSITIVE: [string, () => unknown][] = POSITIVE_MODELS.map(([name, build]) => [name, () => syncInput(build())]);

// ---------------------------------------------------------------------------
// bit 的原文写法（§2 第 2 条）
// ---------------------------------------------------------------------------

/** 基准模型的 JSON 文本，把其中第一处 from 改写成 to。 */
const spell = (from: string, to: string) => () => {
  const text = JSON.stringify(base());
  if (!text.includes(from)) throw new Error(`基准模型的文本中没有 ${from}`);
  return text.replace(from, to);
};

/** [名称, JKM 的 JSON 文本, 预期错误片段；null 表示应当通过]。文本先经 parseJson 解析，再做静态检查。 */
export const TEXT_CASES: [string, () => string, string | null][] = [
  ["bit 写成 0、1", () => JSON.stringify(base()), null],
  ["q 写成 1.0", spell('"q":1', '"q":1.0'), "q 必须是整数 0 或 1"],
  ["q 写成 1e0", spell('"q":1', '"q":1e0'), "q 必须是整数 0 或 1"],
  ["q 写成 -0", spell('"q":0', '"q":-0'), "q 必须是整数 0 或 1"],
  ["seed 写成 0.0", spell('"seed":0', '"seed":0.0'), "sources.seed 只能是 0 或 1"],
];

// ---------------------------------------------------------------------------
// 快照（snapshot/Snapshot.md）
// ---------------------------------------------------------------------------

/** 基准模型的一个合法快照：G2.Q3（all）已到达一个来源，两个 FIFO 各有待处理的项。 */
export function baseSnapshot(): Snapshot {
  return {
    snapshot: "S1", jkm: "FIX", version: "7.0.0",
    q: { "G1.Q1": 1, "G1.Q2": 1, "G2.Q1": 0, "G2.Q2": 0, "G2.Q3": 0, "G2.G1.Q1": 0 },
    trigger_all: { "G2.Q3": [0, null] },
    rounds: {},
    threads: { work: { events: [{ source: "G1.Q1" }], tasks: [{ node: "G2.Q2" }, { tx: "G2", prereqs: ["G2.Q1"] }] } },
  };
}

/** 基准模型改用 transaction_any 登记两个前置；每个事务任务只含发出通知的那一个前置（§5.3）。 */
function anyModel(): Jkm {
  const model = base();
  node(model, "G2").trigger = { transaction_any: ["Q1", "Q2"] };
  return model;
}

/** 基准模型声明两个 thread，G2 改在 fast；G2.G1 仍在 work。 */
function twoThreads(): Jkm {
  const model = base();
  model.threads = ["work", "fast"];
  node(model, "G2").thread = "fast";
  return model;
}

type SnapshotCase = { model: Jkm; snapshot: unknown };
const snap = (fn: (s: Any) => void, model: () => Jkm = base) => (): SnapshotCase => {
  const snapshot = baseSnapshot() as unknown as Any;
  fn(snapshot);
  return { model: model(), snapshot };
};
const work = (s: Any) => (s.threads as Any).work as Any;
const task = (item: unknown, model?: () => Jkm) => snap((s) => set(work(s), { tasks: [item] }), model);

/** [名称, 模型与快照, 预期错误片段；null 表示应当通过] */
export const SNAPSHOT_CASES: [string, () => SnapshotCase, string | null][] = [
  ["基准快照", snap(() => {}), null],
  ["transaction_any 的事务任务只含一个前置", task({ tx: "G2", prereqs: ["G2.Q2"] }, anyModel), null],
  ["两个 thread：各项在 §7.4 规定的 thread 下", snap((s) => set(s, { threads: {
    work: { events: [{ source: "G1.Q1" }], tasks: [] },
    fast: { events: [{ source: "G2.Q1" }], tasks: [{ node: "G2.Q2" }, { tx: "G2", prereqs: ["G2.Q1"] }] },
  } }), twoThreads), null],
  ["多出字段", snap((s) => set(s, { units: 3 })), "快照字段必须恰好"],
  ["snapshot 不是字符串", snap((s) => set(s, { snapshot: 7 })), "snapshot 必须是非空字符串"],
  ["jkm 不是对应的模型", snap((s) => set(s, { jkm: "OTHER" })), "jkm 必须是对应模型的 jkm"],
  ["版本错误", snap((s) => set(s, { version: "6.0.0" })), "version 必须是"],
  ["q 缺少节点", snap((s) => drop(s.q as Any, "G2.Q3")), "q 必须给出全部 JKI"],
  ["q 为布尔值", snap((s) => set(s.q as Any, { "G2.Q1": true })), "q 必须给出全部 JKI"],
  ["q 写成 1.0", () => ({ model: base(), snapshot: parseJson(JSON.stringify(baseSnapshot()).replace('"G1.Q1":1', '"G1.Q1":1.0')) }),
    "q 必须给出全部 JKI"],
  ["trigger_all 不是对象", snap((s) => set(s, { trigger_all: [1] })), "trigger_all 必须是对象"],
  ["trigger_all 列出 any 节点", snap((s) => set(s.trigger_all as Any, { "G2.Q2": [0] })), "trigger_all 中 G2.Q2 的记录不合法"],
  ["trigger_all 全为 null", snap((s) => set(s.trigger_all as Any, { "G2.Q3": [null, null] })), "trigger_all 中 G2.Q3 的记录不合法"],
  ["trigger_all 已齐备", snap((s) => set(s.trigger_all as Any, { "G2.Q3": [0, 1] })), "trigger_all 中 G2.Q3 的记录不合法"],
  ["rounds 不是对象", snap((s) => set(s, { rounds: "x" })), "rounds 必须是对象"],
  ["rounds 的键不是 JKS", snap((s) => set(s, { rounds: { "G2.Q1": { transaction: ["G2.Q1"] } } })), "不是 JKS 绝对路径"],
  ["rounds 列出已到齐的一轮", snap((s) => set(s, { rounds: { G2: { transaction: ["G2.Q1"] } } })), "只能列出未到齐的本轮前置"],
  ["rounds 的 JKS 下没有记录", snap((s) => set(s, { rounds: { G2: {} } })), "只列不为空的轮记录"],
  ["threads 的键未声明", snap((s) => set(s, { threads: { fast: { events: [], tasks: [] } } })), "threads 的键必须是"],
  ["事件来源不是 JKI", snap((s) => set(work(s), { events: [{ source: "G2" }] })), "事件项不合法"],
  ["事件项带接收者", snap((s) => set(work(s), { events: [{ source: "G1.Q1", to: "G2.Q1" }] })), "事件项不合法"],
  ["事件不在来源所属 JKS 的 thread", snap((s) => set(work(s), { events: [{ source: "G2.Q1" }], tasks: [] }), twoThreads), "事件项不合法"],
  ["节点任务不在目标所属 JKS 的 thread", task({ node: "G2.Q2" }, twoThreads), "任务项不合法"],
  ["事务任务不在登记它的 JKS 的 thread", task({ tx: "G2", prereqs: ["G2.Q1"] }, twoThreads), "任务项不合法"],
  ["节点任务的目标是空 EX", task({ node: "G2.Q1" }), "任务项不合法"],
  ["事务任务的目标没有事务登记", task({ tx: "G1", prereqs: ["G1.Q1"] }), "任务项不合法"],
  ["事务任务没有前置", task({ tx: "G2", prereqs: [] }), "任务项不合法"],
  ["事务任务的前置重复", task({ tx: "G2", prereqs: ["G2.Q1", "G2.Q1"] }), "任务项不合法"],
  ["事务任务的前置不属于事务登记", task({ tx: "G2", prereqs: ["G2.Q2"] }), "任务项不合法"],
  ["transaction_any 的事务任务含两个前置", task({ tx: "G2", prereqs: ["G2.Q1", "G2.Q2"] }, anyModel), "任务项不合法"],
];
