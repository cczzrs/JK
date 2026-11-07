#!/usr/bin/env python3
"""Executable model of the CUDA design (CUDA.md), in plain Python.

It compiles a JKM into the flat arrays the GPU would hold (CUDA.md §4) and
executes with the same phase structure as the kernels (CUDA.md §6):

- event waves: every event currently queued is delivered in one wave.
  Round updates run per round, fan-out runs per (event, subscriber), trigger
  state runs per subscriber in key order, and the appends are compacted by key;
- node-task batches (JKRD7 §7.5): results computed together from the q at
  batch start, then applied and drained in task order;
- transactions: local sequences with the same waves and batches, range test
  by index interval, one commit at the end.

Each "parallel" phase is written as an independent loop over its items, with
no state shared across items except through the keyed outputs, so it maps
one-to-one to a kernel. The acceptance cases in jk_reference.py require the
execution record (JKRD7 §9.4) to equal the serial reference.
"""

import sys
from collections import deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jk_model import GATED_TYPES, PUBLISH, has_ex, path_key, text  # noqa: E402

PUB_MODES = list(PUBLISH)            # code = index: always, zero, one, never, always_changed, zero_changed, one_changed
GATE_NONE, GATE_ALL, GATE_TX, GATE_TX_ANY = 0, 1, 2, 3
GATE_CODE = {"all": GATE_ALL, "transaction": GATE_TX, "transaction_any": GATE_TX_ANY}


class Compiled:
    """CUDA.md §4: structure arrays. Node index = JKRD7 §7.3 path order."""

    def __init__(self, model):
        nodes = sorted(model.jki, key=path_key)
        index = {p: i for i, p in enumerate(nodes)}
        self.N = len(nodes)
        self.paths = [text(p) for p in nodes]
        self.index = {text(p): i for p, i in index.items()}

        # per-node scalars
        self.q0 = [model.jki[p]["q"] for p in nodes]
        self.is_all = [int("all" in model.jki[p]["trigger"]) for p in nodes]
        self.has_ex = [int(has_ex(model.jki[p])) for p in nodes]
        self.seed = [model.jki[p].get("sources", {}).get("seed", -1) for p in nodes]
        self.pub = [PUB_MODES.index(next(iter(model.jki[p].get("publish") or {"always": [0, 1]}))) for p in nodes]

        # sources CSR (only for nodes with EX)
        self.src_off, self.src_idx, self.src_op = [0], [], []
        for p in nodes:
            if has_ex(model.jki[p]):
                self.src_idx += [index[s] for s in model.source_refs[p]]
                self.src_op += [0 if op == "J" else 1 for op in model.jki[p]["sources"]["ex"]]
            self.src_off.append(len(self.src_idx))

        # trigger_all slots
        self.slot_base, self.slot_len, n = [], [], 0
        for p in nodes:
            k = len(model.trigger_refs[p]) if "all" in model.jki[p]["trigger"] else 0
            self.slot_base.append(n)
            self.slot_len.append(k)
            n += k
        self.n_slots = n
        self.edge_pos = {(index[x], index[s]): k for s in nodes for k, x in enumerate(model.trigger_refs[s])}

        # JKS table: index intervals of member JKIs (contiguous in path order), depth, registrations
        groups = sorted(model.jks, key=lambda g: (len(g), g))
        self.jks_paths = [text(g) for g in groups]
        self.jks_index = {g: k for k, g in enumerate(groups)}
        self.jks_lo, self.jks_hi, self.jks_depth = [], [], []
        for g in groups:
            members = sorted(index[p] for p in model.members[g])
            assert members == list(range(members[0], members[-1] + 1)), "members must be contiguous"
            self.jks_lo.append(members[0])
            self.jks_hi.append(members[-1] + 1)
            self.jks_depth.append(len(g))

        # registrations: node -> (jks, gate code, round id); rounds: (jks, type) with a member count
        self.reg_jks = [-1] * self.N
        self.reg_gate = [GATE_NONE] * self.N
        self.reg_round = [-1] * self.N
        self.round_need, self.round_jks = [], []
        for g, kinds in model.reg_types.items():
            for kind, prereqs in kinds.items():
                rid = -1
                if kind in ("all", "transaction"):
                    rid = len(self.round_need)
                    self.round_need.append(len(prereqs))
                    self.round_jks.append(self.jks_index[g])
                for p in prereqs:
                    i = index[p]
                    self.reg_jks[i] = self.jks_index[g]
                    self.reg_gate[i] = GATE_CODE.get(kind, GATE_NONE)
                    self.reg_round[i] = rid
        self.round_kind = {rid: kind for g, kinds in model.reg_types.items() for kind in kinds
                           for rid in [self.reg_round[index[kinds[kind][0]]]] if kind in ("all", "transaction")}

        # subscriber CSR per source, sorted by subscriber index; gated flag precomputed per edge
        self.sub_off, self.sub_idx, self.sub_gated = [0], [], []
        for p in nodes:
            x = index[p]
            for s in sorted(index[s] for s in model.subscribers.get(p, ())):
                self.sub_idx.append(s)
                self.sub_gated.append(int(self.reg_gate[x] != GATE_NONE and self.in_scope(self.reg_jks[x], s)))
            self.sub_off.append(len(self.sub_idx))

        self.is_input = [int(model.jki[p]["trigger"].get("any") == [] and p in model.reg_of) for p in nodes]

    def in_scope(self, g, i):
        """Is JKI i a member of JKS g but not one of its prereqs? (gated subscriber / transaction range)"""
        return self.jks_lo[g] <= i < self.jks_hi[g] and self.reg_jks[i] != g

    def strict_desc(self, child, parent):
        return (self.jks_lo[parent] <= self.jks_lo[child] and self.jks_hi[child] <= self.jks_hi[parent]
                and self.jks_depth[child] > self.jks_depth[parent])


class _Tx:
    def __init__(self, g):
        self.g = g
        self.events = deque()
        self.tasks = deque()
        self.committed = []


class CudaModel:
    """One model instance, executed with the kernel phase structure of CUDA.md §6."""

    def __init__(self, model, watch=(), read=(), batch=True):
        if model.errors:
            raise ValueError("模型未通过静态检查")
        if len({obj["queue"] for obj in model.jks.values()}) > 1:
            raise ValueError("CUDA 执行模型只执行单 queue 模型")
        c = self.c = Compiled(model)
        self.q = list(c.q0)
        self.slots = [None] * c.n_slots
        self.rounds = [[] for _ in c.round_need]
        self.events = deque()      # (source, receivers or None, out)
        self.tasks = deque()       # ("node", i) | ("tx", g, prereqs)
        self.watch = {c.index[x] for x in watch}
        self.read = [c.index[x] for x in read]
        self.log = []
        self.outputs = []
        self.wave_sizes = []
        self.batch_sizes = []

    # -- host interface ------------------------------------------------------

    def inject(self, ref):
        i = self.c.index[ref]
        if not self.c.is_input[i]:
            raise ValueError(f"{ref} 不是输入入口")
        self.log.append(("inject", ref))
        self.events.append((i, None, True))

    def run(self, max_steps=100000):
        steps = 0
        while self.events or self.tasks:
            steps += 1
            if steps > max_steps:
                raise RuntimeError("超过步数上限")
            if self.events:
                self._wave(self.events, None)
            elif self.tasks[0][0] == "tx":
                _, g, prereqs = self.tasks.popleft()
                self._transaction(g, prereqs)
            else:
                self._batch(self._take_batch(self.tasks), None)

    def record(self):
        out = []
        for e in self.log:
            if e[0] == "inject":
                out.append({"inject": e[1]})
            elif e[0] == "notify":
                out.append({"notify": e[1]})
            elif e[0] == "q":
                out.append({"q": e[1], "from": e[2], "to": e[3]})
            elif e[0] == "output":
                out.append({"output": e[1], "values": e[2]})
        return out

    # -- helpers ---------------------------------------------------------------

    def _publishes(self, i, q_before, value):
        mode = PUB_MODES[self.c.pub[i]]
        if value not in PUBLISH[mode]:
            return False
        return q_before is not None and value != q_before if mode.endswith("_changed") else True

    def _local(self, tx, i):
        return tx is None or self.c.in_scope(tx.g, i)

    # -- event wave (CUDA.md §6.2) ---------------------------------------------

    def _wave(self, fifo, tx):
        c = self.c
        wave = [fifo.popleft() for _ in range(len(fifo))]
        self.wave_sizes.append(len(wave))
        records, task_out, event_out, committed, deliveries = [], [], [], [], []

        # Kernel W1 (per event): outputs and committed-item fan-out
        for j, (src, receivers, out) in enumerate(wave):
            if tx is None and out and src in self.watch:
                values = [self.q[r] for r in self.read]
                records.append(((j, -1), ("output", c.paths[src], values)))
            if receivers is not None:
                for k, s in enumerate(receivers):
                    deliveries.append(((j, 1, k, 0), s, src))

        # Kernel W2 (per round, events in wave order): JKS integration (JKRD7 §5.3, §6.4)
        releases = {}                                   # j -> (gate jks, prereq order) to release
        for j, (src, receivers, _) in enumerate(wave):
            if receivers is not None or c.reg_gate[src] == GATE_NONE:
                continue
            g, gate = c.reg_jks[src], c.reg_gate[src]
            if gate == GATE_TX_ANY:
                order = [src]
            else:
                record = self.rounds[c.reg_round[src]]
                if src not in record:
                    record.append(src)
                if len(record) < c.round_need[c.reg_round[src]]:
                    continue
                order = list(record)
                record.clear()
            inline = tx is not None and c.strict_desc(g, tx.g)
            if gate == GATE_ALL or inline:
                releases[j] = (g, order)
            else:
                task_out.append(((j, 0, 0, -1), ("tx", g, tuple(order))))

        # Kernel W3 (per event x subscriber): fan-out with keys; out-of-range deliveries are deferred
        for j, (src, receivers, _) in enumerate(wave):
            if receivers is not None:
                continue
            if j in releases:
                g, order = releases[j]
                for r, x in enumerate(order):
                    deferred = []
                    for e in range(c.sub_off[x], c.sub_off[x + 1]):
                        s = c.sub_idx[e]
                        if c.in_scope(g, s):
                            if self._local(tx, s):
                                deliveries.append(((j, 0, r, s), s, x))
                            else:
                                deferred.append(s)
                    if tx is not None and deferred:
                        committed.append(((j, 0, r), (x, tuple(deferred), False)))
            deferred = []
            for e in range(c.sub_off[src], c.sub_off[src + 1]):
                if c.sub_gated[e]:
                    continue
                s = c.sub_idx[e]
                if self._local(tx, s):
                    deliveries.append(((j, 1, s, 0), s, src))
                else:
                    deferred.append(s)
            if tx is not None and (deferred or src in self.watch):
                committed.append(((j, 1), (src, tuple(deferred), True)))

        self._receive_all(deliveries, tx, records, task_out, event_out)

        # Kernel W5 (compaction by key)
        for _, entry in sorted(records, key=lambda kv: kv[0]):
            self.log.append(entry)
        tasks_fifo = tx.tasks if tx is not None else self.tasks
        for _, item in sorted(task_out, key=lambda kv: kv[0]):
            (self.tasks if item[0] == "tx" else tasks_fifo).append(item)
        for _, item in sorted(event_out, key=lambda kv: kv[0]):
            fifo.append(item)
        if tx is not None:
            tx.committed.extend(item for _, item in sorted(committed, key=lambda kv: kv[0]))

    def _receive_all(self, deliveries, tx, records, task_out, event_out):
        """Kernel W4 (per subscriber, its deliveries in key order): JKRD7 §4.1 trigger state."""
        c = self.c
        by_sub = {}
        for key, s, src in deliveries:
            by_sub.setdefault(s, []).append((key, src))
        for s, items in by_sub.items():
            for key, src in sorted(items, key=lambda kv: kv[0]):
                if c.is_all[s]:
                    base = c.slot_base[s]
                    k = base + c.edge_pos[(src, s)]
                    self.slots[k] = 0 if self.slots[k] is None else 1
                    if any(v is None for v in self.slots[base:base + c.slot_len[s]]):
                        continue
                    for k in range(base, base + c.slot_len[s]):
                        self.slots[k] = None
                if c.has_ex[s]:
                    task_out.append((key, ("node", s)))
                elif self._publishes(s, None, self.q[s]):
                    records.append((key, ("notify", c.paths[s])))
                    event_out.append((key, (s, None, True)))

    # -- node-task batch (JKRD7 §7.5, CUDA.md §6.3) -------------------------------

    def _take_batch(self, fifo):
        c = self.c
        batch, written = [], set()
        while fifo and fifo[0][0] == "node":
            i = fifo[0][1]
            if i in written or written.intersection(c.src_idx[c.src_off[i]:c.src_off[i + 1]]):
                break
            batch.append(fifo.popleft()[1])
            written.add(i)
        return batch

    def _batch(self, batch, tx):
        c = self.c
        self.batch_sizes.append(len(batch))
        results = []
        for i in batch:                                   # Kernel B1: one thread per task, reads q at batch start
            q_before = self.q[i]
            acc = c.seed[i] if c.seed[i] >= 0 else q_before
            for e in range(c.src_off[i], c.src_off[i + 1]):
                x = self.q[c.src_idx[e]]
                acc = acc & x if c.src_op[e] == 0 else acc ^ x
            results.append((i, q_before, acc, self._publishes(i, q_before, acc)))
        fifo = tx.events if tx is not None else self.events
        for i, q_before, acc, publish in results:         # Kernel B2: apply in task order, drain between
            if publish:
                self.log.append(("notify", c.paths[i]))
                fifo.append((i, None, True))
            self.q[i] = acc
            self.log.append(("q", c.paths[i], q_before, acc))
            while fifo:
                self._wave(fifo, tx)

    # -- transaction (JKRD7 §6.3, CUDA.md §6.4) --------------------------------------

    def _transaction(self, g, prereqs):
        c = self.c
        tx = _Tx(g)
        deliveries = []
        for r, x in enumerate(prereqs):
            for e in range(c.sub_off[x], c.sub_off[x + 1]):
                s = c.sub_idx[e]
                if c.in_scope(g, s):
                    deliveries.append(((0, 0, r, s), s, x))
        records, task_out, event_out = [], [], []
        self._receive_all(deliveries, tx, records, task_out, event_out)
        for _, entry in sorted(records, key=lambda kv: kv[0]):
            self.log.append(entry)
        for _, item in sorted(task_out, key=lambda kv: kv[0]):
            tx.tasks.append(item)
        for _, item in sorted(event_out, key=lambda kv: kv[0]):
            tx.events.append(item)
        while tx.events or tx.tasks:
            if tx.events:
                self._wave(tx.events, tx)
            else:
                self._batch(self._take_batch(tx.tasks), tx)
        self.events.extend(tx.committed)
