/**
 * 运行现场快照（snapshot/Snapshot.md）：数据类型、检查与文件文本格式。
 * 快照模块不属于 JKRD7 的主要路线：src/ 中的规则与两个后端不引用本目录，本目录引用 src/。
 */

import { type Bit, type Model, VERSION, exactKeys, hasEx, isBit, isObj, show, strList } from "../src/model.ts";

/** 快照中的事件项与任务项。 */
export type SnapshotEvent = { source: string };
export type SnapshotTask = { node: string } | { tx: string; prereqs: string[] };

export interface Snapshot {
  snapshot: string;
  jkm: string | null;
  version: string;
  q: Record<string, Bit>;
  trigger_all: Record<string, (Bit | null)[]>;
  rounds: Record<string, Partial<Record<"all" | "transaction", string[]>>>;
  threads: Record<string, { events: SnapshotEvent[]; tasks: SnapshotTask[] }>;
}

const SNAPSHOT_FIELDS = ["snapshot", "jkm", "version", "q", "trigger_all", "rounds", "threads"];

/** 快照的结构及其与模型的一致性（Snapshot.md 第 2 节）。 */
export function checkSnapshot(snap: unknown, model: Model): string[] {
  if (!exactKeys(snap, SNAPSHOT_FIELDS)) return [`快照字段必须恰好是 ${show(SNAPSHOT_FIELDS)}`];
  const errors: string[] = [];
  if (!(typeof snap.snapshot === "string" && snap.snapshot !== "")) errors.push("snapshot 必须是非空字符串");
  if (snap.jkm !== model.name) errors.push(`jkm 必须是对应模型的 jkm ${show(model.name)}，得到 ${show(snap.jkm)}`);
  if (snap.version !== VERSION) errors.push(`version 必须是 "${VERSION}"`);
  const q = snap.q;
  const all = [...model.jki.keys()];
  if (!(isObj(q) && Object.keys(q).length === all.length && all.every((p) => p in q)
    && Object.values(q).every(isBit))) {
    errors.push("q 必须给出全部 JKI 的 0／1 值");
  }
  if (!isObj(snap.trigger_all)) errors.push("trigger_all 必须是对象");
  for (const [ref, record] of Object.entries(isObj(snap.trigger_all) ? snap.trigger_all : {})) {
    const node = model.jki.get(ref);
    const refs = node && "all" in node.trigger ? node.trigger.all : null;
    const ok = refs !== null && Array.isArray(record) && record.length === refs.length
      && record.every((v) => v === null || isBit(v)) && record.some((v) => v !== null) && record.some((v) => v === null);
    if (!ok) errors.push(`trigger_all 中 ${ref} 的记录不合法`);
  }
  if (!isObj(snap.rounds)) errors.push("rounds 必须是对象");
  for (const [ref, kinds] of Object.entries(isObj(snap.rounds) ? snap.rounds : {})) {
    if (!model.jks.has(ref) || !isObj(kinds)) {
      errors.push(`rounds 的键 ${ref} 不是 JKS 绝对路径`);
      continue;
    }
    if (!Object.keys(kinds).length) errors.push(`rounds 中 ${ref} 没有记录：只列不为空的轮记录`);
    for (const [kind, prereqs] of Object.entries(kinds)) {
      const registered = model.regTypes.get(ref)!.get(kind) ?? [];
      const ok = (kind === "all" || kind === "transaction") && strList(prereqs, false)
        && new Set(prereqs).size === prereqs.length
        && prereqs.every((p) => registered.includes(p)) && prereqs.length < registered.length;
      if (!ok) errors.push(`rounds 中 ${ref}.${kind} 的记录不合法：只能列出未到齐的本轮前置`);
    }
  }
  const threads = snap.threads;
  if (!(isObj(threads) && Object.keys(threads).every((k) => model.threads.includes(k)))) {
    return [...errors, "threads 的键必须是 JKM.threads 中声明的名称"];
  }
  for (const [name, fifo] of Object.entries(threads)) {
    if (!exactKeys(fifo, ["events", "tasks"]) || !Array.isArray(fifo.events) || !Array.isArray(fifo.tasks)) {
      errors.push(`threads.${name} 必须是 {events, tasks}`);
      continue;
    }
    // 各项所在的 thread（JKRD7 §7.4）：事件看来源 JKI 所属的 JKS，节点任务看目标 JKI 所属的 JKS，事务任务看登记它的 JKS
    const here = (jks: string) => model.jks.get(jks)?.thread === name;
    const owner = (jki: string) => jki.slice(0, jki.lastIndexOf("."));
    for (const item of fifo.events as unknown[]) {
      const ok = exactKeys(item, ["source"]) && model.isJkiPath(item.source) && here(owner(item.source));
      if (!ok) errors.push(`threads.${name}.events 中的事件项不合法：${show(item)}`);
    }
    for (const item of fifo.tasks as unknown[]) {
      let ok = false;
      if (exactKeys(item, ["node"])) {
        ok = model.isJkiPath(item.node) && hasEx(model.jki.get(item.node)!) && here(owner(item.node));
      } else if (exactKeys(item, ["tx", "prereqs"])) {
        // prereqs 是 JKRD7 §5.3 记下的本次前置：transaction 到齐的一轮列出该登记的全部前置，各一次；
        // transaction_any 只有发出通知的那一个前置
        const kinds = typeof item.tx === "string" ? model.regTypes.get(item.tx) : undefined;
        const p = item.prereqs;
        if (kinds && strList(p, false) && here(item.tx as string)) {
          const round = kinds.get("transaction") ?? [];
          ok = (p.length === round.length && new Set(p).size === p.length && p.every((r) => round.includes(r)))
            || (p.length === 1 && (kinds.get("transaction_any") ?? []).includes(p[0]));
        }
      }
      if (!ok) errors.push(`threads.${name}.tasks 中的任务项不合法：${show(item)}`);
    }
  }
  return errors;
}

/** 检查不通过时抛出异常。 */
export function requireSnapshot(snap: Snapshot, model: Model): void {
  const problems = checkSnapshot(snap, model);
  if (problems.length) throw new Error("快照不合法：\n" + problems.join("\n"));
}

/** 快照文件文本：两格缩进，末尾一个换行。 */
export function formatSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot, null, 2) + "\n";
}
