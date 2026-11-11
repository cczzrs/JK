/**
 * WGSL 内核（WebGPU.md §6）：每个调用（invocation）执行一个实例，按 JKRD7 §7 的串行
 * 顺序推进“微步”。实例的全部状态都在存储缓冲区里，所以一次调度可以在任意微步之后
 * 停下，下一次调度接着执行；每次调度的微步数和记录量都有上限，避免单次调度运行过久。
 *
 * 微步：一次注入、一次事件投递、一个节点任务、一次事务开始（含嵌套事务）或一次事务结束。
 * 结果与 CPU 后端（cpu.ts，batch=false）逐条相同。
 */

import {
  F_ALL, F_EX, F_WATCH, GATE_ALL, GATE_NONE, GATE_TX_ANY, H, HEADER_WORDS, type Layout, NONE,
  REC_INJECT, REC_NOTIFY, REC_OUTPUT, REC_Q,
} from "./compile.ts";

export const WORKGROUP_SIZE = 64;

/** Params 统一缓冲区的字数（8 个 u32）。 */
export const PARAM_WORDS = 8;

export function kernelSource(l: Layout): string {
  const u = (v: number) => `${v >>> 0}u`;
  const consts: [string, number][] = [
    ["NONE", NONE], ["N", l.c.n],
    ["EV_CAP", l.cap.events], ["TK_CAP", l.cap.tasks], ["LEV_CAP", l.cap.localEvents], ["LTK_CAP", l.cap.localTasks],
    ["DEPTH", l.cap.depth],
    ["TK_STRIDE", l.tkStride],
    ...Object.entries(l.m).map(([k, v]) => [`M_${k}`, v] as [string, number]),
    ...Object.entries(l.s).map(([k, v]) => [`S_${k}`, v] as [string, number]),
    ["STATE_WORDS", l.stateWords], ["OUTPUT_N", l.output.length], ["OUT_WORDS", l.outWords],
    ["MAX_REC_STEP", l.maxRecStep], ["REC_WORDS", l.recWords], ["REC_CAP", l.recWords - 2],
    ...Object.entries(H).map(([k, v]) => [`H_${k}`, v] as [string, number]),
    ["HEADER_WORDS", HEADER_WORDS],
    ["F_ALL", F_ALL], ["F_EX", F_EX], ["F_WATCH", F_WATCH],
    ["GATE_NONE", GATE_NONE], ["GATE_ALL", GATE_ALL], ["GATE_TX_ANY", GATE_TX_ANY],
    ["REC_INJECT", REC_INJECT], ["REC_NOTIFY", REC_NOTIFY], ["REC_Q", REC_Q], ["REC_OUTPUT", REC_OUTPUT],
  ];
  const header = consts.map(([k, v]) => `const ${k}: u32 = ${u(v)};`).join("\n");
  return `// 由 src/gpu/kernel.ts 生成，模型 ${l.c.name ?? ""}
${header}

const ERR_EVENTS: u32 = 1u;
const ERR_TASKS: u32 = 2u;
const ERR_LOCAL_EVENTS: u32 = 3u;
const ERR_LOCAL_TASKS: u32 = 4u;
const ERR_STEPS: u32 = 6u;
const ERR_RECORDS: u32 = 7u;
const ERR_DEPTH: u32 = 8u;
const ERR_TX_STEPS: u32 = 9u;
const LOW31: u32 = 0x7fffffffu;

struct Params {
  n_inst: u32,
  batch: u32,
  budget: u32,
  step_limit: u32,
  in_words: u32,
  tx_limit: u32,
  pad1: u32,
  pad2: u32,
}

@group(0) @binding(0) var<storage, read> M: array<u32>;
@group(0) @binding(1) var<storage, read_write> S: array<u32>;
@group(0) @binding(2) var<storage, read> IN: array<u32>;
@group(0) @binding(3) var<storage, read_write> REC: array<u32>;
@group(0) @binding(4) var<uniform> P: Params;

var<private> sb: u32;   // 本实例状态区开头
var<private> rb: u32;   // 本实例记录区开头
var<private> ib: u32;   // 本实例输入区开头
var<private> rlen: u32; // 本次调度已写的记录字数

fn ld(i: u32) -> u32 { return S[sb + i]; }
fn sto(i: u32, v: u32) { S[sb + i] = v; }
fn ok() -> bool { return S[sb + H_STATUS] == 0u; }
fn fail(code: u32) { if (S[sb + H_STATUS] == 0u) { S[sb + H_STATUS] = code; } }

fn rec(w: u32) {
  if (rlen >= REC_CAP) { fail(ERR_RECORDS); return; }
  REC[rb + 2u + rlen] = w;
  rlen = rlen + 1u;
}

// §4.4：publish 判定。模式编号：0 always，1 zero，2 one，3 never，4 always_changed，5 zero_changed，6 one_changed
fn publishes(i: u32, has_before: bool, before: u32, value: u32) -> bool {
  let mode = M[M_PUB + i];
  var allowed = false;
  switch mode {
    case 0u, 4u: { allowed = true; }
    case 1u, 5u: { allowed = value == 0u; }
    case 2u, 6u: { allowed = value == 1u; }
    default: { allowed = false; }
  }
  if (!allowed) { return false; }
  if (mode >= 4u) { return has_before && value != before; }
  return true;
}

// JKI i 是 JKS g 的成员且不是 g 的前置：受 g 整合的订阅者（§5.3）
fn in_scope(g: u32, i: u32) -> bool {
  return M[M_JKS_LO + g] <= i && i < M[M_JKS_HI + g] && M[M_REG_JKS + i] != g;
}

// ---- FIFO ------------------------------------------------------------------
// 事件项是来源 JKI 的编号；thread 的两个 FIFO 与每一层事务的两个 FIFO（§6.2）都是环形缓冲。
// 任务项：类别（0 节点、1 事务）、节点或 JKS、前置数、前置。

// 当前事务层的 FIFO 位置字：0 事件头，1 事件数，2 任务头，3 任务数
fn lv(k: u32) -> u32 { return S_LV + (ld(H_MODE) - 1u) * 4u + k; }
fn lev_base() -> u32 { return S_LEV + (ld(H_MODE) - 1u) * LEV_CAP; }
fn ltk_base() -> u32 { return S_LTK + (ld(H_MODE) - 1u) * LTK_CAP * TK_STRIDE; }

fn ev_push(src: u32) {
  let len = ld(H_EV_LEN);
  if (len >= EV_CAP) { fail(ERR_EVENTS); return; }
  sto(S_EV + (ld(H_EV_HEAD) + len) % EV_CAP, src);
  sto(H_EV_LEN, len + 1u);
}

fn lev_push(src: u32) {
  let len = ld(lv(1u));
  if (len >= LEV_CAP) { fail(ERR_LOCAL_EVENTS); return; }
  sto(lev_base() + (ld(lv(0u)) + len) % LEV_CAP, src);
  sto(lv(1u), len + 1u);
}

// tx：追加到当前事务层的事务任务 FIFO；否则追加到 thread 的任务 FIFO
fn tk_alloc(tx: bool) -> u32 {
  if (tx) {
    let len = ld(lv(3u));
    if (len >= LTK_CAP) { fail(ERR_LOCAL_TASKS); return NONE; }
    sto(lv(3u), len + 1u);
    return ltk_base() + ((ld(lv(2u)) + len) % LTK_CAP) * TK_STRIDE;
  }
  let len = ld(H_TK_LEN);
  if (len >= TK_CAP) { fail(ERR_TASKS); return NONE; }
  sto(H_TK_LEN, len + 1u);
  return S_TK + ((ld(H_TK_HEAD) + len) % TK_CAP) * TK_STRIDE;
}

fn tk_push_node(i: u32, tx: bool) {
  let o = tk_alloc(tx);
  if (o == NONE) { return; }
  sto(o, 0u);
  sto(o + 1u, i);
  sto(o + 2u, 0u);
}

fn tk_push_tx1(g: u32, x: u32, tx: bool) {
  let o = tk_alloc(tx);
  if (o == NONE) { return; }
  sto(o, 1u);
  sto(o + 1u, g);
  sto(o + 2u, 1u);
  sto(o + 3u, x);
}

// 事务任务，前置按本轮到达顺序取自轮记录 b
fn tk_push_tx_round(g: u32, b: u32, cnt: u32, tx: bool) {
  let o = tk_alloc(tx);
  if (o == NONE) { return; }
  sto(o, 1u);
  sto(o + 1u, g);
  sto(o + 2u, cnt);
  for (var j = 0u; j < cnt; j++) { sto(o + 3u + j, ld(b + 1u + j)); }
}

// ---- §4.1 到达、§4.3 节点任务 -------------------------------------------------

fn emit(i: u32, tx: bool) {
  rec((REC_NOTIFY << 30u) | i);
  if (tx) { lev_push(i); } else { ev_push(i); }
}

fn receive(sub: u32, slot: u32, tx: bool) {
  let fl = M[M_FLAGS + sub];
  if ((fl & F_ALL) != 0u) {
    let b = S_SLOT + M[M_SLOT_BASE + sub];
    let n = M[M_SLOT_LEN + sub];
    let k = b + slot;
    sto(k, select(1u, 0u, ld(k) == NONE));
    for (var j = 0u; j < n; j++) { if (ld(b + j) == NONE) { return; } }
    for (var j = 0u; j < n; j++) { sto(b + j, NONE); }
  }
  if ((fl & F_EX) != 0u) {
    tk_push_node(sub, tx);
  } else if (publishes(sub, false, 0u, ld(S_Q + sub))) {
    emit(sub, tx);
  }
}

fn run_task(i: u32, tx: bool) {
  let before = ld(S_Q + i);
  var acc = M[M_SEED + i];
  if (acc == NONE) { acc = before; }
  for (var e = M[M_SRC_OFF + i]; e < M[M_SRC_OFF + i + 1u]; e++) {
    let w = M[M_SRC + e];
    let x = ld(S_Q + (w & LOW31));
    if ((w >> 31u) == 0u) { acc = acc & x; } else { acc = acc ^ x; }
  }
  if (publishes(i, true, before, acc)) { emit(i, tx); }
  sto(S_Q + i, acc);
  rec((REC_Q << 30u) | (acc << 29u) | (before << 28u) | i);
}

// ---- §7.3 投递、§5.3 整合 ----------------------------------------------------------

fn output(src: u32) {
  rec((REC_OUTPUT << 30u) | src);
  for (var w = 0u; w < OUT_WORDS; w++) {
    var bits = 0u;
    for (var k = w * 32u; k < min(OUTPUT_N, w * 32u + 32u); k++) {
      bits = bits | (ld(S_Q + M[M_OUTPUT + k]) << (k - w * 32u));
    }
    rec(bits);
  }
}

// 放行前置 x 给 JKS g 的受整合订阅者
fn release_one(g: u32, x: u32, tx: bool) {
  for (var e = M[M_SUB_OFF + x]; e < M[M_SUB_OFF + x + 1u]; e++) {
    let sub = M[M_SUB + e] & LOW31;
    if (in_scope(g, sub)) { receive(sub, M[M_SUB_SLOT + e], tx); }
  }
}

// 事务登记形成事务任务：不在事务中时进入 thread，事务中进入当前层的事务任务 FIFO（嵌套事务，§6.3）
fn feed(g: u32, gate: u32, src: u32, tx: bool) {
  if (gate == GATE_TX_ANY) {
    tk_push_tx1(g, src, tx);
    return;
  }
  let r = M[M_REG_ROUND + src];
  let b = S_ROUND + M[M_ROUND_BASE + r];
  var cnt = ld(b);
  var found = false;
  for (var j = 0u; j < cnt; j++) { if (ld(b + 1u + j) == src) { found = true; } }
  if (!found) {
    sto(b + 1u + cnt, src);
    cnt = cnt + 1u;
    sto(b, cnt);
  }
  if (cnt < M[M_ROUND_NEED + r]) { return; }
  if (gate == GATE_ALL) {
    for (var j = 0u; j < cnt; j++) { release_one(g, ld(b + 1u + j), tx); }
  } else {
    tk_push_tx_round(g, b, cnt, tx);
  }
  sto(b, 0u);
}

// 投递一条事件；事务执行期间（tx）形成的任务和事件进入事务 FIFO
fn deliver(src: u32, tx: bool) {
  if ((M[M_FLAGS + src] & F_WATCH) != 0u) { output(src); } // output 成员：输出模块在投递时读取，事务内也一样（§6.2、§9.1）
  let gate = M[M_REG_GATE + src];
  if (gate != GATE_NONE) { feed(M[M_REG_JKS + src], gate, src, tx); } // 先整合
  for (var e = M[M_SUB_OFF + src]; e < M[M_SUB_OFF + src + 1u]; e++) { // 再照常投递
    let w = M[M_SUB + e];
    if (gate != GATE_NONE && (w >> 31u) != 0u) { continue; }
    receive(w & LOW31, M[M_SUB_SLOT + e], tx);
  }
}

// ---- §6.2、§6.3 事务 -----------------------------------------------------------------

// 开始一个事务（o 是已出队的事务任务项）：进入高一层，清空该层的两个 FIFO，放行本次前置
fn start_tx(o: u32) {
  let d = ld(H_MODE) + 1u;
  if (d > DEPTH) { fail(ERR_DEPTH); return; }
  if (d == 1u) { sto(H_TX_STEPS, 0u); }
  sto(H_MODE, d);
  for (var k = 0u; k < 4u; k++) { sto(lv(k), 0u); }
  let g = ld(o + 1u);
  let n = ld(o + 2u);
  for (var j = 0u; j < n; j++) { release_one(g, ld(o + 3u + j), true); }
}

// §6.4：事务中每投递一条事件、执行一个节点任务算一步；超出时在这一步之前停下
fn tx_step() -> bool {
  if (ld(H_TX_STEPS) >= P.tx_limit) { fail(ERR_TX_STEPS); return false; }
  sto(H_TX_STEPS, ld(H_TX_STEPS) + 1u);
  return true;
}

// ---- 微步与入口 ----------------------------------------------------------------------

fn quiescent() -> bool {
  return ld(H_MODE) == 0u && ld(H_EV_LEN) == 0u && ld(H_TK_LEN) == 0u && ld(H_INJ_POS) >= ld(H_INJ_LEN);
}

fn micro_step() {
  let pos = ld(H_INJ_POS);
  if (pos < ld(H_INJ_LEN)) { // 注入本批输入
    let i = IN[ib + 1u + pos];
    rec((REC_INJECT << 30u) | i);
    ev_push(i);
    sto(H_INJ_POS, pos + 1u);
    return;
  }
  let d = ld(H_MODE);
  if (d > 0u) { // 第 d 层事务中：事务事件优先，其次事务任务，都空时本层事务结束，回到外层
    if (ld(lv(1u)) > 0u) {
      if (!tx_step()) { return; }
      let h = ld(lv(0u));
      let src = ld(lev_base() + h);
      sto(lv(0u), (h + 1u) % LEV_CAP);
      sto(lv(1u), ld(lv(1u)) - 1u);
      deliver(src, true);
    } else if (ld(lv(3u)) > 0u) {
      let h = ld(lv(2u));
      let o = ltk_base() + h * TK_STRIDE;
      let kind = ld(o);
      let i = ld(o + 1u);
      if (kind == 0u && !tx_step()) { return; }
      sto(lv(2u), (h + 1u) % LTK_CAP);
      sto(lv(3u), ld(lv(3u)) - 1u);
      if (kind == 0u) { run_task(i, true); } else { start_tx(o); } // 嵌套事务在高一层执行；本层的任务项不会被覆盖
    } else {
      sto(H_MODE, d - 1u);
    }
    return;
  }
  if (ld(H_EV_LEN) > 0u) { // 事件优先：先出队，再投递
    let h = ld(H_EV_HEAD);
    let src = ld(S_EV + h);
    sto(H_EV_HEAD, (h + 1u) % EV_CAP);
    sto(H_EV_LEN, ld(H_EV_LEN) - 1u);
    deliver(src, false);
    return;
  }
  if (ld(H_TK_LEN) > 0u) {
    let o = S_TK + ld(H_TK_HEAD) * TK_STRIDE;
    let kind = ld(o);
    let i = ld(o + 1u);
    sto(H_TK_HEAD, (ld(H_TK_HEAD) + 1u) % TK_CAP);
    sto(H_TK_LEN, ld(H_TK_LEN) - 1u);
    if (kind == 0u) { run_task(i, false); } else { start_tx(o); } // 事务执行期间 thread 的 FIFO 不追加，任务项不会被覆盖
  }
}

@compute @workgroup_size(${WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let inst = gid.x;
  if (inst >= P.n_inst) { return; }
  sb = inst * STATE_WORDS;
  rb = inst * REC_WORDS;
  ib = inst * P.in_words;
  rlen = 0u;
  if (ok() && ld(H_BATCH) != P.batch) { // 新的一批
    sto(H_BATCH, P.batch);
    sto(H_INJ_POS, 0u);
    sto(H_INJ_LEN, IN[ib]);
    sto(H_STEPS, 0u);
  }
  var budget = P.budget;
  loop {
    if (!ok() || quiescent() || budget == 0u || rlen + MAX_REC_STEP > REC_CAP) { break; }
    if (ld(H_STEPS) >= P.step_limit) { fail(ERR_STEPS); break; }
    micro_step();
    sto(H_STEPS, ld(H_STEPS) + 1u);
    budget = budget - 1u;
  }
  REC[rb] = rlen;
  REC[rb + 1u] = select(0u, 1u, !quiescent()) | (S[sb + H_STATUS] << 8u);
}
`;
}
