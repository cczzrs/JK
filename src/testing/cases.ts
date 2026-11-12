/** JKRD7 §11.2 的验收案例（CPU 后端）。命令行见 tools/reference.ts。 */

import { type Jki, type Jkm, type RunScript, Model } from "../model.ts";
import type { Snapshot } from "../../snapshot/snapshot.ts";
import { loadSnapshot, takeSnapshot } from "../../snapshot/cpu.ts";
import { DOC_MODELS, docBlock, docFragment, docModels } from "../doc.ts";
import { CpuExecutor, TxLimit, Unsupported } from "../cpu.ts";
import { formatRecords } from "../record.ts";
import { runScriptCpu } from "../executor.ts";
import { Random } from "./random.ts";
import {
  asciiBatches, asciiCodes, clone, deepEqual, exitLoopModel, inlineModel, inputs, jkm, jks, nestOrderModel,
  randomBatches, randomModel, run, runBatches, shuffled, syncInput,
} from "./fixtures.ts";

export interface CaseResult {
  case: string;
  passed: boolean;
  detail: string;
}

export interface CaseContext {
  /** JKRD7.md 全文。 */
  doc: string;
  /** snapshot/Snapshot.md 全文。 */
  snapshotDoc: string;
  /** 十选一模型（assets/ascii-bit-design/digits.jkm.json）。 */
  ascii: Jkm;
  /** 按仓库相对路径读取模型文件（运行脚本的 model 字段）。 */
  loadModel(path: string): unknown;
}

const hex = (codes: number[]) => JSON.stringify(codes.map((c) => "0x" + c.toString(16)));
const same = (a: CpuExecutor, b: CpuExecutor) => formatRecords(a.record()) === formatRecords(b.record());

/** 第 10 节各模型的一批输入，用于批执行与 GPU 对拍。输出观察取自各模型的 output。 */
const DOC_INPUTS: Record<(typeof DOC_MODELS)[number], string[]> = {
  M_FLOW: ["G1.Q1", "G1.Q3"],
  M_PATH: ["G1.Q1"],
  M_SYNC: ["G1.Q1", "G1.Q1", "G1.Q2"],
  M_TX: ["G1.Q10", "G1.Q10"],
  M_NEST: ["G1.Q10"],
  M_REG: ["G1.Q2", "G1.Q1", "G1.Q2"],
};
export const DOC_RUNS: [string, string[]][] = DOC_MODELS.map((name) => [name, DOC_INPUTS[name]]);

export function runCases(ctx: CaseContext): CaseResult[] {
  const models = docModels(ctx.doc);
  const model = (name: string) => clone(models.get(name)!);
  const results: CaseResult[] = [];
  const check = (name: string, passed: boolean, detail: string) => results.push({ case: name, passed, detail });

  // 计算与 seed（M_FLOW）；changed 与 q_before 比较
  {
    const r = run(model("M_FLOW"), ["G1.Q1", "G1.Q3"]);
    const q5 = r.writes("G2.Q5");
    const q6 = r.writes("G2.Q6");
    const n5 = r.notifications("G2.Q5").length;
    const n6 = r.notifications("G2.Q6").length;
    check("计算与 seed（M_FLOW）", deepEqual([q5, q6, n5, n6], [[1, 0], [1, 1], 2, 2]),
      `Q5 结果 ${JSON.stringify(q5)}，Q6 结果 ${JSON.stringify(q6)}，通知 ${n5}／${n6}`);
    const data = model("M_FLOW");
    for (const node of data.roots[1].members as Jki[]) node.publish = { always_changed: [0, 1] };
    const r2 = run(data, ["G1.Q1", "G1.Q3"]);
    const c5 = r2.notifications("G2.Q5").length;
    const c6 = r2.notifications("G2.Q6").length;
    check("changed 与 q_before 比较", c5 === 2 && c6 === 1, `always_changed 时通知 Q5 ${c5} 次，Q6 ${c6} 次`);
  }

  // JKI all：A,A,B,B
  {
    const data = jkm("M_ALL", jks("G1", [...inputs("Q1", "Q2", "Q3"), docFragment(ctx.doc, "Q8")], { any: ["Q1", "Q2", "Q3"] }));
    const r = run(data, ["G1.Q1", "G1.Q1", "G1.Q3", "G1.Q3"]);
    const tasks = r.writes("G1.Q8").length;
    const record = r.triggerAll.get("G1.Q8");
    check("JKI all：A,A,B,B", tasks === 1 && deepEqual(record, [null, 0]), `Q8 计算 ${tasks} 次，记录 ${JSON.stringify(record)}`);
  }

  // 空 EX
  {
    const data = jkm("M_EMPTY", jks("G1", [...inputs("Q9", "Q10"), docFragment(ctx.doc, "Q17")], { any: ["Q9", "Q10"] }));
    const r = run(data, ["G1.Q9", "G1.Q10", "G1.Q9"]);
    const n = r.notifications("G1.Q17").length;
    const changed = clone(data);
    (changed.roots[0].members[2] as Jki).publish = { always_changed: [0, 1] };
    const r2 = run(changed, ["G1.Q9", "G1.Q10"]);
    const n2 = r2.notifications("G1.Q17").length;
    check("空 EX", n === 3 && r.count("q") === 0 && r.q.get("G1.Q17") === 1 && n2 === 0,
      `默认通知 ${n} 次、无节点任务、q 保持 1；always_changed 通知 ${n2} 次`);
  }

  // JKS all 同步（M_SYNC）
  {
    const r = run(model("M_SYNC"), ["G1.Q1", "G1.Q1", "G1.Q2"]);
    const pick = () => r.notifications().filter((n) => n === "G1.Q3" || n === "G1.Q4");
    const first = pick();
    r.inject("G1.Q2");
    r.run();
    const after = pick();
    check("JKS all 同步（M_SYNC）", deepEqual(first, ["G1.Q3", "G1.Q4"]) && deepEqual(after, first),
      `放行通知 ${JSON.stringify(first)}；再注入 Q2 后 ${JSON.stringify(after)}`);
  }

  // transaction 轮次
  {
    const members: Jki[] = [...inputs("Q1", "Q2"),
      { id: "Q3", q: 0, trigger: { any: ["Q1"] }, sources: { s: ["Q1"], ex: ["K"] } },
      { id: "Q4", q: 0, trigger: { any: ["Q2"] }, sources: { s: ["Q2"], ex: ["K"] } }];
    const r = run(jkm("M_ROUND", jks("G1", members, { transaction: ["Q1", "Q2"] })), ["G1.Q1", "G1.Q1", "G1.Q2", "G1.Q2"]);
    const left = r.rounds.get("G1|transaction")!;
    check("transaction 轮次", r.count("tx") === 1 && deepEqual(left, ["G1.Q2"]),
      `事务任务 ${r.count("tx")} 个，下一轮已记录 ${JSON.stringify(left)}`);
  }

  // 事务传播、事务内投递、不满足 publish 不推进、多实例顺序执行（M_TX）
  {
    const data = model("M_TX");
    const r = run(data, ["G1.Q10"]);
    check("事务传播（M_TX）", r.count("tx") === 1 && deepEqual(r.writes("G2.Q101"), [1]) && deepEqual(r.writes("G2.Q102"), [1]),
      `事务任务 ${r.count("tx")} 个，Q101 ${JSON.stringify(r.writes("G2.Q101"))}，Q102 ${JSON.stringify(r.writes("G2.Q102"))}`);
    check("事务内投递", deepEqual(r.outputs, [{ source: "G2.Q101", values: [1, 0] }, { source: "G2.Q102", values: [1, 1] }]),
      `output 为 [Q101, Q102]：输出模块在事务内收到 Q101 的通知时记录 ${JSON.stringify(r.outputs[0]?.values)}（Q102 尚未计算），`
      + `收到 Q102 的通知时记录 ${JSON.stringify(r.outputs[1]?.values)}`);
    const blocked = clone(data);
    (blocked.roots[0].members[0] as Jki).q = 0;
    (blocked.roots[1].members.find((m) => m.id === "Q101") as Jki).publish = { one: [1] };
    const rb = run(blocked, ["G1.Q10"]);
    check("不满足 publish 不推进", deepEqual(rb.writes("G2.Q101"), [0]) && rb.writes("G2.Q102").length === 0,
      `Q101 ${JSON.stringify(rb.writes("G2.Q101"))}，Q102 ${JSON.stringify(rb.writes("G2.Q102"))}`);
    const r2 = run(data, ["G1.Q10", "G1.Q10"]);
    const seq = r2.log.flatMap((e) => (e.kind === "tx" || e.kind === "tx_end" ? [e.kind] : e.kind === "q" ? [e.path] : []));
    check("多实例顺序执行", deepEqual(seq, [...["tx", "G2.Q101", "G2.Q102", "tx_end"], ...["tx", "G2.Q101", "G2.Q102", "tx_end"]]),
      `执行记录 ${JSON.stringify(seq)}`);
  }

  // 嵌套事务（M_NEST）
  {
    const r = run(model("M_NEST"), ["G1.Q10"]);
    const names = ["G2.G1.Q101", "G2.G1.Q102", "G2.G2.Q1", "G2.Q201"];
    const values = names.map((n) => r.writes(n));
    const targets = r.log.flatMap((e) => (e.kind === "tx" ? [`${e.g}@${e.depth}`] : []));
    const fromThread = r.log.flatMap((e) => (e.kind === "tx_enqueue" && e.depth === 0 ? [e.g] : []));
    check("嵌套事务（M_NEST）", deepEqual(fromThread, ["G2"]) && deepEqual(targets, ["G2@1", "G2.G1@2"])
      && values.every((v) => deepEqual(v, [1])),
      `进入 thread 的事务任务 ${JSON.stringify(fromThread)}，执行的事务（JKS@层）${JSON.stringify(targets)}，结果 ${JSON.stringify(values)}`);
  }

  // 先整合后照常投递
  {
    const build = (q3Trigger: Jki["trigger"], runtime?: Jki["runtime"]) => {
      const q3: Jki = { id: "Q3", q: 0, trigger: q3Trigger, sources: { seed: 0, s: ["G2.Q1"], ex: ["K"] } };
      if (runtime) q3.runtime = runtime;
      const g = jks("G1", [...inputs("Q1", "Q2"), q3,
        { id: "Q4", q: 0, trigger: { any: ["Q2"] }, sources: { seed: 0, s: ["Q2"], ex: ["K"] } }], { all: ["Q1", "Q2"] });
      const h = jks("G2", [{ id: "Q1", q: 0, trigger: { any: ["G1.Q2"] }, sources: { seed: 0, s: ["G1.Q2"], ex: ["K"] } }], { any: ["Q1"] });
      return run(jkm("M_ORDER", g, h), ["G1.Q1", "G1.Q2"]);
    };
    const r = build({ any: ["Q1"] });
    const order = r.log.flatMap((e) => (e.kind === "unit" && e.unit === "node" ? [e.path] : []));
    const waited = build({ all: ["Q1", "G2.Q1"] }, { trigger_all: [null, null] });
    const ok = deepEqual(order, ["G1.Q3", "G1.Q4", "G2.Q1"]) && deepEqual(r.writes("G1.Q3"), [0]) && deepEqual(waited.writes("G1.Q3"), [1]);
    check("先整合后照常投递", ok, `节点任务顺序 ${JSON.stringify(order)}，Q3 读到 G2.Q1 的旧值得 ${JSON.stringify(r.writes("G1.Q3"))}；`
      + `改用 trigger.all 等待 G2.Q1 后得 ${JSON.stringify(waited.writes("G1.Q3"))}`);
  }

  // 路径排序
  {
    const g = jks("G1", [...inputs("Q1"),
      jks("G10", [{ id: "Q1", q: 1, trigger: { any: ["G1.Q1"] } }], { any: ["Q1"] }),
      jks("G2", [{ id: "Q1", q: 1, trigger: { any: ["G1.Q1"] } }], { any: ["Q1"] }),
      { id: "Q2", q: 1, trigger: { any: ["Q1"] } }], { any: ["Q1"] });
    const got = run(jkm("M_SORT", g), ["G1.Q1"]).notifications();
    check("路径排序", deepEqual(got, ["G1.Q2", "G1.G2.Q1", "G1.G10.Q1"]), `投递顺序 ${JSON.stringify(got)}`);
  }

  // 嵌套与同名节点（M_PATH）
  {
    const r = run(model("M_PATH"), ["G1.Q1"]);
    check("嵌套与同名节点（M_PATH）", deepEqual(r.writes("G1.G2.Q1"), [1]) && deepEqual(r.writes("G1.Q2"), [1]),
      `G1.G2.Q1 ${JSON.stringify(r.writes("G1.G2.Q1"))}，G1.Q2 ${JSON.stringify(r.writes("G1.Q2"))}`);
  }

  // 书写顺序无关
  {
    const rng = new Random(3);
    let ok = true;
    const logOf = (data: unknown, inj: string[]) => JSON.stringify(run(data, inj).log);
    const cases: [Jkm, string[]][] = [
      [model("M_NEST"), ["G1.Q10"]], [model("M_PATH"), ["G1.Q1"]], [model("M_FLOW"), ["G1.Q1", "G1.Q3"]],
      [ctx.ascii, [3, 1, 4].map((d) => `G1.Q${d + 1}`)],
    ];
    for (const [data, inj] of cases) {
      const base = logOf(data, inj);
      for (let i = 0; i < 5; i++) ok &&= logOf(shuffled(data, rng), inj) === base;
    }
    check("书写顺序无关", ok, "打乱 members 后，M_NEST、M_PATH、M_FLOW 与十选一的执行记录与原序相同");
  }

  // 十选一
  {
    const outputs = (data: Jkm, digits: number[], overlap: boolean, rng?: Random) => {
      const ref = new CpuExecutor(new Model(data, "ascii"));
      for (const d of digits) {
        ref.inject(`G1.Q${d + 1}`);
        if (!overlap) ref.run();
        else if (rng) for (let i = rng.randrange(40); i > 0; i--) if (!ref.step()) break;
      }
      ref.run();
      return asciiCodes(ref.outputs);
    };
    const digits = Array.from({ length: 10 }, (_, d) => d);
    const serial = outputs(ctx.ascii, digits, false);
    check("十选一逐个输入", deepEqual(serial, digits.map((d) => 0x30 + d)), `输出 ${hex(serial)}`);
    const rng = new Random(7);
    let mismatches = 0;
    let trials = 0;
    for (let i = 0; i < 200; i++) {
      const ds = Array.from({ length: rng.randint(2, 7) }, () => rng.randrange(10));
      const expected = ds.map((d) => 0x30 + d);
      trials += 2;
      if (!deepEqual(outputs(ctx.ascii, ds, true), expected)) mismatches++;
      if (!deepEqual(outputs(ctx.ascii, ds, true, rng), expected)) mismatches++;
    }
    check("十选一重叠输入", mismatches === 0, `${trials} 组重叠或交错输入，与逐个输入不同的有 ${mismatches} 组`);
    const plain = clone(ctx.ascii);
    plain.roots[0].trigger = { any: digits.map((d) => `Q${d + 1}`) };
    syncInput(plain); // 根登记改了，input 随之改写（§8.1）
    const wrong = outputs(plain, [0, 1], true);
    check("十选一不用事务", !deepEqual(wrong, [0x30, 0x31]),
      `登记改为 any 时，同时输入 0、1 的输出为 ${hex(wrong)}，应为 ["0x30","0x31"]`);
  }

  // 多 thread 暂不支持
  {
    let ok = true;
    try {
      new CpuExecutor(new Model(jkm("M_Q", jks("G1", inputs("Q1"), { any: ["Q1"] })), "single"));
    } catch (e) {
      if (e instanceof Unsupported) ok = false;
      else throw e;
    }
    const data = jkm("M_MULTI", jks("G1", inputs("Q1"), { any: ["Q1"] }), jks("G2", inputs("Q1"), { any: ["Q1"] }));
    data.threads = ["a", "b"];
    data.roots[0].thread = "a";
    data.roots[1].thread = "b";
    let refused = false;
    try {
      new CpuExecutor(new Model(data, "multi"));
    } catch (e) {
      if (e instanceof Unsupported) refused = true;
      else throw e;
    }
    check("多 thread 暂不支持", ok && refused, "单 thread 可执行；两个 thread 的模型被明确拒绝（§9.3）");
  }

  // 事务外的普通执行（§6.1）
  {
    const nodeUnit = (r: CpuExecutor, path: string) => r.log.some((e) => e.kind === "unit" && e.unit === "node" && e.path === path);
    const mixed = jks("G1", [...inputs("Q1", "Q2"),
      { id: "Q3", q: 0, trigger: { any: ["Q1", "Q2"] }, sources: { seed: 0, s: ["Q1"], ex: ["K"] } }],
    { transaction: ["Q1"], any: ["Q2"] });
    const r1 = run(jkm("MIX", mixed), ["G1.Q2"]);
    check("事务外的普通执行（§6.1）", nodeUnit(r1, "G1.Q3") && r1.count("tx") === 0,
      "经同一 JKS 的 any 登记放行的通知，在事务之外作为普通节点任务执行");
  }

  // 嵌套事务（§6.3）
  {
    const r = run(inlineModel(), ["G1.Q1"]); // output 为 [G1.Q2, G2.Q2, G3.Q2]
    const txs = r.log.flatMap((e) => (e.kind === "tx" ? [`${e.g}@${e.depth}`] : []));
    const fromThread = r.log.filter((e) => e.kind === "tx_enqueue" && e.depth === 0).length;
    const layered = deepEqual(txs, ["G1@1", "G2@2", "G3@3"]) && fromThread === 1
      && deepEqual(r.outputs.map((o) => o.values), [[1, 0, 0], [1, 1, 0], [1, 1, 1]]);
    const order = run(nestOrderModel(), ["G1.Q1"]).log.flatMap((e) => (e.kind === "q" ? [e.path] : []));
    const ok = layered && deepEqual(order, ["G1.Q2", "G1.Q3", "G2.Q2", "G2.Q3", "G1.Q4"]);
    check("嵌套事务（§6.3）", ok,
      `M_INLINE 只有 ${fromThread} 个事务任务进入 thread，执行的事务（JKS@层）${JSON.stringify(txs)}；`
      + `M_NEST2 的节点任务顺序 ${JSON.stringify(order)}，嵌套事务连续执行完，外层才继续`);
  }

  // 事务的退出与上限（§6.4）
  {
    const exit = run(exitLoopModel("one_changed"), ["G1.Q1", "G1.Q1"]);
    const loops = exit.writes("G1.Q2");
    const limited = (data: Jkm, options: { txSteps?: number; txDepth?: number }) => {
      const r = new CpuExecutor(new Model(data, "limit"), options);
      r.inject("G1.Q1");
      try {
        r.run();
        return { r, limit: null };
      } catch (e) {
        if (e instanceof TxLimit) return { r, limit: e.limit };
        throw e;
      }
    };
    const steps = limited(exitLoopModel("always_changed"), { txSteps: 50 });
    const depth = limited(inlineModel(), { txDepth: 2 });
    const ok = deepEqual(loops, [1, 0, 1, 0]) && steps.limit === "steps" && depth.limit === "depth"
      && depth.r.log.filter((e) => e.kind === "tx").length === 2;
    check("事务的退出与上限（§6.4）", ok,
      `环上有退出结构时，每次请求循环两次后退出，Q2 依次为 ${JSON.stringify(loops)}；永不退出的环在步数上限 50 处停下`
      + `（${steps.limit ?? "未停下"}，已有 ${steps.r.record().length} 条记录）；嵌套层数上限为 2 时，第 3 层事务开始前停下（${depth.limit ?? "未停下"}）`);
  }

  // 1 bit 寄存器（M_REG）
  {
    const r = new CpuExecutor(new Model(model("M_REG"), "M_REG")); // output 为 [G1.Q5]
    for (const s of [2, 2, 1, 1, 2, 1]) {
      r.inject(`G1.Q${s}`);
      r.run();
    }
    const values = r.outputs.map((o) => o.values[0]);
    check("1 bit 寄存器（M_REG）", deepEqual(values, [1, 1, 0, 0, 1, 0]), `set1,set1,set0,set0,set1,set0 → ${JSON.stringify(values)}`);
  }

  // 可并行批（§7.5）
  {
    let ok = true;
    for (const [name, inj] of DOC_RUNS) {
      ok &&= same(run(model(name), inj), run(model(name), inj, { batch: true }));
    }
    const rng = new Random(5);
    let asciiBad = 0;
    for (let i = 0; i < 100; i++) {
      const batches = asciiBatches(rng);
      if (!same(runBatches(ctx.ascii, batches), runBatches(ctx.ascii, batches, { batch: true }))) asciiBad++;
    }
    const sizes: number[] = [];
    let randomBad = 0;
    for (let i = 0; i < 300; i++) {
      const data = randomModel(rng);
      const batches = randomBatches(rng);
      const b = runBatches(data, batches, { batch: true });
      if (!same(runBatches(data, batches), b)) randomBad++;
      sizes.push(...b.batchSizes);
    }
    const one = run(ctx.ascii, ["G1.Q1"], { batch: true }).batchSizes;
    const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
    check("可并行批（§7.5）", ok && asciiBad === 0 && randomBad === 0 && deepEqual(one, [4, 4]),
      `第 10 节模型${ok ? "一致" : "不一致"}；十选一 100 组、随机模型 300 个，记录不同的分别有 ${asciiBad}、${randomBad} 组；`
      + `随机模型共 ${sizes.length} 批，平均每批 ${mean.toFixed(2)} 个任务，最大 ${Math.max(...sizes)}；`
      + `十选一单次请求的批大小 ${JSON.stringify(one)}`);
  }

  // 运行脚本（§9.4）
  {
    const script = docBlock<RunScript>(ctx.doc, "run");
    const data = ctx.loadModel(script.model);
    const a = runScriptCpu(script, data);
    const b = runScriptCpu(script, data, { batch: true });
    const codes = asciiCodes(a.outputs);
    check("运行脚本（§9.4）", deepEqual(codes, [0x30, 0x31, 0x39]) && same(a, b),
      `Q24 的输出记录 ${hex(codes)}，执行记录 ${a.record().length} 条（其中输出记录 ${a.outputs.length} 条），批执行模式记录相同`);
  }

  // 快照（snapshot/Snapshot.md）
  {
    const expected = docBlock<Snapshot>(ctx.snapshotDoc, "snapshot");
    const data = model("M_TX");
    const engine = () => new CpuExecutor(new Model(data, "M_TX"));
    const r = engine();
    r.inject("G1.Q10");
    r.inject("G1.Q10");
    while (!r.log.some((e) => e.kind === "tx_end")) r.step();
    const snap = takeSnapshot(r, "S1");
    const cut = r.record().length;
    r.run();
    const resumed = engine();
    loadSnapshot(resumed, JSON.parse(JSON.stringify(snap)) as Snapshot);
    resumed.run();
    const ok = deepEqual(snap, expected) && formatRecords(resumed.record()) === formatRecords(r.record().slice(cut));

    const rng = new Random(9);
    let bad = 0;
    for (let i = 0; i < 150; i++) {
      const dataR = randomModel(rng);
      const batches = randomBatches(rng);
      const full = new CpuExecutor(new Model(dataR, "random"));
      for (const item of batches[0]) full.inject(item);
      for (let k = rng.randint(0, 25); k > 0; k--) full.step();
      const snapR = JSON.parse(JSON.stringify(takeSnapshot(full))) as Snapshot;
      const cutR = full.record().length;
      const rest = new CpuExecutor(new Model(dataR, "random"));
      loadSnapshot(rest, snapR);
      for (const engineR of [full, rest]) {
        engineR.run();
        for (const batch of batches.slice(1)) {
          for (const item of batch) engineR.inject(item);
          engineR.run();
        }
      }
      if (formatRecords(rest.record()) !== formatRecords(full.record().slice(cutR))) bad++;
    }
    check("快照（Snapshot.md）", ok && bad === 0,
      `M_TX 的中间状态与 Snapshot.md 第 2 节一致，从快照继续的记录与不中断运行相同；随机模型 150 次中途快照，不同的有 ${bad} 次`);
  }

  return results;
}
