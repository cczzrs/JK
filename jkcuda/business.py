"""Declarative finite JK DAG → native V6.1 PRE/COMP/POST task graph.

The generated graph uses ordinary EX nodes and keyed event matching. Native
frame control only owns PRE admission/claim and transfers already computed
POST values. This is an explicit V6.1 construction, not the V5 A03 node graph.
"""
from __future__ import annotations

import copy
import re

BUSINESS_PROFILE = "jkcuda.business/1"


def _identifier(value, label):
    if not isinstance(value, str) or re.fullmatch(r"[A-Za-z_][A-Za-z_0-9]*", value) is None:
        raise ValueError(f"{label} must be an ASCII identifier")
    return value


def _bit(value, label):
    if type(value) is not int or value not in (0, 1):
        raise ValueError(f"{label} must be integer 0 or 1")
    return value


def _fields(value, allowed, label):
    if not isinstance(value, dict) or set(value) - set(allowed):
        raise ValueError(f"invalid or unknown {label} fields")


def _normalize(spec):
    from .model import parse_ex
    _fields(spec, {"widths", "block_capacity", "prefix"}, "business declaration")
    prefix = _identifier(spec.get("prefix", "business"), "business prefix")
    capacity = spec.get("block_capacity", 8)
    if type(capacity) is not int or not 0 < capacity < 2**63:
        raise ValueError("block_capacity must be a positive int64")
    widths = spec.get("widths")
    if not isinstance(widths, dict) or not widths:
        raise ValueError("declare at least one supported input width")
    normalized = {"prefix": prefix, "block_capacity": capacity, "widths": {}}
    seen_widths = set()
    for raw_width, raw in widths.items():
        if not isinstance(raw_width, str) or not raw_width.isascii() or not raw_width.isdigit():
            raise ValueError("width keys must be canonical positive decimal strings")
        width = int(raw_width)
        if not 0 < width < 2**31 or str(width) != raw_width or width in seen_widths:
            raise ValueError("invalid or duplicate supported width")
        seen_widths.add(width)
        _fields(raw, {"nodes", "outputs", "state", "next_state"}, "width declaration")
        state = raw.get("state", {})
        if not isinstance(state, dict):
            raise ValueError("state must map names to initial bits")
        state = {_identifier(key, "state name"): _bit(value, "initial state") for key, value in state.items()}
        nodes = raw.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            raise ValueError("each width requires a nonempty finite DAG")
        identifiers = [_identifier(node.get("id") if isinstance(node, dict) else None, "node ID") for node in nodes]
        if len(set(identifiers)) != len(identifiers):
            raise ValueError("duplicate business node ID")
        node_ids, dependencies, parsed = set(identifiers), {}, {}
        for raw_node in nodes:
            _fields(raw_node, {"id", "ex", "sources", "seed", "dependencies"}, "business node")
            identifier = raw_node["id"]
            bindings = raw_node.get("sources", {})
            if not isinstance(bindings, dict):
                raise ValueError("business sources must be a mapping")
            bindings = copy.deepcopy(bindings)
            needs = set()
            for name, source in bindings.items():
                _identifier(name, "source name")
                kind = source.get("kind") if isinstance(source, dict) else None
                allowed = {"INPUT": {"kind", "index"}, "RESULT": {"kind", "node"},
                           "STATE": {"kind", "state"}, "CONST": {"kind", "value"},
                           "SELF": {"kind"}}.get(kind)
                if allowed is None:
                    raise ValueError("business source kind must be INPUT, RESULT, STATE, CONST, or SELF")
                _fields(source, allowed, "business source")
                if kind == "INPUT" and (type(source.get("index")) is not int or not 0 <= source["index"] < width):
                    raise ValueError("INPUT source is outside the declared width")
                if kind == "RESULT":
                    if source.get("node") not in node_ids:
                        raise ValueError("RESULT references an unknown business node")
                    needs.add(source["node"])
                if kind == "STATE" and source.get("state") not in state:
                    raise ValueError("STATE references an undeclared per-width state")
                if kind == "CONST":
                    _bit(source.get("value"), "business constant")
            explicit = raw_node.get("dependencies", [])
            if not isinstance(explicit, list) or len(set(explicit)) != len(explicit) or set(explicit) - node_ids:
                raise ValueError("dependencies must list distinct existing nodes")
            needs.update(explicit)
            parse_ex(raw_node.get("ex"), copy.deepcopy(bindings))
            dependencies[identifier] = needs
            parsed[identifier] = {"id": identifier, "ex": raw_node["ex"], "sources": bindings,
                                  "seed": _bit(raw_node.get("seed", 0), "business seed"),
                                  "dependencies": list(explicit)}
        ordered, left = [], set(identifiers)
        while left:
            ready = [identifier for identifier in identifiers if identifier in left and not dependencies[identifier] & left]
            if not ready:
                raise ValueError("business RESULT/dependency graph must be acyclic")
            ordered.extend(parsed[identifier] for identifier in ready)
            left.difference_update(ready)
        outputs = raw.get("outputs")
        if not isinstance(outputs, list) or not outputs or any(identifier not in node_ids for identifier in outputs):
            raise ValueError("outputs must be an ordered nonempty list of business node IDs")
        next_state = raw.get("next_state", {})
        if not isinstance(next_state, dict) or set(next_state) != set(state) or any(value not in node_ids for value in next_state.values()):
            raise ValueError("next_state must explicitly map every state slot to a computed node")
        normalized["widths"][raw_width] = {"nodes": ordered, "outputs": list(outputs),
                                           "state": dict(sorted(state.items())), "next_state": dict(sorted(next_state.items()))}
    normalized["widths"] = dict(sorted(normalized["widths"].items(), key=lambda item: int(item[0])))
    return normalized


def _construct(spec):
    declaration = _normalize(spec)
    prefix = declaration["prefix"]
    queue, input_queue = prefix + ".work", prefix + ".input"
    model = {"profile": "jkcuda.v6.1", "format_version": 1,
             "queues": [{"name": input_queue, "priority": 1}, {"name": queue, "priority": 2}],
             "states": [], "nodes": [], "subscriptions": [], "inputs": [],
             "values": {}, "transactions": [], "entrypoints": [], "budgets": []}
    subscription_orders = {}

    def add_node(identifier, ex, sources, *, ports=(), state=None, seed=0, publish="always", output=None):
        model["nodes"].append({"id": identifier, "generation": 1, "version": 1, "queue": queue,
                               "state": state, "seed": seed, "ex": ex, "sources": sources,
                               "trigger": {"mode": "KEYED" if ports else "ANY", "ports": list(ports)},
                               "publish": publish, "output": output})
        return identifier

    def edge(source, target, port):
        order = subscription_orders.get(source, 0)
        subscription_orders[source] = order + 1
        model["subscriptions"].append({"source": source, "target": target, "port": port, "order": order})

    def param(port):
        return {"kind": "PARAM", "param": port}

    data = add_node(prefix + ".output.data", "J0K(bit)", {"bit": param("bit")}, output="DATA")
    marker = add_node(prefix + ".output.marker", "J0K(flag)", {"flag": param("flag")}, output="FRAME_OUT")
    profiles = []
    for raw_width, definition in declaration["widths"].items():
        width = int(raw_width)
        stem = prefix + ".w" + raw_width
        start = len(model["nodes"])
        pre = [add_node(stem + ".PRE." + str(i), "J0K(bit)", {"bit": param("bit")}) for i in range(width)]
        s_state, c_state = stem + ".S_W", stem + ".C_W"
        model["states"].extend([{"id": s_state, "initial": 0}, {"id": c_state, "initial": 0}])
        state_slots = {name: stem + ".state." + name for name in definition["state"]}
        model["states"].extend({"id": state_slots[name], "initial": value} for name, value in definition["state"].items())
        input_ports = ["i" + str(i) for i in range(width)]
        parity_ex = "J0" + "".join("K(" + port + ")" for port in input_ports)
        parity_sources = {port: param(port) for port in input_ports}
        s_sources = {**parity_sources, "previous": {"kind": "STATE", "state": c_state}}
        s_node = add_node(stem + ".S", parity_ex + "K(previous)", s_sources, ports=input_ports, state=s_state)
        c_node = add_node(stem + ".C", parity_ex, parity_sources, ports=input_ports, state=c_state)
        # Every final input arrival enqueues S before C in the same FIFO. S reads
        # the old per-width C; both publish zero as an ordinary completed value.
        for i, provider in enumerate(pre):
            edge(provider, s_node, input_ports[i])
            edge(provider, c_node, input_ports[i])
        go = add_node(stem + ".GO", "J0K1", {"s": param("s"), "c": param("c")}, ports=("s", "c"))
        edge(s_node, go, "s"); edge(c_node, go, "c")
        comp = {node["id"]: stem + ".COMP." + node["id"] for node in definition["nodes"]}
        for node in definition["nodes"]:
            bindings, providers = {}, {"go": go}
            for name, source in node["sources"].items():
                kind = source["kind"]
                if kind == "INPUT":
                    port = "i" + str(source["index"])
                    providers[port] = pre[source["index"]]
                    bindings[name] = param(port)
                elif kind == "RESULT":
                    port = "r_" + source["node"]
                    providers[port] = comp[source["node"]]
                    bindings[name] = param(port)
                elif kind == "STATE":
                    bindings[name] = {"kind": "STATE", "state": state_slots[source["state"]]}
                else:
                    bindings[name] = copy.deepcopy(source)
            # Explicit dependencies retain a real event and availability check,
            # including those not needed by the node's arithmetic expression.
            for dependency in node["dependencies"]:
                port = "r_" + dependency
                providers[port] = comp[dependency]
            for position, port in enumerate(providers):
                internal = "_contract_" + str(position)
                while internal in bindings:
                    internal += "_"
                bindings[internal] = param(port)
            target = add_node(comp[node["id"]], node["ex"], bindings,
                              ports=providers, seed=node["seed"])
            for port, provider in providers.items():
                edge(provider, target, port)
        result_ports = ["r_" + node["id"] for node in definition["nodes"]]
        commit = add_node(stem + ".COMMIT", "J0K1", {port: param(port) for port in result_ports}, ports=result_ports)
        for node, port in zip(definition["nodes"], result_ports):
            edge(comp[node["id"]], commit, port)
        post_nodes, post_ports = [], []
        for index, provider in enumerate(definition["outputs"]):
            post = add_node(stem + ".POST." + str(index), "J0K(value)",
                            {"value": param("value"), "commit": param("commit")}, ports=("value", "commit"))
            edge(comp[provider], post, "value"); edge(commit, post, "commit")
            post_nodes.append(post); post_ports.append("p" + str(index))
        next_nodes, next_ports = [], []
        for name, provider in definition["next_state"].items():
            nxt = add_node(stem + ".NEXT." + name, "J0K(value)",
                           {"value": param("value"), "commit": param("commit")},
                           ports=("value", "commit"), state=state_slots[name])
            edge(comp[provider], nxt, "value"); edge(commit, nxt, "commit")
            next_nodes.append(nxt); next_ports.append("s_" + name)
        finish_ports = post_ports + next_ports
        finish = add_node(stem + ".FINISH", "J0K1", {port: param(port) for port in finish_ports},
                          ports=finish_ports, publish="never")
        for provider, port in zip(post_nodes + next_nodes, finish_ports):
            edge(provider, finish, port)
        profiles.append({"input_width": width, "output_width": len(post_nodes), "pre_nodes": pre,
                         "finish_node": finish, "finish_params": post_ports,
                         "s_state": s_state, "c_state": c_state, "state_slots": state_slots,
                         "protected_nodes": [node["id"] for node in model["nodes"][start:]]})
    model["frame_module"] = {"input_queue": input_queue, "queue": queue, "data_node": data,
                             "data_param": "bit", "marker_node": marker, "marker_param": "flag",
                             "block_capacity": declaration["block_capacity"],
                             "max_width": max(max(p["input_width"], p["output_width"]) for p in profiles)}
    model["business_module"] = {"profile": BUSINESS_PROFILE, "spec": declaration, "widths": profiles,
                                "protected_nodes": [node["id"] for node in model["nodes"]],
                                "protected_states": [state["id"] for state in model["states"]]}
    return model


def build_business_model(spec):
    """Build a validated model for explicitly declared input widths and JK DAGs.

    ``spec['widths']`` maps canonical width strings to ``nodes``, ordered
    ``outputs``, initial ``state`` and complete ``next_state`` mappings. Each
    node declares EX, seed bit, source bindings and optional dependencies.
    STATE values are read when COMP actually executes. SELF refers to that
    node's declared seed bit; use explicit STATE to read cross-round memory.
    """
    from .model import load_model
    return load_model(_construct(spec))


def validate_business_contract(model):
    """Regenerate protected semantics; a hash alone cannot authorize a hook."""
    from .model import parse_ex
    contract = model.get("business_module")
    if not isinstance(contract, dict) or contract.get("profile") != BUSINESS_PROFILE:
        raise ValueError("unsupported business module contract")
    expected = _construct(contract.get("spec"))
    if contract != expected["business_module"] or model.get("frame_module") != expected["frame_module"]:
        raise ValueError("business declaration and native profile table disagree")
    protected = set(contract["protected_nodes"])
    protected_states = set(contract["protected_states"])
    actual_nodes = {node["id"]: node for node in model["nodes"]}
    for expected_node in expected["nodes"]:
        identifier = expected_node["id"]
        actual = actual_nodes.get(identifier)
        if actual is None:
            raise ValueError("missing protected business node")
        compiled = copy.deepcopy(expected_node)
        compiled["ops"] = parse_ex(compiled["ex"], compiled["sources"])
        for name, value in compiled.items():
            if actual.get(name) != value:
                raise ValueError(f"protected business node {identifier} differs in {name}")
        if actual.get("budget_group") is not None:
            raise ValueError("business progress cannot be assigned an unrelated execution budget")
    actual_states = {state["id"]: state["initial"] for state in model["states"]}
    for state in expected["states"]:
        if actual_states.get(state["id"]) != state["initial"]:
            raise ValueError("protected business state/initial value differs")
    actual_edges = [edge for edge in model["subscriptions"] if edge["source"] in protected or edge["target"] in protected]
    if actual_edges != expected["subscriptions"]:
        raise ValueError("protected business subscriptions cannot be changed or externally injected")
    if any(port["node"] in protected for port in model.get("inputs", [])) or protected & set(model.get("entrypoints", [])):
        raise ValueError("business nodes can only be entered through submit_frame")
    if any(step["node"] in protected for transaction in model.get("transactions", []) for step in transaction["steps"]):
        raise ValueError("business task boundaries cannot be wrapped in an external transaction")
    for node in model["nodes"]:
        if node["id"] in protected:
            continue
        if node.get("state") in protected_states or any(source.get("kind") == "STATE" and source.get("state") in protected_states
                                                       for source in node["sources"].values()):
            raise ValueError("business state is owned by its declared task graph")
    return True
