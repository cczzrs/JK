/** 验收案例与随机测试用的模型构造。 */

import { type Jki, type Jkm, type Jks, Model, PUBLISH, PUBLISH_MODES } from "../model.ts";
import { CpuExecutor, type CpuOptions } from "../cpu.ts";
import type { Random } from "./random.ts";

export function jkm(name: string, ...roots: Jks[]): Jkm {
  return { jkm: name, version: "7.0.0", threads: ["work"], roots };
}

export function jks(id: string, members: (Jki | Jks)[], trigger: Jks["trigger"]): Jks {
  return { id, thread: "work", trigger, members };
}

/** 每次触发都翻转自身的节点。 */
function toggle(id: string, ...from: string[]): Jki {
  return { id, q: 0, trigger: { any: from }, sources: { seed: 1, s: [id], ex: ["K"] } };
}

/**
 * JKRD7 §6.3：三层嵌套事务。G1 的事务（transaction_any）推进到 G2 的 transaction 登记，
 * G2 的事务再推进到 G3 的 transaction_any 登记。
 */
export function inlineModel(): Jkm {
  return jkm("M_INLINE",
    jks("G1", [...inputs("Q1"), toggle("Q2", "Q1")], { transaction_any: ["Q1"] }),
    jks("G2", [{ id: "Q1", q: 1, trigger: { any: ["G1.Q2"] } }, toggle("Q2", "Q1")], { transaction: ["Q1"] }),
    jks("G3", [{ id: "Q1", q: 1, trigger: { any: ["G2.Q2"] } }, toggle("Q2", "Q1")], { transaction_any: ["Q1"] }));
}

/**
 * JKRD7 §6.3：嵌套事务连续执行完，外层才继续。G1 的事务中，G1.Q2 推进到 G2 的 transaction 登记，
 * 外层还排着 G1.Q3、G1.Q4。节点任务的顺序应为 G1.Q2、G1.Q3、G2.Q2、G2.Q3、G1.Q4。
 */
export function nestOrderModel(): Jkm {
  return jkm("M_NEST2",
    jks("G1", [...inputs("Q1"), toggle("Q2", "Q1"), toggle("Q3", "Q1"), toggle("Q4", "Q3")], { transaction_any: ["Q1"] }),
    jks("G2", [{ id: "Q1", q: 1, trigger: { any: ["G1.Q2"] } }, toggle("Q2", "Q1"), toggle("Q3", "Q2")], { transaction: ["Q1"] }));
}

/**
 * JKRD7 §6.4：环上有退出结构（G1.Q3 的 publish 不是 always），所以通过静态检查。
 * publish 为 one_changed 时每次请求循环两次后退出；为 always_changed 时永不退出，由事务步数上限拦住。
 */
export function exitLoopModel(mode: "one_changed" | "always_changed"): Jkm {
  const q3: Jki = { id: "Q3", q: 0, trigger: { any: ["Q2"] }, sources: { seed: 0, s: ["Q2"], ex: ["K"] }, publish: { [mode]: mode === "one_changed" ? [1] : [0, 1] } };
  return jkm("M_EXIT", jks("G1", [...inputs("Q1"), toggle("Q2", "Q1", "Q3"), q3], { transaction_any: ["Q1"] }));
}

/** 输入入口：q=1，trigger.any=[]。 */
export function inputs(...ids: string[]): Jki[] {
  return ids.map((id) => ({ id, q: 1, trigger: { any: [] } }));
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

/** 加载模型、按顺序注入一批输入并运行到静止。 */
export function run(data: unknown, injections: readonly string[], options: CpuOptions = {}, source = "case"): CpuExecutor {
  const ref = new CpuExecutor(new Model(data, source), options);
  for (const item of injections) ref.inject(item);
  ref.run();
  return ref;
}

/** 依次注入多批输入，每批之后运行到静止（§9.4 的执行方式）。 */
export function runBatches(data: unknown, batches: readonly (readonly string[])[], options: CpuOptions = {}): CpuExecutor {
  const ref = new CpuExecutor(new Model(data, "random"), options);
  for (const batch of batches) {
    for (const item of batch) ref.inject(item);
    ref.run();
  }
  return ref;
}

/** 打乱每个 JKS 的 members 书写顺序。 */
export function shuffled(data: Jkm, rng: Random): Jkm {
  const copy = clone(data);
  const walk = (obj: Jks) => {
    rng.shuffle(obj.members);
    for (const member of obj.members) if ("members" in member) walk(member);
  };
  copy.roots.forEach(walk);
  return copy;
}

/**
 * 一个随机的合法模型：根下有输入与普通节点，事务子结构 G1.G1，同步子结构 G1.G2。
 * 覆盖事务、JKS all、事务推进到事务登记的 JKS 以外、JKI all 与七种 publish。
 */
export function randomModel(rng: Random): Jkm {
  const node = (id: string, triggers: string[], pool: string[]): Jki => {
    const n: Jki = { id, q: rng.randint(0, 1) as 0 | 1, trigger: { any: triggers } };
    if (triggers.length > 1 && rng.random() < 0.3) {
      n.trigger = { all: triggers };
      n.runtime = { trigger_all: triggers.map(() => null) };
    }
    if (rng.random() < 0.75) {
      const s = Array.from({ length: rng.randint(1, 3) }, () => rng.choice(pool));
      n.sources = { s, ex: s.map(() => rng.choice(["J", "K"] as const)) };
      if (rng.random() < 0.5) n.sources.seed = rng.randint(0, 1) as 0 | 1;
    }
    const mode = rng.choice(PUBLISH_MODES);
    n.publish = { [mode]: [...PUBLISH[mode]] };
    return n;
  };
  const pick = (pool: string[], most = 3) => rng.sample(pool, rng.randint(1, Math.min(most, pool.length)));
  const range = (lo: number, hi: number) => Array.from({ length: hi - lo }, (_, i) => lo + i);

  const txIds = range(1, 8).map((i) => `Q${i}`);
  const syncIds = range(1, 6).map((i) => `Q${i}`);
  const pool = [
    ...range(1, 9).map((i) => `G1.Q${i}`),
    ...txIds.map((q) => `G1.G1.${q}`),
    ...syncIds.map((q) => `G1.G2.${q}`),
  ];
  const rootRefs = range(1, 7).map((j) => `G1.Q${j}`);
  const root: Jki[] = inputs("Q1", "Q2", "Q3");
  for (const i of [4, 5, 6]) root.push(node(`Q${i}`, pick(range(1, i).map((j) => `Q${j}`)), pool));

  const nPre = rng.choice([1, 2]);
  const txMembers: Jki[] = range(1, nPre + 1).map((i) => node(`Q${i}`, pick(rootRefs), pool));
  for (const i of range(nPre + 1, 8)) txMembers.push(node(`Q${i}`, pick(range(1, i).map((j) => `Q${j}`)), pool));
  const kind = rng.choice(["transaction", "transaction_any"] as const);
  const tx = jks("G1", txMembers, { [kind]: range(1, nPre + 1).map((i) => `Q${i}`) });

  const syncMembers: Jki[] = [1, 2].map((i) => node(`Q${i}`, pick(rootRefs), pool));
  for (const i of [3, 4, 5]) syncMembers.push(node(`Q${i}`, pick(range(1, i).map((j) => `Q${j}`)), pool));
  const sync = jks("G2", syncMembers, { all: ["Q1", "Q2"] });

  const late = [...txIds.slice(nPre).map((q) => `G1.G1.${q}`), ...syncIds.map((q) => `G1.G2.${q}`)];
  for (const i of [7, 8]) root.push(node(`Q${i}`, pick(late), pool));
  const data = jkm("RANDOM", jks("G1", [...root, tx, sync], { any: ["Q1", "Q2", "Q3"] }));
  const model = new Model(data, "random");
  if (model.errors.length) throw new Error("随机模型不合法：\n" + model.errors.join("\n"));
  return data;
}

/** 随机的输入批：1—4 批，每批 1—3 个输入入口 G1.Q1—G1.Q3。 */
export function randomBatches(rng: Random): string[][] {
  return Array.from({ length: rng.randint(1, 4) }, () =>
    Array.from({ length: rng.randint(1, 3) }, () => `G1.Q${rng.randint(1, 3)}`));
}

/** 十选一的观察：Q24 发布时读 8 个输出 bit。 */
export const ASCII_WATCH = ["G1.Q24"];
export const ASCII_READ = [11, 12, 13, 14, 25, 26, 27, 28].map((i) => `G1.Q${i}`);

/** 十选一的随机输入批：1—3 批，每批 1—4 个数字。 */
export function asciiBatches(rng: Random): string[][] {
  return Array.from({ length: rng.randint(1, 3) }, () =>
    Array.from({ length: rng.randint(1, 4) }, () => `G1.Q${rng.randint(1, 10)}`));
}

/** 与键顺序无关的深比较（用于快照等 JSON 对象）。 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b
      && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
