#!/usr/bin/env python3
"""JKRD7 serial reference interpreter (JKRD7.md §4–§7, §9.1, §9.4, §9.5).

One processing unit at a time, event-first, subscribers in absolute-path
order, JKS integration (any / all / transaction / transaction_any), and
transactions with local sequences and a single commit. It is the baseline a
parallel (e.g. CUDA) implementation must reproduce (§7.5); it is not a
production executor and runs single-queue models only (§9.3).

With batch=True it runs node tasks in the parallel batches of §7.5 (same
results by construction; the acceptance cases check it).

    python3 scripts/jk_reference.py                     run the §11.2 acceptance cases
    python3 scripts/jk_reference.py --write-report      also write reports/reference-run.json
    python3 scripts/jk_reference.py --script RUN.json   print the execution record of a run script (§9.4)
        [--batch] [--start SNAPSHOT.json] [--save SNAPSHOT.json]
    python3 scripts/jk_reference.py --model M.json --inject G1.Q1 G1.Q2 ...   (one input batch)
"""

import argparse
import copy
import hashlib
import json
import random
import re
import sys
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jk_model import (GATED_TYPES, PUBLISH, Model, check_run_script, check_snapshot,  # noqa: E402
                      has_ex, path_key, text)

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "JKRD7.md"
ASCII_MODEL = ROOT / "assets/ascii-bit-design/digits.jkm.json"
REPORT = ROOT / "reports/reference-run.json"


class Unsupported(Exception):
    pass


class _Tx:
    """An active transaction: local sequences and deferred out-of-range deliveries (§6.3)."""

    def __init__(self, target, scope):
        self.target = target
        self.scope = scope
        self.events = deque()
        self.tasks = deque()
        self.committed = []


class Reference:
    def __init__(self, model, watch=(), read=(), batch=False):
        if model.errors:
            raise ValueError("模型未通过静态检查：\n" + "\n".join(model.errors))
        queues = {obj["queue"] for obj in model.jks.values()}
        if len(queues) > 1:
            raise Unsupported(f"使用了多个 queue {sorted(queues)}；queue 之间的调度由队列模块规定（JKRD7 §7.4、§9.3）")
        self.m = model
        self.queue = queues.pop() if queues else None
        self.batch = batch
        self.q = {p: node["q"] for p, node in model.jki.items()}
        self.trigger_all = {p: list(node["runtime"]["trigger_all"])
                            for p, node in model.jki.items() if "all" in node["trigger"]}
        self.rounds = {(g, kind): [] for g, kinds in model.reg_types.items()
                       for kind in kinds if kind in ("all", "transaction")}
        self.events = deque()   # items: (source, receivers or None, out)
        self.tasks = deque()    # items: ("node", path) | ("tx", jks path, prereqs)
        self.watch = {self._abs(x) for x in watch}
        self.read = [self._abs(x) for x in read]
        self.log = []           # inject / notify / q / output, plus unit, tx, commit markers
        self.outputs = []
        self.units = 0
        self.batch_sizes = []

    # -- helpers -----------------------------------------------------------

    def _abs(self, ref):
        path = self.m.addr.get(ref)
        if path not in self.m.jki:
            raise ValueError(f"{ref} 不是模型中的 JKI 绝对路径")
        return path

    def _publish(self, node, q_before, value):
        """§4.4. q_before is None for an empty-EX trigger."""
        mode = next(iter(node.get("publish") or {"always": [0, 1]}))
        if value not in PUBLISH[mode]:
            return False
        if mode.endswith("_changed"):
            return q_before is not None and value != q_before
        return True

    # -- external interface (§9.1) -------------------------------------------

    def inject(self, ref):
        path = self._abs(ref)
        if self.m.jki[path]["trigger"].get("any") != [] or path not in self.m.reg_of:
            raise ValueError(f"{ref} 不是输入入口（JKRD7 §3.2、§9.1）")
        self.log.append(("inject", text(path)))
        self.events.append((path, None, True))

    def step(self):
        """One processing unit (a batch of node tasks counts once per task)."""
        if self.events:
            self._event_unit()
        elif self.tasks:
            if self.tasks[0][0] == "tx":
                task = self.tasks.popleft()
                self.units += 1
                self.log.append(("unit", self.units, "tx", text(task[1])))
                self._run_tx(task[1], task[2])
            else:
                self._run_batch(self._take_batch(self.tasks), None)
        else:
            return False
        return True

    def run(self, max_units=100000):
        start = self.units
        while self.step():
            if self.units - start > max_units:
                raise RuntimeError("超过处理单元上限；事务范围以外的环由结构自身负责终止（JKRD7 §6.2）")

    def _event_unit(self):
        self.units += 1
        self.log.append(("unit", self.units, "event", text(self.events[0][0])))
        self._deliver(self.events.popleft(), None)

    # -- delivery (§7.3) and integration (§5.3) -------------------------------

    def _deliver(self, item, tx):
        source, receivers, out = item
        if tx is None and out and source in self.watch:
            values = [self.q[p] for p in self.read]
            self.outputs.append({"source": text(source), "values": values})
            self.log.append(("output", text(source), values))
        if receivers is not None:            # committed by a transaction: recorded receivers only
            for sub in receivers:
                self._receive(sub, source, None)
            return
        reg = self.m.reg_of.get(source)
        gate = reg if reg and reg[1] in GATED_TYPES else None
        if gate:                             # §7.3 step 2: integration first
            self._feed(gate[0], gate[1], source, tx)
        deferred = []
        for sub in self.m.subscribers.get(source, ()):   # step 3: then ungated subscribers
            if gate and self.m.gated(gate[0], sub):
                continue
            self._offer(sub, source, tx, deferred)
        if tx is not None and (deferred or source in self.watch):
            tx.committed.append((source, tuple(deferred), True))

    def _offer(self, sub, source, tx, deferred):
        if tx is not None and sub not in tx.scope:
            deferred.append(sub)
        else:
            self._receive(sub, source, tx)

    def _feed(self, g, kind, source, tx):
        inline = tx is not None and len(g) > len(tx.target) and g[:len(tx.target)] == tx.target
        if kind == "transaction_any":
            order = (source,)
        else:
            record = self.rounds[(g, kind)]
            if source not in record:
                record.append(source)
            if len(record) < len(self.m.reg_types[g][kind]):
                return
            order = tuple(record)
            record.clear()
        if kind == "all" or inline:
            self._release(g, order, tx)
        else:
            self.log.append(("tx_enqueue", text(g), [text(p) for p in order]))
            self.tasks.append(("tx", g, order))

    def _release(self, g, order, tx):
        for prereq in order:
            deferred = []
            for sub in self.m.subscribers.get(prereq, ()):
                if self.m.gated(g, sub):
                    self._offer(sub, prereq, tx, deferred)
            if tx is not None and deferred:
                tx.committed.append((prereq, tuple(deferred), False))

    def _receive(self, path, source, tx):
        """§4.1 for one arrival."""
        node = self.m.jki[path]
        if "all" in node["trigger"]:
            record = self.trigger_all[path]
            i = self.m.trigger_refs[path].index(source)
            record[i] = 0 if record[i] is None else 1
            if any(v is None for v in record):
                return
            record[:] = [None] * len(record)
        if has_ex(node):
            (tx.tasks if tx else self.tasks).append(("node", path))
        elif self._publish(node, None, self.q[path]):
            self._emit(path, tx)

    def _emit(self, path, tx):
        self.log.append(("notify", text(path)))
        (tx.events if tx else self.events).append((path, None, True))

    # -- tasks (§4.3, §6.3) and parallel batches (§7.5) ---------------------------

    def _take_batch(self, queue):
        if not self.batch:
            return [queue.popleft()[1]]
        batch, written = [], set()
        while queue and queue[0][0] == "node":
            path = queue[0][1]
            if path in written or written.intersection(self.m.source_refs[path]):
                break
            batch.append(queue.popleft()[1])
            written.add(path)
        return batch

    def _compute(self, path):
        node = self.m.jki[path]
        sources = node["sources"]
        q_before = self.q[path]
        acc = sources["seed"] if "seed" in sources else q_before
        for op, x in zip(sources["ex"], [self.q[p] for p in self.m.source_refs[path]]):
            acc = acc & x if op == "J" else acc ^ x
        return q_before, acc, self._publish(node, q_before, acc)

    def _run_batch(self, batch, tx):
        results = [(p,) + self._compute(p) for p in batch]   # every result reads the q at batch start
        self.batch_sizes.append(len(batch))
        for path, q_before, acc, publish in results:
            if tx is None:
                self.units += 1
                self.log.append(("unit", self.units, "node", text(path)))
            if publish:
                self._emit(path, tx)
            self.q[path] = acc
            self.log.append(("q", text(path), q_before, acc))
            if self.batch:                                    # drain before the next task of the batch
                if tx is None:
                    while self.events:
                        self._event_unit()
                else:
                    while tx.events:
                        self._deliver(tx.events.popleft(), tx)

    def _run_tx(self, g, order):
        tx = _Tx(g, self.m.range[g])
        self.log.append(("tx", text(g), [text(p) for p in order]))
        self._release(g, order, tx)
        while tx.events or tx.tasks:
            if tx.events:
                self._deliver(tx.events.popleft(), tx)
            else:
                self._run_batch(self._take_batch(tx.tasks), tx)
        self.events.extend(tx.committed)
        self.log.append(("commit", text(g), len(tx.committed)))

    # -- execution record (§9.4) and snapshots (§9.5) -------------------------------

    def record(self):
        out = []
        for entry in self.log:
            if entry[0] == "inject":
                out.append({"inject": entry[1]})
            elif entry[0] == "notify":
                out.append({"notify": entry[1]})
            elif entry[0] == "q":
                out.append({"q": entry[1], "from": entry[2], "to": entry[3]})
            elif entry[0] == "output":
                out.append({"output": entry[1], "values": entry[2]})
        return out

    def snapshot(self, name="S1"):
        def event(item):
            source, receivers, out = item
            if receivers is None:
                return {"source": text(source)}
            return {"source": text(source), "to": [text(r) for r in receivers], "out": out}

        def task(item):
            if item[0] == "node":
                return {"node": text(item[1])}
            return {"tx": text(item[1]), "prereqs": [text(p) for p in item[2]]}

        rounds = {}
        for (g, kind), record in sorted(self.rounds.items(), key=lambda kv: (len(kv[0][0]), kv[0])):
            if record:
                rounds.setdefault(text(g), {})[kind] = [text(p) for p in record]
        return {
            "snapshot": name,
            "jkm": self.m.name,
            "version": "7.0.0",
            "q": {text(p): self.q[p] for p in sorted(self.q, key=path_key)},
            "trigger_all": {text(p): list(r) for p, r in sorted(self.trigger_all.items(), key=lambda kv: path_key(kv[0]))
                            if any(v is not None for v in r)},
            "rounds": rounds,
            "queues": {self.queue: {"events": [event(i) for i in self.events], "tasks": [task(i) for i in self.tasks]}},
        }

    def load_snapshot(self, snap):
        problems = check_snapshot(snap, self.m)
        if problems or snap["jkm"] != self.m.name:
            raise ValueError("快照不合法：\n" + "\n".join(problems or ["快照与模型不对应"]))
        addr = self.m.addr
        self.q = {addr[k]: v for k, v in snap["q"].items()}
        for path, record in self.trigger_all.items():
            record[:] = snap["trigger_all"].get(text(path), [None] * len(record))
        for key, record in self.rounds.items():
            record[:] = [addr[p] for p in snap["rounds"].get(text(key[0]), {}).get(key[1], [])]
        fifo = snap["queues"].get(self.queue, {"events": [], "tasks": []})
        self.events = deque((addr[e["source"]], tuple(addr[r] for r in e["to"]) if "to" in e else None,
                             e.get("out", True)) for e in fifo["events"])
        self.tasks = deque(("node", addr[t["node"]]) if "node" in t else ("tx", addr[t["tx"]], tuple(addr[p] for p in t["prereqs"]))
                           for t in fifo["tasks"])

    # -- observation -------------------------------------------------------------

    def writes(self, ref):
        return [entry[3] for entry in self.log if entry[0] == "q" and entry[1] == ref]

    def notifications(self, ref=None):
        return [entry[1] for entry in self.log if entry[0] == "notify" and (ref is None or entry[1] == ref)]

    def count(self, kind):
        return sum(1 for entry in self.log if entry[0] == kind)


def run_script(script, batch=False, start=None, engine=None):
    """Run a §9.4 script; returns the engine. `engine` builds an alternative executor (CUDA model)."""
    model = Model(json.loads((ROOT / script["model"]).read_text(encoding="utf-8")), script["model"])
    problems = check_run_script(script, model)
    if problems:
        raise ValueError("运行脚本不合法：\n" + "\n".join(problems))
    observe = script["observe"]
    ref = (engine or Reference)(model, observe["watch"], observe["read"], batch=batch)
    if start is not None:
        ref.load_snapshot(start)
    for inputs_ in script["batches"]:
        for item in inputs_:
            ref.inject(item)
        ref.run()
    return ref


# ---------------------------------------------------------------------------
# Models used by the acceptance cases
# ---------------------------------------------------------------------------

def doc_blocks():
    return [json.loads(block) for block in re.findall(r"```json\n(.*?)```", DOC.read_text(encoding="utf-8"), re.S)]


def doc_models():
    return {b["jkm"]: b for b in doc_blocks() if isinstance(b, dict) and "jkm" in b and "roots" in b}


def doc_block(key):
    return next(copy.deepcopy(b) for b in doc_blocks() if isinstance(b, dict) and key in b)


def doc_fragment(jki_id):
    return next(copy.deepcopy(b) for b in doc_blocks() if isinstance(b, dict) and b.get("id") == jki_id)


def jkm(name, *roots):
    return {"jkm": name, "version": "7.0.0", "queues": ["work"], "roots": list(roots)}


def jks(jks_id, members, trigger):
    return {"id": jks_id, "members": members, "trigger": trigger, "queue": "work", "pro": {}, "runtime": {}}


def inputs(*ids):
    return [{"id": i, "q": 1, "trigger": {"any": []}} for i in ids]


def run(data, injections, watch=(), read=(), source="case", batch=False, engine=None):
    model = Model(data, source)
    ref = (engine or Reference)(model, watch, read, batch=batch)
    for item in injections:
        ref.inject(item)
    ref.run()
    return ref


def shuffled(data, seed):
    data = copy.deepcopy(data)
    rng = random.Random(seed)

    def walk(obj):
        rng.shuffle(obj["members"])
        for member in obj["members"]:
            if "members" in member:
                walk(member)

    for root in data["roots"]:
        walk(root)
    return data


def random_model(rng):
    """A random valid model: root inputs and nodes, a transactional child G1.G1, a synchronising child G1.G2."""
    def node(qid, triggers, pool):
        n = {"id": qid, "q": rng.randint(0, 1)}
        if len(triggers) > 1 and rng.random() < 0.3:
            n["trigger"] = {"all": triggers}
            n["runtime"] = {"trigger_all": [None] * len(triggers)}
        else:
            n["trigger"] = {"any": triggers}
        if rng.random() < 0.75:
            s = [rng.choice(pool) for _ in range(rng.randint(1, 3))]
            n["sources"] = {"s": s, "ex": [rng.choice("JK") for _ in s]}
            if rng.random() < 0.5:
                n["sources"]["seed"] = rng.randint(0, 1)
        n["publish"] = dict([rng.choice(list(PUBLISH.items()))])
        return n

    def pick(pool, most=3):
        return rng.sample(pool, rng.randint(1, min(most, len(pool))))

    tx_ids = [f"Q{i}" for i in range(1, 8)]
    sync_ids = [f"Q{i}" for i in range(1, 6)]
    pool = ([f"G1.Q{i}" for i in range(1, 9)] + [f"G1.G1.{q}" for q in tx_ids] + [f"G1.G2.{q}" for q in sync_ids])
    root = inputs("Q1", "Q2", "Q3")
    for i in (4, 5, 6):
        root.append(node(f"Q{i}", pick([f"Q{j}" for j in range(1, i)]), pool))

    n_pre = rng.choice([1, 2])
    tx_members = [node(f"Q{i}", pick([f"G1.Q{j}" for j in range(1, 7)]), pool) for i in range(1, n_pre + 1)]
    for i in range(n_pre + 1, 8):
        tx_members.append(node(f"Q{i}", pick([f"Q{j}" for j in range(1, i)]), pool))
    kind = rng.choice(["transaction", "transaction_any"])
    tx = jks("G1", tx_members, {kind: [f"Q{i}" for i in range(1, n_pre + 1)]})

    sync_members = [node(f"Q{i}", pick([f"G1.Q{j}" for j in range(1, 7)]), pool) for i in (1, 2)]
    for i in range(3, 6):
        sync_members.append(node(f"Q{i}", pick([f"Q{j}" for j in range(1, i)]), pool))
    sync = jks("G2", sync_members, {"all": ["Q1", "Q2"]})

    late = [f"G1.G1.{q}" for q in tx_ids[n_pre:]] + [f"G1.G2.{q}" for q in sync_ids]
    for i in (7, 8):
        root.append(node(f"Q{i}", pick(late), pool))
    data = jkm("RANDOM", jks("G1", root + [tx, sync], {"any": ["Q1", "Q2", "Q3"]}))
    model = Model(data, "random")
    assert not model.errors, model.errors
    return data


def random_script(rng):
    return [[f"G1.Q{rng.randint(1, 3)}" for _ in range(rng.randint(1, 3))] for _ in range(rng.randint(1, 4))]


def run_batches(data, batches, watch=(), read=(), batch=False, engine=None):
    ref = (engine or Reference)(Model(data, "random"), watch, read, batch=batch)
    for inputs_ in batches:
        for item in inputs_:
            ref.inject(item)
        ref.run()
    return ref


# ---------------------------------------------------------------------------
# Acceptance cases (JKRD7 §11.2)
# ---------------------------------------------------------------------------

class Cases:
    def __init__(self):
        self.models = doc_models()
        self.results = []

    def check(self, name, condition, detail):
        self.results.append({"case": name, "passed": bool(condition), "detail": detail})

    def flow(self):
        r = run(self.models["M_FLOW"], ["G1.Q1", "G1.Q3"])
        q5, q6 = r.writes("G2.Q5"), r.writes("G2.Q6")
        n5, n6 = len(r.notifications("G2.Q5")), len(r.notifications("G2.Q6"))
        self.check("计算与 seed（M_FLOW）", (q5, q6, n5, n6) == ([1, 0], [1, 1], 2, 2),
                   f"Q5 结果 {q5}，Q6 结果 {q6}，通知 {n5}／{n6}")
        data = copy.deepcopy(self.models["M_FLOW"])
        for node in data["roots"][1]["members"]:
            node["publish"] = {"always_changed": [0, 1]}
        r = run(data, ["G1.Q1", "G1.Q3"])
        n5, n6 = len(r.notifications("G2.Q5")), len(r.notifications("G2.Q6"))
        self.check("changed 与 q_before 比较", (n5, n6) == (2, 1), f"always_changed 时通知 Q5 {n5} 次，Q6 {n6} 次")

    def jki_all(self):
        data = jkm("M_ALL", jks("G1", inputs("Q1", "Q2", "Q3") + [doc_fragment("Q8")],
                                {"any": ["Q1", "Q2", "Q3"]}))
        r = run(data, ["G1.Q1", "G1.Q1", "G1.Q3", "G1.Q3"])
        tasks, record = len(r.writes("G1.Q8")), r.trigger_all[("G1", "Q8")]
        self.check("JKI all：A,A,B,B", (tasks, record) == (1, [None, 0]),
                   f"Q8 计算 {tasks} 次，记录 {record}")

    def empty_ex(self):
        data = jkm("M_EMPTY", jks("G1", inputs("Q9", "Q10") + [doc_fragment("Q17")], {"any": ["Q9", "Q10"]}))
        r = run(data, ["G1.Q9", "G1.Q10", "G1.Q9"])
        n = len(r.notifications("G1.Q17"))
        changed = copy.deepcopy(data)
        changed["roots"][0]["members"][2]["publish"] = {"always_changed": [0, 1]}
        r2 = run(changed, ["G1.Q9", "G1.Q10"])
        self.check("空 EX", (n, r.count("q"), r.q[("G1", "Q17")], len(r2.notifications("G1.Q17"))) == (3, 0, 1, 0),
                   f"默认通知 {n} 次、无节点任务、q 保持 1；always_changed 通知 {len(r2.notifications('G1.Q17'))} 次")

    def jks_all(self):
        r = run(self.models["M_SYNC"], ["G1.Q1", "G1.Q1", "G1.Q2"])
        first = [n for n in r.notifications() if n in ("G1.Q3", "G1.Q4")]
        r.inject("G1.Q2")
        r.run()
        after = [n for n in r.notifications() if n in ("G1.Q3", "G1.Q4")]
        self.check("JKS all 同步（M_SYNC）", first == ["G1.Q3", "G1.Q4"] and after == first,
                   f"放行通知 {first}；再注入 Q2 后 {after}")

    def tx_rounds(self):
        members = inputs("Q1", "Q2") + [
            {"id": "Q3", "q": 0, "trigger": {"any": ["Q1"]}, "sources": {"s": ["Q1"], "ex": ["K"]}},
            {"id": "Q4", "q": 0, "trigger": {"any": ["Q2"]}, "sources": {"s": ["Q2"], "ex": ["K"]}},
        ]
        r = run(jkm("M_ROUND", jks("G1", members, {"transaction": ["Q1", "Q2"]})), ["G1.Q1", "G1.Q1", "G1.Q2", "G1.Q2"])
        left = [text(p) for p in r.rounds[(("G1",), "transaction")]]
        self.check("transaction 轮次", (r.count("tx"), left) == (1, ["G1.Q2"]),
                   f"事务任务 {r.count('tx')} 个，下一轮已记录 {left}")

    def transaction(self):
        data = self.models["M_TX"]
        r = run(data, ["G1.Q10"], watch=["G2.Q101"], read=["G2.Q102"])
        ok = (r.count("tx"), r.writes("G2.Q101"), r.writes("G2.Q102")) == (1, [1], [1])
        self.check("事务传播（M_TX）", ok, f"事务任务 {r.count('tx')} 个，Q101 {r.writes('G2.Q101')}，Q102 {r.writes('G2.Q102')}")
        self.check("统一提交", r.outputs == [{"source": "G2.Q101", "values": [1]}],
                   f"范围外接收者收到 Q101 的通知时读到 Q102={r.outputs[0]['values'][0] if r.outputs else None}")
        blocked = copy.deepcopy(data)
        blocked["roots"][0]["members"][0]["q"] = 0
        next(m for m in blocked["roots"][1]["members"] if m["id"] == "Q101")["publish"] = {"one": [1]}
        r = run(blocked, ["G1.Q10"])
        self.check("不满足 publish 不推进", (r.writes("G2.Q101"), r.writes("G2.Q102")) == ([0], []),
                   f"Q101 {r.writes('G2.Q101')}，Q102 {r.writes('G2.Q102')}")
        r = run(data, ["G1.Q10", "G1.Q10"])
        seq = [e[0] if e[0] in ("tx", "commit") else e[1] for e in r.log if e[0] in ("tx", "commit", "q")]
        expected = ["tx", "G2.Q101", "G2.Q102", "commit"] * 2
        self.check("多实例顺序执行", seq == expected, f"执行记录 {seq}")

    def nested(self):
        r = run(self.models["M_NEST"], ["G1.Q10"])
        names = ["G2.G1.Q101", "G2.G1.Q102", "G2.G2.Q1", "G2.Q201"]
        values = [r.writes(n) for n in names]
        targets = [e[1] for e in r.log if e[0] == "tx"]
        self.check("嵌套事务（M_NEST）", targets == ["G2"] and values == [[1]] * 4,
                   f"事务任务 {targets}，结果 {values}")

    def order_independent(self):
        same = True
        for name, injections in (("M_NEST", ["G1.Q10"]), ("M_PATH", ["G1.Q1"]), ("M_FLOW", ["G1.Q1", "G1.Q3"])):
            base = run(self.models[name], injections).log
            for seed in range(5):
                same = same and run(shuffled(self.models[name], seed), injections).log == base
        data = json.loads(ASCII_MODEL.read_text(encoding="utf-8"))
        base = run(data, [f"G1.Q{d + 1}" for d in (3, 1, 4)]).log
        for seed in range(5):
            same = same and run(shuffled(data, seed), [f"G1.Q{d + 1}" for d in (3, 1, 4)]).log == base
        self.check("书写顺序无关", same, "打乱 members 后，M_NEST、M_PATH、M_FLOW 与十选一的执行记录与原序相同")

    def integrate_first(self):
        def model(q3_trigger, runtime=None):
            q3 = {"id": "Q3", "q": 0, "trigger": q3_trigger, "sources": {"seed": 0, "s": ["G2.Q1"], "ex": ["K"]}}
            if runtime:
                q3["runtime"] = runtime
            g = jks("G1", inputs("Q1", "Q2") + [
                q3, {"id": "Q4", "q": 0, "trigger": {"any": ["Q2"]}, "sources": {"seed": 0, "s": ["Q2"], "ex": ["K"]}},
            ], {"all": ["Q1", "Q2"]})
            h = jks("G2", [{"id": "Q1", "q": 0, "trigger": {"any": ["G1.Q2"]},
                           "sources": {"seed": 0, "s": ["G1.Q2"], "ex": ["K"]}}], {})
            return run(jkm("M_ORDER", g, h), ["G1.Q1", "G1.Q2"])

        r = model({"any": ["Q1"]})
        order = [e[3] for e in r.log if e[0] == "unit" and e[2] == "node"]
        waited = model({"all": ["Q1", "G2.Q1"]}, {"trigger_all": [None, None]})
        ok = order == ["G1.Q3", "G1.Q4", "G2.Q1"] and r.writes("G1.Q3") == [0] and waited.writes("G1.Q3") == [1]
        self.check("先整合后照常投递", ok,
                   f"节点任务顺序 {order}，Q3 读到 G2.Q1 的旧值得 {r.writes('G1.Q3')}；"
                   f"改用 trigger.all 等待 G2.Q1 后得 {waited.writes('G1.Q3')}")

    def path_order(self):
        g = jks("G1", inputs("Q1") + [
            jks("G10", [{"id": "Q1", "q": 1, "trigger": {"any": ["G1.Q1"]}}], {}),
            jks("G2", [{"id": "Q1", "q": 1, "trigger": {"any": ["G1.Q1"]}}], {}),
            {"id": "Q2", "q": 1, "trigger": {"any": ["Q1"]}},
        ], {"any": ["Q1"]})
        got = run(jkm("M_SORT", g), ["G1.Q1"]).notifications()
        self.check("路径排序", got == ["G1.Q2", "G1.G2.Q1", "G1.G10.Q1"], f"投递顺序 {got}")

    def path_example(self):
        r = run(self.models["M_PATH"], ["G1.Q1"])
        self.check("嵌套与同名节点（M_PATH）", (r.writes("G1.G2.Q1"), r.writes("G1.Q2")) == ([1], [1]),
                   f"G1.G2.Q1 {r.writes('G1.G2.Q1')}，G1.Q2 {r.writes('G1.Q2')}")

    def ascii(self):
        data = json.loads(ASCII_MODEL.read_text(encoding="utf-8"))
        root = "G1"
        watch = [f"{root}.Q24"]
        read = [f"{root}.Q{i}" for i in (11, 12, 13, 14, 25, 26, 27, 28)]

        def code(values):
            return int("".join(map(str, values)), 2)

        def outputs(model, digits, overlap, rng=None):
            ref = Reference(Model(model, "ascii"), watch, read)
            for d in digits:
                ref.inject(f"{root}.Q{d + 1}")
                if not overlap:
                    ref.run()
                elif rng is not None:
                    for _ in range(rng.randrange(0, 40)):
                        if not ref.step():
                            break
            ref.run()
            return [code(o["values"]) for o in ref.outputs]

        serial = outputs(data, range(10), False)
        self.check("十选一逐个输入", serial == list(range(0x30, 0x3A)), f"输出 {[hex(c) for c in serial]}")

        rng = random.Random(7)
        mismatches = 0
        trials = 0
        for _ in range(200):
            digits = [rng.randrange(10) for _ in range(rng.randrange(2, 8))]
            expected = [0x30 + d for d in digits]
            trials += 2
            mismatches += outputs(data, digits, True) != expected
            mismatches += outputs(data, digits, True, rng) != expected
        self.check("十选一重叠输入", mismatches == 0, f"{trials} 组重叠或交错输入，与逐个输入不同的有 {mismatches} 组")

        plain = copy.deepcopy(data)
        plain["roots"][0]["trigger"] = {"any": [f"Q{i}" for i in range(1, 11)]}
        wrong = outputs(plain, [0, 1], True)
        self.check("十选一不用事务", wrong != [0x30, 0x31],
                   f"登记改为 any 时，同时输入 0、1 的输出为 {[hex(c) for c in wrong]}，应为 ['0x30', '0x31']")

    def static_counter(self):
        try:
            Reference(Model(jkm("M_Q", jks("G1", inputs("Q1"), {"any": ["Q1"]})), "single"))
            ok = True
        except Unsupported:
            ok = False
        data = jkm("M_MULTI", jks("G1", inputs("Q1"), {"any": ["Q1"]}), jks("G2", inputs("Q1"), {"any": ["Q1"]}))
        data["queues"] = ["a", "b"]
        data["roots"][0]["queue"], data["roots"][1]["queue"] = "a", "b"
        try:
            Reference(Model(data, "multi"))
            refused = False
        except Unsupported:
            refused = True
        self.check("多 queue 暂不支持", ok and refused, "单 queue 可执行；两个 queue 的模型被明确拒绝（§9.3）")

    def outside_tx(self):
        def node_unit(r, path):
            return any(e[0] == "unit" and e[2] == "node" and e[3] == path for e in r.log)

        mixed = jks("G1", inputs("Q1", "Q2") + [
            {"id": "Q3", "q": 0, "trigger": {"any": ["Q1", "Q2"]}, "sources": {"seed": 0, "s": ["Q1"], "ex": ["K"]}},
        ], {"transaction": ["Q1"], "any": ["Q2"]})
        r1 = run(jkm("MIX", mixed), ["G1.Q2"])
        ancestor = jks("G1", inputs("Q1", "Q2") + [jks("G1", [
            {"id": "Q1", "q": 0, "trigger": {"any": ["G1.Q1"]}},
            {"id": "Q2", "q": 0, "trigger": {"any": ["Q1"]}},
            {"id": "Q3", "q": 0, "trigger": {"any": ["Q2"]}, "sources": {"seed": 1, "s": ["Q2"], "ex": ["K"]}},
        ], {"transaction": ["Q1"]})], {"any": ["Q1"], "all": ["Q2", "G1.G1.Q2"]})
        r2 = Reference(Model(jkm("ANC", ancestor)))
        r2.inject("G1.Q1")
        r2.run()
        r2.inject("G1.Q2")
        r2.run()
        entry = jks("G1", inputs("Q1") + [
            jks("G1", [{"id": "Q1", "q": 1, "trigger": {"any": []}}], {"any": ["Q1"]}),
            {"id": "Q2", "q": 0, "trigger": {"any": ["Q1", "G1.G1.Q1"]}, "sources": {"seed": 1, "s": ["Q1"], "ex": ["K"]}},
        ], {"transaction": ["Q1"]})
        r3 = run(jkm("ENT", entry), ["G1.G1.Q1"])
        ok = node_unit(r1, "G1.Q3") and node_unit(r2, "G1.G1.Q3") and node_unit(r3, "G1.Q2")
        self.check("范围内成员在事务外执行（§6.2）", ok,
                   "经同一 JKS 的 any 登记、祖先的 all 登记、范围内的输入入口进入范围的通知，都在事务之外处理")

    def batch_mode(self):
        same = True
        for name, inj in (("M_FLOW", ["G1.Q1", "G1.Q3"]), ("M_PATH", ["G1.Q1"]), ("M_SYNC", ["G1.Q1", "G1.Q1", "G1.Q2"]),
                          ("M_TX", ["G1.Q10", "G1.Q10"]), ("M_NEST", ["G1.Q10"]), ("M_REG", ["G1.Q2", "G1.Q1", "G1.Q2"])):
            same &= run(self.models[name], inj).record() == run(self.models[name], inj, batch=True).record()
        asc = json.loads(ASCII_MODEL.read_text(encoding="utf-8"))
        watch, read = ["G1.Q24"], [f"G1.Q{i}" for i in (11, 12, 13, 14, 25, 26, 27, 28)]
        rng = random.Random(5)
        ascii_bad = 0
        for _ in range(100):
            batches = [[f"G1.Q{rng.randint(1, 10)}" for _ in range(rng.randint(1, 4))] for _ in range(rng.randint(1, 3))]
            ascii_bad += (run_batches(asc, batches, watch, read).record()
                          != run_batches(asc, batches, watch, read, batch=True).record())
        sizes, random_bad = [], 0
        for _ in range(300):
            data, batches = random_model(rng), random_script(rng)
            b = run_batches(data, batches, batch=True)
            random_bad += run_batches(data, batches).record() != b.record()
            sizes += b.batch_sizes
        one = run(asc, ["G1.Q1"], batch=True).batch_sizes
        self.check("可并行批（§7.5）", same and ascii_bad == 0 and random_bad == 0 and one == [4, 4],
                   f"第 10 节模型{'一致' if same else '不一致'}；十选一 100 组、随机模型 300 个，记录不同的分别有 {ascii_bad}、{random_bad} 组；"
                   f"随机模型共 {len(sizes)} 批，平均每批 {sum(sizes) / len(sizes):.2f} 个任务，最大 {max(sizes)}；"
                   f"十选一单次请求的批大小 {one}")

    def run_script_case(self):
        script = doc_block("run")
        a, b = run_script(script), run_script(script, batch=True)
        codes = [int("".join(map(str, o["values"])), 2) for o in a.outputs]
        self.check("运行脚本（§9.4）", codes == [0x30, 0x31, 0x39] and a.record() == b.record(),
                   f"输出 {[hex(c) for c in codes]}，执行记录 {len(a.record())} 条，批执行模式记录相同")

    def snapshot_case(self):
        expected = doc_block("snapshot")
        data = self.models["M_TX"]

        def engine():
            return Reference(Model(data, "M_TX"), ["G2.Q101"], ["G2.Q102"])

        r = engine()
        r.inject("G1.Q10")
        r.inject("G1.Q10")
        while not any(e[0] == "commit" for e in r.log):
            r.step()
        snap, cut = r.snapshot("S1"), len(r.record())
        r.run()
        resumed = engine()
        resumed.load_snapshot(json.loads(json.dumps(snap)))
        resumed.run()
        ok = snap == expected and resumed.record() == r.record()[cut:]

        rng = random.Random(9)
        bad = 0
        for _ in range(150):
            data_r, batches = random_model(rng), random_script(rng)
            full = Reference(Model(data_r, "random"))
            for item in batches[0]:
                full.inject(item)
            for _ in range(rng.randint(0, 25)):
                full.step()
            snap_r, cut_r = json.loads(json.dumps(full.snapshot())), len(full.record())
            rest = Reference(Model(data_r, "random"))
            rest.load_snapshot(snap_r)
            for engine_ in (full, rest):
                engine_.run()
                for inputs_ in batches[1:]:
                    for item in inputs_:
                        engine_.inject(item)
                    engine_.run()
            bad += rest.record() != full.record()[cut_r:]
        self.check("快照（§9.5）", ok and bad == 0,
                   f"M_TX 的中间状态与 §9.5 一致，从快照继续的记录与不中断运行相同；随机模型 150 次中途快照，不同的有 {bad} 次")

    def register(self):
        r = Reference(Model(self.models["M_REG"], "M_REG"), ["G1.Q5"], ["G1.Q5"])
        for s in (2, 2, 1, 1, 2, 1):
            r.inject(f"G1.Q{s}")
            r.run()
        values = [o["values"][0] for o in r.outputs]
        self.check("1 bit 寄存器（M_REG）", values == [1, 1, 0, 0, 1, 0], f"set1,set1,set0,set0,set1,set0 → {values}")

    def cuda_model(self):
        from jk_cuda_model import CudaModel
        same = True
        for name, inj in (("M_FLOW", ["G1.Q1", "G1.Q3"]), ("M_PATH", ["G1.Q1"]), ("M_SYNC", ["G1.Q1", "G1.Q1", "G1.Q2"]),
                          ("M_TX", ["G1.Q10", "G1.Q10"]), ("M_NEST", ["G1.Q10"]), ("M_REG", ["G1.Q2", "G1.Q1", "G1.Q2"])):
            same &= run(self.models[name], inj).record() == run(self.models[name], inj, engine=CudaModel).record()
        script = doc_block("run")
        same &= run_script(script).record() == run_script(script, engine=CudaModel).record()
        asc = json.loads(ASCII_MODEL.read_text(encoding="utf-8"))
        watch, read = ["G1.Q24"], [f"G1.Q{i}" for i in (11, 12, 13, 14, 25, 26, 27, 28)]
        rng = random.Random(13)
        bad, waves = 0, []
        for _ in range(100):
            batches = [[f"G1.Q{rng.randint(1, 10)}" for _ in range(rng.randint(1, 4))] for _ in range(rng.randint(1, 3))]
            bad += (run_batches(asc, batches, watch, read).record()
                    != run_batches(asc, batches, watch, read, engine=CudaModel).record())
        for _ in range(300):
            data, batches = random_model(rng), random_script(rng)
            c = run_batches(data, batches, engine=CudaModel)
            bad += run_batches(data, batches).record() != c.record()
            waves += c.wave_sizes
        self.check("CUDA 执行模型（CUDA.md）", same and bad == 0,
                   f"第 10 节模型与运行脚本{'一致' if same else '不一致'}；十选一 100 组与随机模型 300 个中，记录不同的有 {bad} 组；"
                   f"随机模型共 {len(waves)} 个投递波次，平均每波 {sum(waves) / len(waves):.2f} 条事件，最大 {max(waves)}")

    def run_all(self):
        for case in (self.flow, self.jki_all, self.empty_ex, self.jks_all, self.tx_rounds, self.transaction,
                     self.nested, self.integrate_first, self.path_order, self.path_example,
                     self.order_independent, self.ascii, self.static_counter, self.outside_tx,
                     self.register, self.batch_mode, self.run_script_case, self.snapshot_case, self.cuda_model):
            case()
        return self.results


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write-report", action="store_true")
    parser.add_argument("--script", type=Path, help="运行脚本（JKRD7 §9.4），输出执行记录")
    parser.add_argument("--batch", action="store_true", help="按 §7.5 的可并行批执行")
    parser.add_argument("--start", type=Path, help="从快照（§9.5）继续")
    parser.add_argument("--save", type=Path, help="运行结束后保存快照")
    parser.add_argument("--model", type=Path, help="运行一个 JKM 文件（与 --inject 一起，作为一批输入）")
    parser.add_argument("--inject", nargs="*", default=[], help="按顺序注入的输入入口绝对路径")
    args = parser.parse_args()

    if args.script or args.model:
        if args.script:
            script = json.loads(args.script.read_text(encoding="utf-8"))
        else:
            script = {"run": args.model.stem, "model": str(args.model.resolve().relative_to(ROOT)),
                      "observe": {"watch": [], "read": []}, "batches": [args.inject] if args.inject else []}
        start = json.loads(args.start.read_text(encoding="utf-8")) if args.start else None
        ref = run_script(script, batch=args.batch, start=start)
        for entry in ref.record():
            print(json.dumps(entry, ensure_ascii=False))
        if args.save:
            args.save.write_text(json.dumps(ref.snapshot(script["run"]), ensure_ascii=False, indent=2) + "\n",
                                 encoding="utf-8")
        return 0

    results = Cases().run_all()
    failed = [r for r in results if not r["passed"]]
    for r in results:
        print(f"{'通过' if r['passed'] else '失败'}  {r['case']}：{r['detail']}")
    print(f"\n{len(results) - len(failed)}/{len(results)} 项通过")
    if args.write_report:
        files = [DOC, ASCII_MODEL, Path(__file__).resolve(), ROOT / "scripts/jk_model.py", ROOT / "scripts/jk_cuda_model.py"]
        report = {
            "status": "passed" if not failed else "failed",
            "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "semantics": "JKRD7 §4–§7 serial reference: one unit at a time, event-first, path-ordered delivery, "
                         "JKS integration, transactions with local sequences and a single commit; §7.5 batches; "
                         "§9.4 run scripts and records; §9.5 snapshots; CUDA.md execution model compared",
            "scope": "single-queue models; Python only; not a production executor; no CUDA, multi-queue or hardware check",
            "cases": results,
            "sha256": {str(p.relative_to(ROOT)): sha256(p) for p in files},
        }
        REPORT.parent.mkdir(exist_ok=True)
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"报告已写入 {REPORT.relative_to(ROOT)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
