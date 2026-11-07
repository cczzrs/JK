#!/usr/bin/env python3
"""JKRD7 model loading, reference resolution and static checks.

Covers the static rules of JKRD7.md: JSON conventions (§2), JKI fields (§3),
JKS fields and registration (§5), transaction range constraints (§6.2) and
JKM / absolute paths (§8). Execution lives in jk_reference.py.
Python 3 standard library only.
"""

import re

VERSION = "7.0.0"
Q_ID = re.compile(r"Q[1-9][0-9]*\Z")
G_ID = re.compile(r"G[1-9][0-9]*\Z")
JKI_FIELDS = ("id", "q", "trigger", "sources", "publish", "pro", "runtime")
JKS_FIELDS = ("id", "members", "trigger", "queue", "pro", "runtime")
JKM_FIELDS = ("jkm", "version", "queues", "roots")
PUBLISH = {
    "always": [0, 1],
    "zero": [0],
    "one": [1],
    "never": [],
    "always_changed": [0, 1],
    "zero_changed": [0],
    "one_changed": [1],
}
# §5.2: registration types with a defined integration.
REGISTRATION_TYPES = ("any", "all", "transaction", "transaction_any",
                      "ack", "pre", "post", "comp", "frame")
GATED_TYPES = ("all", "transaction", "transaction_any")
TX_TYPES = ("transaction", "transaction_any")


def is_bit(value):
    return type(value) is int and value in (0, 1)


def is_jks(obj):
    return isinstance(obj, dict) and "members" in obj


def has_ex(node):
    return bool(node.get("sources", {}).get("ex"))


def text(path):
    return ".".join(path)


def path_key(path):
    """§7.3 order of a JKI path: per level, JKI (Q+n) before JKS (G+n), then by number."""
    return tuple((0 if seg[0] == "Q" else 1, int(seg[1:])) for seg in path)


def _str_list(value, allow_empty=True):
    return (isinstance(value, list) and (allow_empty or value)
            and all(isinstance(item, str) and item for item in value))


def check_jki(node, where, errors):
    """Field-level checks of one JKI (§2, §3, §4.4). References are not resolved here."""

    def err(message):
        errors.append(f"{where}: {message}")

    if not isinstance(node, dict):
        err("JKI 必须是对象")
        return
    extra = sorted(set(node) - set(JKI_FIELDS))
    if extra:
        err(f"未批准的 JKI 字段 {extra}（§2 第 5 条）")
    for field in ("id", "q", "trigger"):
        if field not in node:
            err(f"缺少必填字段 {field}（§3）")
    if "id" in node and not (isinstance(node["id"], str) and Q_ID.match(node["id"])):
        err("id 必须是 Q＋正整数（§3）")
    if "q" in node and not is_bit(node["q"]):
        err("q 必须是整数 0 或 1（§2 第 2 条）")

    mode = refs = None
    trigger = node.get("trigger")
    if "trigger" in node:
        if not (isinstance(trigger, dict) and len(trigger) == 1 and next(iter(trigger)) in ("any", "all")):
            err("trigger 必须恰好有 any 或 all 一个键（§3）")
        else:
            mode, refs = next(iter(trigger.items()))
            if not _str_list(refs):
                err(f"trigger.{mode} 必须是非空字符串组成的数组")
                refs = None
            elif len(set(refs)) != len(refs):
                err(f"trigger.{mode} 不得重复（§3.1）")
            elif mode == "all" and not refs:
                err("trigger.all 不得为空（§3.2）")

    if "sources" in node:
        sources = node["sources"]
        if not isinstance(sources, dict):
            err("sources 必须是对象")
        else:
            extra = sorted(set(sources) - {"s", "ex", "seed"})
            if extra:
                err(f"sources 含未批准字段 {extra}")
            s_list = sources.get("s", [])
            ex_list = sources.get("ex", [])
            if not _str_list(s_list):
                err("sources.s 必须是非空字符串组成的数组")
            if not (isinstance(ex_list, list) and all(op in ("J", "K") for op in ex_list)):
                err('sources.ex 只能由 "J"、"K" 组成')
            elif ex_list and (not isinstance(s_list, list) or len(ex_list) != len(s_list)):
                err("sources.ex 非空时必须与 s 等长（§3）")
            if "seed" in sources and not is_bit(sources["seed"]):
                err("sources.seed 只能是 0 或 1，null 非法（§3.3）")

    if "publish" in node:
        publish = node["publish"]
        if not isinstance(publish, dict):
            err("publish 必须是对象")
        elif publish:
            if len(publish) != 1:
                err("publish 必须恰好一个模式键（§4.4）")
            else:
                key, value = next(iter(publish.items()))
                if (key not in PUBLISH or not isinstance(value, list)
                        or any(type(v) is not int for v in value) or value != PUBLISH[key]):
                    err(f"publish 必须是七种模式之一并使用固定集合（§4.4），得到 {publish}")

    if "pro" in node:
        pro = node["pro"]
        if not isinstance(pro, dict):
            err("pro 必须是对象")
        else:
            extra = sorted(set(pro) - {"jksid", "tag"})
            if extra:
                err(f"pro 含未批准字段 {extra}（§3）")
            if "jksid" in pro and not (isinstance(pro["jksid"], str) and pro["jksid"]):
                err("pro.jksid 必须是非空字符串")
            if "tag" in pro and not _str_list(pro["tag"]):
                err("pro.tag 必须是非空字符串组成的数组")

    runtime = node.get("runtime")
    if "runtime" in node:
        if not isinstance(runtime, dict):
            err("runtime 必须是对象")
            runtime = None
        else:
            extra = sorted(set(runtime) - {"trigger_all"})
            if extra:
                err(f"runtime 含未批准字段 {extra}")
    if mode == "all" and refs is not None:
        record = (runtime or {}).get("trigger_all")
        if not (isinstance(record, list) and len(record) == len(refs)):
            err("all 节点必须保留与 trigger.all 等长的 runtime.trigger_all（§3）")
        elif not all(v is None for v in record):
            err("定义中的 runtime.trigger_all 必须全为 null；运行中的到达记录只保存在快照中（§3、§9.5）")
    elif mode == "any" and runtime and "trigger_all" in runtime:
        err("any 节点不保存 trigger_all（§3）")


class Model:
    """A loaded JKM. `errors` lists every rule violation; derived indexes are valid only without errors."""

    def __init__(self, data, source="model"):
        self.source = source
        self.name = data.get("jkm") if isinstance(data, dict) else None
        self.errors = []
        self.jki = {}          # path tuple -> JKI object
        self.jks = {}          # path tuple -> JKS object
        self.addr = {}         # path text -> path tuple
        self.queues = []
        self._load(data)
        if not self.errors:
            self._derive()

    # -- loading ---------------------------------------------------------

    def err(self, message):
        self.errors.append(f"{self.source}: {message}")

    def _load(self, data):
        if not isinstance(data, dict):
            self.err("JKM 必须是对象（§8.1）")
            return
        if set(data) != set(JKM_FIELDS):
            self.err(f"JKM 字段必须恰好是 {list(JKM_FIELDS)}（§8.1），得到 {sorted(data)}")
        if not (isinstance(data.get("jkm"), str) and data.get("jkm")):
            self.err("jkm 必须是非空字符串")
        if data.get("version") != VERSION:
            self.err(f'version 必须是 "{VERSION}"')
        queues = data.get("queues")
        if not (_str_list(queues, allow_empty=False) and len(set(queues)) == len(queues)):
            self.err("queues 必须是非空、无重复的字符串数组（§8.1）")
        else:
            self.queues = list(queues)
        roots = data.get("roots")
        if not isinstance(roots, list):
            self.err("roots 必须是数组")
            return
        seen = set()
        for i, root in enumerate(roots):
            if not is_jks(root):
                self.err(f"roots[{i}] 必须是 JKS 对象")
                continue
            if root.get("id") in seen:
                self.err(f"根 id 重复：{root.get('id')}")
            seen.add(root.get("id"))
            self._walk(root, (), f"roots[{i}]")

    def _walk(self, obj, prefix, where):
        extra = sorted(set(obj) - set(JKS_FIELDS))
        missing = [f for f in JKS_FIELDS if f not in obj]
        if extra or missing:
            self.err(f"{where}: JKS 必须恰好有六个字段（§5.1），多出 {extra}，缺少 {missing}")
        jks_id = obj.get("id")
        if not (isinstance(jks_id, str) and G_ID.match(jks_id)):
            self.err(f"{where}: JKS id 必须是 G＋正整数（§5.1），得到 {jks_id!r}")
            return
        path = prefix + (jks_id,)
        where = text(path)
        self._register(path, obj, self.jks)
        if not isinstance(obj.get("trigger"), dict):
            self.err(f"{where}: trigger 必须是对象")
        if self.queues and obj.get("queue") not in self.queues:
            self.err(f"{where}: queue 必须是 JKM.queues 中声明的名称（§8.1），得到 {obj.get('queue')!r}")
        pro = obj.get("pro")
        if not isinstance(pro, dict):
            self.err(f"{where}: JKS.pro 必须是对象（§5.1）")
        else:
            extra = sorted(set(pro) - {"tag"})
            if extra:
                self.err(f"{where}: JKS.pro 含未批准字段 {extra}，已批准的只有 tag（§5.1）")
            if "tag" in pro and not _str_list(pro["tag"]):
                self.err(f"{where}: JKS.pro.tag 必须是非空字符串组成的数组（§5.1）")
        if obj.get("runtime") != {}:
            self.err(f"{where}: JKS.runtime 内部格式未定义，必须是 {{}}（§5.1）")
        members = obj.get("members")
        if not (isinstance(members, list) and members):
            self.err(f"{where}: members 必须是非空数组（§5.1）")
            return
        ids = set()
        for i, member in enumerate(members):
            if not isinstance(member, dict):
                self.err(f"{where}.members[{i}]: 成员必须是完整对象（§5.1）")
                continue
            member_id = member.get("id")
            if member_id in ids:
                self.err(f"{where}: 同层成员 id 重复：{member_id}")
            ids.add(member_id)
            if is_jks(member):
                self._walk(member, path, f"{where}.members[{i}]")
            else:
                before = len(self.errors)
                check_jki(member, f"{self.source}: {where}.{member_id}", self.errors)
                if len(self.errors) == before:
                    self._register(path + (member_id,), member, self.jki)

    def _register(self, path, obj, table):
        key = text(path)
        if key in self.addr:
            self.err(f"绝对路径冲突：{key}（§8.2）")
            return
        self.addr[key] = path
        table[path] = obj

    # -- resolution ------------------------------------------------------

    def resolve(self, ref, layer):
        """Resolve a reference written inside JKS `layer` (§8.2). Returns (path, problem)."""
        if not isinstance(ref, str) or not ref:
            return None, "引用必须是非空字符串"
        if "." not in ref:
            path = layer + (ref,)
            if path in self.jki:
                return path, None
            if path in self.jks:
                return None, f"{ref} 落到 JKS，引用必须落到 JKI"
            return None, f"短 ID {ref} 不是 {text(layer)} 的直接成员 JKI（短 ID 只在本层解析）"
        path = self.addr.get(ref)
        if path is None:
            return None, f"绝对路径 {ref} 不存在"
        if path in self.jks:
            return None, f"{ref} 落到 JKS，引用必须落到 JKI"
        return path, None

    def desc_jki(self, jks_path):
        n = len(jks_path)
        return {p for p in self.jki if p[:n] == jks_path}

    def gated(self, jks_path, subscriber):
        """§5.3: is `subscriber` integrated by a registration of `jks_path`?"""
        return subscriber in self.members[jks_path] and subscriber not in self.prereqs[jks_path]

    # -- derived indexes and model-level checks ----------------------------

    def _derive(self):
        self.members = {g: self.desc_jki(g) for g in self.jks}
        self.trigger_refs = {}
        self.source_refs = {}
        for path, node in self.jki.items():
            layer = path[:-1]
            refs = next(iter(node["trigger"].values()))
            self.trigger_refs[path] = self._resolve_all(refs, layer, f"{text(path)}.trigger")
            self.source_refs[path] = self._resolve_all(node.get("sources", {}).get("s", []), layer,
                                                       f"{text(path)}.sources.s")
            if len(set(self.trigger_refs[path])) != len(self.trigger_refs[path]):
                self.err(f"{text(path)}.trigger：短 ID 与绝对路径指向同一 JKI，属于重复（§3.1）")

        self.reg_types = {}    # jks path -> {type: [prereq paths]}
        self.prereqs = {}      # jks path -> set of prereq paths
        self.reg_of = {}       # prereq path -> (jks path, type)
        for g, obj in self.jks.items():
            self.reg_types[g] = {}
            self.prereqs[g] = set()
            for kind, refs in obj["trigger"].items():
                where = f"{text(g)}.trigger.{kind}"
                if kind not in REGISTRATION_TYPES:
                    self.err(f"{where}：未定义的登记类型，新增类型须先在 JKRD7 §5.2 定义（§5.2）")
                    continue
                if not _str_list(refs, allow_empty=False):
                    self.err(f"{where}：必须是非空的前置 ID 数组（§5.2）")
                    continue
                paths = self._resolve_all(refs, g, where)
                for p in paths:
                    if p not in self.members[g]:
                        self.err(f"{where}：前置 ID {text(p)} 不是本结构的成员 JKI（§5.2）")
                    elif p in self.prereqs[g]:
                        self.err(f"{where}：{text(p)} 在同一 JKS.trigger 中重复登记（§5.2）")
                    elif p in self.reg_of:
                        self.err(f"{where}：{text(p)} 已登记在 {text(self.reg_of[p][0])}；"
                                 "同一 JKI 被多个 JKS 登记暂不支持（§9.3 第 1 项）")
                    else:
                        self.prereqs[g].add(p)
                        self.reg_of[p] = (g, kind)
                self.reg_types[g][kind] = paths

        for path, node in self.jki.items():
            if node["trigger"].get("any") == [] and path not in self.reg_of:
                self.err(f"{text(path)}：trigger.any=[] 只允许用于已登记的输入入口（§3.2）")
            jksid = node.get("pro", {}).get("jksid")
            if jksid is not None and self.addr.get(jksid) not in self.jks:
                self.err(f"{text(path)}：pro.jksid 必须是实际 JKS 的绝对路径（§3），得到 {jksid!r}")

        self.range = {}
        for g, kinds in self.reg_types.items():
            if not any(kind in TX_TYPES for kind in kinds):
                continue
            scope = self.members[g] - self.prereqs[g]
            self.range[g] = scope
            for s in sorted(scope, key=path_key):
                for x in self.trigger_refs[s]:
                    if x not in self.members[g]:
                        self.err(f"{text(g)}：事务范围内的 {text(s)} 被范围外的 {text(x)} 触发，"
                                 "外部上游只能接到前置成员上（§6.2）")
            cycle = self._find_cycle({s: [x for x in self.trigger_refs[s] if x in scope] for s in scope})
            if cycle:
                self.err(f"{text(g)}：事务范围内的触发连接成环 {' → '.join(text(p) for p in cycle)}（§6.2）")

        self.subscribers = {}
        for s, refs in self.trigger_refs.items():
            for x in refs:
                self.subscribers.setdefault(x, []).append(s)
        for x in self.subscribers:
            self.subscribers[x].sort(key=path_key)

        # §6.2: pure notification loops (any, empty EX, publishes on its constant q, ungated edges)
        def loud(node):
            mode = next(iter(node.get("publish") or {"always": [0, 1]}))
            return ("any" in node["trigger"] and not has_ex(node)
                    and mode in ("always", "zero", "one") and node["q"] in PUBLISH[mode])

        def ungated(x, s):
            reg = self.reg_of.get(x)
            return not (reg and reg[1] in GATED_TYPES and self.gated(reg[0], s))

        quiet = {p for p, node in self.jki.items() if loud(node)}
        cycle = self._find_cycle({s: [x for x in self.trigger_refs[s] if x in quiet and ungated(x, s)] for s in quiet})
        if cycle:
            self.err(f"纯通知环 {' → '.join(text(p) for p in cycle)}：永不终止，并使全部任务得不到执行（§6.2）")

    def _resolve_all(self, refs, layer, where):
        paths = []
        for ref in refs:
            path, problem = self.resolve(ref, layer)
            if problem:
                self.err(f"{where}：{problem}")
            else:
                paths.append(path)
        return paths

    def _find_cycle(self, edges):
        """edges: node -> nodes it is triggered by. Returns one cycle or None."""
        state = {}

        def visit(node, stack):
            state[node] = 1
            stack.append(node)
            for nxt in edges[node]:
                if state.get(nxt) == 1:
                    return stack[stack.index(nxt):] + [nxt]
                if nxt not in state:
                    found = visit(nxt, stack)
                    if found:
                        return found
            stack.pop()
            state[node] = 2
            return None

        for start in sorted(edges, key=path_key):
            if start not in state:
                found = visit(start, [])
                if found:
                    return found
        return None


# ---------------------------------------------------------------------------
# Run scripts (§9.4) and snapshots (§9.5)
# ---------------------------------------------------------------------------

RUN_FIELDS = ("run", "model", "observe", "batches")
SNAPSHOT_FIELDS = ("snapshot", "jkm", "version", "q", "trigger_all", "rounds", "queues")


def is_input_entry(model, path):
    return path in model.jki and model.jki[path]["trigger"].get("any") == [] and path in model.reg_of


def check_run_script(script, model):
    """§9.4. `model` is the loaded Model named by script["model"]."""
    errors = []
    if not isinstance(script, dict) or set(script) != set(RUN_FIELDS):
        return [f"运行脚本字段必须恰好是 {list(RUN_FIELDS)}（§9.4）"]
    if not (isinstance(script["run"], str) and script["run"]):
        errors.append("run 必须是非空字符串")
    observe = script["observe"]
    if not (isinstance(observe, dict) and set(observe) == {"watch", "read"}
            and all(_str_list(observe[k]) for k in ("watch", "read"))):
        errors.append("observe 必须是 {watch, read}，两者都是路径数组（§9.4）")
    else:
        for ref in observe["watch"] + observe["read"]:
            if model.addr.get(ref) not in model.jki:
                errors.append(f"observe 中的 {ref} 不是 JKI 绝对路径")
    batches = script["batches"]
    if not (isinstance(batches, list) and all(_str_list(b, allow_empty=False) for b in batches)):
        errors.append("batches 必须是非空路径数组组成的数组（§9.4）")
    else:
        for batch in batches:
            for ref in batch:
                if not is_input_entry(model, model.addr.get(ref)):
                    errors.append(f"batches 中的 {ref} 不是输入入口（§3.2）")
    return errors


def check_snapshot(snap, model):
    """§9.5: structure and consistency of a snapshot against its model."""
    errors = []
    if not isinstance(snap, dict) or set(snap) != set(SNAPSHOT_FIELDS):
        return [f"快照字段必须恰好是 {list(SNAPSHOT_FIELDS)}（§9.5）"]
    if snap["version"] != VERSION:
        errors.append(f'version 必须是 "{VERSION}"')
    q = snap["q"]
    if not (isinstance(q, dict) and set(q) == {text(p) for p in model.jki} and all(is_bit(v) for v in q.values())):
        errors.append("q 必须给出全部 JKI 的 0／1 值（§9.5）")
    for ref, record in (snap["trigger_all"] or {}).items():
        path = model.addr.get(ref)
        node = model.jki.get(path)
        if not (node and "all" in node["trigger"] and isinstance(record, list)
                and len(record) == len(node["trigger"]["all"])
                and all(v is None or is_bit(v) for v in record) and any(v is not None for v in record)
                and any(v is None for v in record)):
            errors.append(f"trigger_all 中 {ref} 的记录不合法（§9.5）")
    for ref, kinds in (snap["rounds"] or {}).items():
        g = model.addr.get(ref)
        if g not in model.jks or not isinstance(kinds, dict):
            errors.append(f"rounds 的键 {ref} 不是 JKS 绝对路径")
            continue
        for kind, prereqs in kinds.items():
            registered = [text(p) for p in model.reg_types[g].get(kind, [])]
            if (kind not in ("all", "transaction") or not _str_list(prereqs, allow_empty=False)
                    or len(set(prereqs)) != len(prereqs) or not set(prereqs) < set(registered)):
                errors.append(f"rounds 中 {ref}.{kind} 的记录不合法：只能列出未到齐的本轮前置（§9.5）")
    queues = snap["queues"]
    if not (isinstance(queues, dict) and set(queues) <= set(model.queues)):
        return errors + ["queues 的键必须是 JKM.queues 中声明的名称"]
    for name, fifo in queues.items():
        if not (isinstance(fifo, dict) and set(fifo) == {"events", "tasks"}):
            errors.append(f"queues.{name} 必须是 {{events, tasks}}")
            continue
        for item in fifo["events"]:
            ok = isinstance(item, dict) and model.addr.get(item.get("source")) in model.jki
            if ok and set(item) == {"source", "to", "out"}:
                ok = (isinstance(item["to"], list) and all(model.addr.get(r) in model.jki for r in item["to"])
                      and isinstance(item["out"], bool))
            elif ok:
                ok = set(item) == {"source"}
            if not ok:
                errors.append(f"queues.{name}.events 中的事件项不合法：{item}")
        for item in fifo["tasks"]:
            if isinstance(item, dict) and set(item) == {"node"}:
                ok = model.addr.get(item["node"]) in model.jki and has_ex(model.jki[model.addr[item["node"]]])
            elif isinstance(item, dict) and set(item) == {"tx", "prereqs"}:
                g = model.addr.get(item["tx"])
                ok = (g in model.range and _str_list(item["prereqs"], allow_empty=False)
                      and all(model.addr.get(r) in model.prereqs[g] for r in item["prereqs"]))
            else:
                ok = False
            if not ok:
                errors.append(f"queues.{name}.tasks 中的任务项不合法：{item}")
    return errors
