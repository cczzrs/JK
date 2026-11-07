/**
 * WGSL 内核（WebGPU.md §6）：每个调用（invocation）执行一个实例，按 JKRD7 §7 的串行
 * 顺序推进“微步”。实例的全部状态都在存储缓冲区里，所以一次调度可以在任意微步之后
 * 停下，下一次调度接着执行；每次调度的微步数和记录量都有上限，避免单次调度运行过久。
 *
 * 微步：一次注入、一次事件投递、一个节点任务、一次事务开始或一次事务提交。
 * 结果与 CPU 后端（cpu.ts，batch=false）逐条相同。
 */

import {
  EVF_OUT, EVF_RECV, F_ALL, F_EX, F_WATCH, GATE_ALL, GATE_NONE, GATE_TX_ANY, H, HEADER_WORDS, type Layout, NONE,
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
    ["CM_CAP", l.cap.committed], ["EV_STRIDE", l.evStride], ["TK_STRIDE", l.tkStride],
    ...Object.entries(l.m).map(([k, v]) => [`M_${k}`, v] as [string, number]),
    ...Object.entries(l.s).map(([k, v]) => [`S_${k}`, v] as [string, number]),
    ["STATE_WORDS", l.stateWords], ["READ_N", l.read.length], ["OUT_WORDS", l.outWords],
    ["MAX_REC_STEP", l.maxRecStep], ["REC_WORDS", l.recWords], ["REC_CAP", l.recWords - 2],
    ...Object.entries(H).map(([k, v]) => [`H_${k}`, v] as [string, number]),
    ["HEADER_WORDS", HEADER_WORDS],
    ["F_ALL", F_ALL], ["F_EX", F_EX], ["F_WATCH", F_WATCH], ["EVF_RECV", EVF_RECV], ["EVF_OUT", EVF_OUT],
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
const ERR_COMMIT: u32 = 5u;
const ERR_STEPS: u32 = 6u;
const ERR_RECORDS: u32 = 7u;
const LOW31: u32 = 0x7fffffffu;

struct Params {
  n_inst: u32,
  batch: u32,
  budget: u32,
  step_limit: u32,
  in_words: u32,
  pad0: u32,
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

// JKI i 是 JKS g 的成员且不是 g 的前置：受 g 整合的订阅者，也是 g 的事务范围（§5.3、§6.2）
fn in_scope(g: u32, i: u32) -> bool {
  return M[M_JKS_LO + g] <= i && i < M[M_JKS_HI + g] && M[M_REG_JKS + i] != g;
}

// JKS c 是 JKS p 的严格后代
fn strict_desc(c: u32, p: u32) -> bool {
  return M[M_JKS_LO + p] <= M[M_JKS_LO + c] && M[M_JKS_HI + c] <= M[M_JKS_HI + p]
    && M[M_JKS_DEPTH + c] > M[M_JKS_DEPTH + p];
}

// ---- 队列 ------------------------------------------------------------------

fn ev_push(src: u32) {
  let len = ld(H_EV_LEN);
  if (len >= EV_CAP) { fail(ERR_EVENTS); return; }
  let o = S_EV + ((ld(H_EV_HEAD) + len) % EV_CAP) * EV_STRIDE;
  sto(o, src);
  sto(o + 1u, EVF_OUT);
  sto(o + 2u, 0u);
  sto(H_EV_LEN, len + 1u);
}

fn lev_push(src: u32) {
  let len = ld(H_LEV_LEN);
  if (len >= LEV_CAP) { fail(ERR_LOCAL_EVENTS); return; }
  sto(S_LEV + (ld(H_LEV_HEAD) + len) % LEV_CAP, src);
  sto(H_LEV_LEN, len + 1u);
}

fn tk_alloc() -> u32 {
  let len = ld(H_TK_LEN);
  if (len >= TK_CAP) { fail(ERR_TASKS); return NONE; }
  sto(H_TK_LEN, len + 1u);
  return S_TK + ((ld(H_TK_HEAD) + len) % TK_CAP) * TK_STRIDE;
}

fn tk_push_node(i: u32) {
  let o = tk_alloc();
  if (o == NONE) { return; }
  sto(o, 0u);
  sto(o + 1u, i);
  sto(o + 2u, 0u);
}

fn tk_push_tx1(g: u32, x: u32) {
  let o = tk_alloc();
  if (o == NONE) { return; }
  sto(o, 1u);
  sto(o + 1u, g);
  sto(o + 2u, 1u);
  sto(o + 3u, x);
}

// 事务任务，前置按本轮到达顺序取自轮记录 b
fn tk_push_tx_round(g: u32, b: u32, cnt: u32) {
  let o = tk_alloc();
  if (o == NONE) { return; }
  sto(o, 1u);
  sto(o + 1u, g);
  sto(o + 2u, cnt);
  for (var j = 0u; j < cnt; j++) { sto(o + 3u + j, ld(b + 1u + j)); }
}

fn ltk_push(i: u32) {
  let len = ld(H_LTK_LEN);
  if (len >= LTK_CAP) { fail(ERR_LOCAL_TASKS); return; }
  sto(S_LTK + (ld(H_LTK_HEAD) + len) % LTK_CAP, i);
  sto(H_LTK_LEN, len + 1u);
}

// 事务提交列表：先打开一项，接收者逐个加入，最后决定是否保留
fn cm_open(src: u32, flags: u32) -> u32 {
  let n = ld(H_CM_LEN);
  if (n >= CM_CAP) { return NONE; }
  let o = S_CM + n * EV_STRIDE;
  sto(o, src);
  sto(o + 1u, flags);
  sto(o + 2u, 0u);
  return o;
}

fn cm_add(o: u32, e: u32) {
  if (o == NONE) { fail(ERR_COMMIT); return; }
  let k = ld(o + 2u);
  sto(o + 3u + k, e);
  sto(o + 2u, k + 1u);
}

fn cm_close(o: u32, keep: bool) {
  if (!keep) { return; }
  if (o == NONE) { fail(ERR_COMMIT); return; }
  sto(H_CM_LEN, ld(H_CM_LEN) + 1u);
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
    if (tx) { ltk_push(sub); } else { tk_push_node(sub); }
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
    for (var k = w * 32u; k < min(READ_N, w * 32u + 32u); k++) {
      bits = bits | (ld(S_Q + M[M_READ + k]) << (k - w * 32u));
    }
    rec(bits);
  }
}

// 放行前置 x 给 JKS g 的受整合订阅者
fn release_one(g: u32, x: u32, tx: bool) {
  var o = NONE;
  if (tx) { o = cm_open(x, EVF_RECV); }
  var deferred = 0u;
  let txg = ld(H_TX_G);
  for (var e = M[M_SUB_OFF + x]; e < M[M_SUB_OFF + x + 1u]; e++) {
    let sub = M[M_SUB + e] & LOW31;
    if (!in_scope(g, sub)) { continue; }
    if (tx && !in_scope(txg, sub)) {
      cm_add(o, e);
      deferred = deferred + 1u;
    } else {
      receive(sub, M[M_SUB_SLOT + e], tx);
    }
  }
  if (tx) { cm_close(o, deferred > 0u); }
}

fn feed(g: u32, gate: u32, src: u32, tx: bool) {
  let nested = tx && strict_desc(g, ld(H_TX_G));
  if (gate == GATE_TX_ANY) {
    if (nested) { release_one(g, src, true); } else { tk_push_tx1(g, src); }
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
  if (gate == GATE_ALL || nested) {
    for (var j = 0u; j < cnt; j++) { release_one(g, ld(b + 1u + j), tx); }
  } else {
    tk_push_tx_round(g, b, cnt);
  }
  sto(b, 0u);
}

// 投递一条事件；eo 是带接收者列表的事件项在状态区中的偏移
fn deliver(src: u32, flags: u32, eo: u32, tx: bool) {
  let fl = M[M_FLAGS + src];
  if (!tx && (flags & EVF_OUT) != 0u && (fl & F_WATCH) != 0u) { output(src); }
  if ((flags & EVF_RECV) != 0u) {
    let n = ld(eo + 2u);
    for (var k = 0u; k < n; k++) {
      let e = ld(eo + 3u + k);
      receive(M[M_SUB + e] & LOW31, M[M_SUB_SLOT + e], false);
    }
    return;
  }
  let gate = M[M_REG_GATE + src];
  if (gate != GATE_NONE) { feed(M[M_REG_JKS + src], gate, src, tx); } // 先整合
  var o = NONE;
  if (tx) { o = cm_open(src, EVF_RECV | EVF_OUT); }
  var deferred = 0u;
  let txg = ld(H_TX_G);
  for (var e = M[M_SUB_OFF + src]; e < M[M_SUB_OFF + src + 1u]; e++) { // 再照常投递
    let w = M[M_SUB + e];
    if (gate != GATE_NONE && (w >> 31u) != 0u) { continue; }
    let sub = w & LOW31;
    if (tx && !in_scope(txg, sub)) {
      cm_add(o, e);
      deferred = deferred + 1u;
    } else {
      receive(sub, M[M_SUB_SLOT + e], tx);
    }
  }
  if (tx) { cm_close(o, deferred > 0u || (fl & F_WATCH) != 0u); }
}

// ---- §6.3 事务 -------------------------------------------------------------------

fn start_tx(o: u32) {
  let g = ld(o + 1u);
  let n = ld(o + 2u);
  sto(H_MODE, 1u);
  sto(H_TX_G, g);
  sto(H_LEV_HEAD, 0u);
  sto(H_LEV_LEN, 0u);
  sto(H_LTK_HEAD, 0u);
  sto(H_LTK_LEN, 0u);
  sto(H_CM_LEN, 0u);
  for (var j = 0u; j < n; j++) { release_one(g, ld(o + 3u + j), true); }
}

fn commit() {
  let n = ld(H_CM_LEN);
  for (var k = 0u; k < n; k++) {
    let len = ld(H_EV_LEN);
    if (len >= EV_CAP) { fail(ERR_EVENTS); return; }
    let d = S_EV + ((ld(H_EV_HEAD) + len) % EV_CAP) * EV_STRIDE;
    let s = S_CM + k * EV_STRIDE;
    let m = 3u + ld(s + 2u);
    for (var w = 0u; w < m; w++) { sto(d + w, ld(s + w)); }
    sto(H_EV_LEN, len + 1u);
  }
  sto(H_CM_LEN, 0u);
  sto(H_MODE, 0u);
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
  if (ld(H_MODE) == 1u) { // 事务中：局部事件优先，其次局部任务，都空时提交
    if (ld(H_LEV_LEN) > 0u) {
      let h = ld(H_LEV_HEAD);
      let src = ld(S_LEV + h);
      sto(H_LEV_HEAD, (h + 1u) % LEV_CAP);
      sto(H_LEV_LEN, ld(H_LEV_LEN) - 1u);
      deliver(src, EVF_OUT, 0u, true);
    } else if (ld(H_LTK_LEN) > 0u) {
      let h = ld(H_LTK_HEAD);
      let i = ld(S_LTK + h);
      sto(H_LTK_HEAD, (h + 1u) % LTK_CAP);
      sto(H_LTK_LEN, ld(H_LTK_LEN) - 1u);
      run_task(i, true);
    } else {
      commit();
    }
    return;
  }
  if (ld(H_EV_LEN) > 0u) { // 事件优先；处理完再出队，期间新追加的事件不会覆盖这一项
    let o = S_EV + ld(H_EV_HEAD) * EV_STRIDE;
    deliver(ld(o), ld(o + 1u), o, false);
    sto(H_EV_HEAD, (ld(H_EV_HEAD) + 1u) % EV_CAP);
    sto(H_EV_LEN, ld(H_EV_LEN) - 1u);
    return;
  }
  if (ld(H_TK_LEN) > 0u) {
    let o = S_TK + ld(H_TK_HEAD) * TK_STRIDE;
    let kind = ld(o);
    let i = ld(o + 1u);
    if (kind == 1u) { start_tx(o); }
    sto(H_TK_HEAD, (ld(H_TK_HEAD) + 1u) % TK_CAP);
    sto(H_TK_LEN, ld(H_TK_LEN) - 1u);
    if (kind == 0u) { run_task(i, false); }
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
