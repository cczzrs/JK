"""Explicit V6.1 model format; no implicit conversion of historical profiles.

This module validates the host description. Model effects belong to FIFO tasks.
The format and policy choices are documented in docs/cuda-runtime.md.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any

PROFILE = "jkcuda.v6.1"
FORMAT_VERSION = 1


class ModelError(ValueError):
    pass


def bit(value: Any, label: str = "value") -> int:
    if type(value) is not int or value not in (0, 1):
        raise ModelError(f"{label} must be integer 0 or 1")
    return value


def integer(value: Any, label: str, minimum: int = 0) -> int:
    if type(value) is not int or not minimum <= value < 2**63:
        raise ModelError(f"{label} must be an integer in [{minimum}, 2**63)")
    return value


def name(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ModelError(f"{label} must be a nonempty string without NUL")
    return value


def canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value: Any) -> str:
    return hashlib.sha256(canonical_bytes(value)).hexdigest()


def _fields(value: dict, allowed: set, label: str) -> None:
    if not isinstance(value, dict):
        raise ModelError(f"{label} must be an object")
    unknown = value.keys() - allowed
    if unknown:
        raise ModelError(f"unknown {label} fields: {sorted(unknown)}")


def parse_ex(expression: str, sources: dict) -> list:
    """Consume every character. Constants become ordinary immutable operands."""
    if not isinstance(expression, str) or not expression:
        raise ModelError("EX must be a nonempty string")
    position, result = 0, []
    pattern = re.compile(r"([JK])(?:([01])|\(([A-Za-z_][A-Za-z_0-9.:/-]*)\))")
    while position < len(expression):
        match = pattern.match(expression, position)
        if match is None:
            raise ModelError(f"invalid EX at offset {position}: {expression!r}")
        operator, literal, source = match.groups()
        if literal is not None:
            source = "$" + literal
            binding = {"kind": "CONST", "value": int(literal)}
            if source in sources and sources[source] != binding:
                raise ModelError("literal operand conflicts with a declared source binding")
            sources[source] = binding
        elif source not in sources:
            raise ModelError(f"undefined EX source {source!r}")
        result.append([operator, source])
        position = match.end()
    return result


def strongly_connected(nodes: list, edges: list) -> list:
    """Iterative Kosaraju, including large graphs without Python recursion."""
    forward = {node: [] for node in nodes}
    reverse = {node: [] for node in nodes}
    for source, target in edges:
        forward[source].append(target)
        reverse[target].append(source)
    visited, finish = set(), []
    for start in nodes:
        if start in visited:
            continue
        visited.add(start)
        stack = [(start, iter(forward[start]))]
        while stack:
            node, following = stack[-1]
            target = next(following, None)
            if target is None:
                finish.append(node)
                stack.pop()
            elif target not in visited:
                visited.add(target)
                stack.append((target, iter(forward[target])))
    visited, components = set(), []
    for start in reversed(finish):
        if start in visited:
            continue
        visited.add(start)
        group, stack = [], [start]
        while stack:
            node = stack.pop()
            group.append(node)
            for target in reverse[node]:
                if target not in visited:
                    visited.add(target)
                    stack.append(target)
        components.append(sorted(group))
    return components


def load_model(source: Any) -> dict:
    if isinstance(source, (str, Path)):
        source = json.loads(Path(source).read_text(encoding="utf-8"))
    model = copy.deepcopy(source)
    _fields(model, {"profile", "format_version", "queues", "states", "nodes",
                    "subscriptions", "inputs", "values", "transactions",
                    "entrypoints", "budgets", "frame_module", "business_module", "metadata"}, "model")
    if (model.get("profile") != PROFILE or type(model.get("format_version")) is not int
            or model.get("format_version") != FORMAT_VERSION):
        raise ModelError("unsupported profile/format; use an explicit migration adapter")
    queues = model.get("queues", [])
    if not isinstance(queues, list) or not queues:
        raise ModelError("declare at least one FIFO with a fixed unique priority")
    queue_names, priorities = set(), set()
    for queue in queues:
        _fields(queue, {"name", "priority"}, "queue")
        identifier = name(queue.get("name"), "queue.name")
        priority = integer(queue.get("priority"), "queue.priority")
        if identifier in queue_names or priority in priorities:
            raise ModelError("FIFO names and priorities must each be unique")
        queue_names.add(identifier)
        priorities.add(priority)
    states = model.setdefault("states", [])
    state_names = set()
    for state in states:
        _fields(state, {"id", "initial"}, "state")
        identifier = name(state.get("id"), "state.id")
        bit(state.get("initial"), "state.initial")
        if identifier in state_names:
            raise ModelError("duplicate state ID")
        state_names.add(identifier)
    values = model.setdefault("values", {})
    if not isinstance(values, dict):
        raise ModelError("values must be a mapping of immutable value IDs to bits")
    for identifier, value in values.items():
        name(identifier, "value ID")
        bit(value, "immutable value")
    nodes = model.get("nodes", [])
    if not isinstance(nodes, list) or not nodes:
        raise ModelError("nodes must be a nonempty array")
    node_map = {}
    for node in nodes:
        _fields(node, {"id", "generation", "version", "queue", "state", "seed",
                       "ex", "ops", "sources", "trigger", "publish", "output",
                       "budget_group"}, "node")
        identifier = name(node.get("id"), "node.id")
        if identifier in node_map:
            raise ModelError(f"duplicate node ID {identifier}")
        node_map[identifier] = node
        integer(node.setdefault("generation", 1), "node.generation", 1)
        integer(node.setdefault("version", 1), "node.version", 1)
        if node.get("queue") not in queue_names:
            raise ModelError(f"unknown FIFO for {identifier}")
        if node.setdefault("state", None) not in state_names | {None}:
            raise ModelError(f"unknown state slot for {identifier}")
        bit(node.setdefault("seed", 0), "node.seed")
        if node.setdefault("publish", "always") not in {"always", "zero", "one", "never", "changed"}:
            raise ModelError(f"unknown publish condition for {identifier}")
        if node.setdefault("output", None) is not None:
            name(node["output"], "node.output")
        sources = node.setdefault("sources", {})
        if not isinstance(sources, dict):
            raise ModelError("sources must be an object")
        for key, binding in sources.items():
            name(key, "source name")
            if not re.fullmatch(r"[A-Za-z_][A-Za-z_0-9.:/-]*|\$[01]", key):
                raise ModelError(f"invalid source name {key}")
            kind = binding.get("kind") if isinstance(binding, dict) else None
            allowed = {"CONST": {"kind", "value"}, "STATE": {"kind", "state"},
                       "PARAM": {"kind", "param"}, "SELF": {"kind"},
                       "VALUE": {"kind", "value_id"}}.get(kind)
            if allowed is None:
                raise ModelError(f"unknown source kind {kind}")
            _fields(binding, allowed, "source")
            if kind == "CONST":
                bit(binding.get("value"), "CONST")
            elif kind == "STATE" and binding.get("state") not in state_names:
                raise ModelError("STATE references an unknown state slot")
            elif kind == "VALUE" and binding.get("value_id") not in values:
                raise ModelError("VALUE must reference an existing immutable value")
            elif kind == "PARAM":
                name(binding.get("param"), "PARAM name")
        generated_ops = parse_ex(node.get("ex"), sources)
        if "ops" in node and node["ops"] != generated_ops:
            raise ModelError("provided compiled ops do not match original EX")
        node["ops"] = generated_ops
        trigger = node.setdefault("trigger", {"mode": "ANY", "ports": []})
        _fields(trigger, {"mode", "ports"}, "trigger")
        if trigger.get("mode") not in {"ANY", "ALL_LATEST", "ZIP", "KEYED"}:
            raise ModelError("unknown trigger mode")
        ports = trigger.get("ports")
        if not isinstance(ports, list) or len(set(ports)) != len(ports):
            raise ModelError("trigger ports must be a unique ordered array")
        for port in ports:
            name(port, "trigger port")
        if trigger["mode"] != "ANY" and not ports:
            raise ModelError("collecting triggers require at least one port")
    subscriptions = model.setdefault("subscriptions", [])
    orders, supplied = set(), {identifier: set() for identifier in node_map}
    graph_edges = []
    for edge in subscriptions:
        _fields(edge, {"source", "target", "port", "order"}, "subscription")
        if edge.get("source") not in node_map or edge.get("target") not in node_map:
            raise ModelError("subscription references an unknown node")
        if edge.get("port") not in node_map[edge["target"]]["trigger"]["ports"]:
            raise ModelError("subscription port is not declared by its target")
        order = integer(edge.get("order"), "subscription.order")
        order_key = (edge["source"], order)
        if order_key in orders:
            raise ModelError("subscription order must be unique for each event source")
        orders.add(order_key)
        supplied[edge["target"]].add(edge["port"])
        graph_edges.append((edge["source"], edge["target"]))
    inputs = model.setdefault("inputs", [])
    input_names, input_nodes = set(), set()
    for port in inputs:
        _fields(port, {"name", "node", "param"}, "input")
        identifier = name(port.get("name"), "input.name")
        if identifier in input_names or port.get("node") not in node_map:
            raise ModelError("duplicate input name or unknown input node")
        input_names.add(identifier)
        input_nodes.add(port["node"])
        name(port.get("param"), "input.param")
        required = {binding["param"] for binding in node_map[port["node"]]["sources"].values()
                    if binding["kind"] == "PARAM"}
        if required - {port["param"]}:
            raise ModelError("input task cannot supply all required parameters")
    entrypoints = model.setdefault("entrypoints", [])
    if not isinstance(entrypoints, list) or len(set(entrypoints)) != len(entrypoints) or set(entrypoints) - node_map.keys():
        raise ModelError("entrypoints must contain unique existing node IDs")
    for identifier, node in node_map.items():
        ports = node["trigger"]["ports"]
        required = {binding["param"] for binding in node["sources"].values() if binding["kind"] == "PARAM"}
        if supplied[identifier]:
            if supplied[identifier] != set(ports):
                raise ModelError(f"unconnected required trigger port on {identifier}")
            if node["trigger"]["mode"] == "ANY":
                if any(required - {port} for port in ports):
                    raise ModelError(f"ANY event cannot supply all PARAM bindings on {identifier}")
            elif required - set(ports):
                raise ModelError(f"trigger cannot supply required PARAM bindings on {identifier}")
    budgets = model.setdefault("budgets", [])
    budget_ids = set()
    for budget in budgets:
        _fields(budget, {"id", "limit"}, "budget")
        group = integer(budget.get("id"), "budget.id")
        integer(budget.get("limit"), "budget.limit", 1)
        if group in budget_ids:
            raise ModelError("duplicate budget group")
        budget_ids.add(group)
    for node in nodes:
        group = node.setdefault("budget_group", None)
        if group is not None:
            integer(group, "node.budget_group")
            if group not in budget_ids:
                raise ModelError("node references an unknown budget group")
    roots = input_nodes | set(entrypoints)
    reachable = set(roots)
    adjacency = {node: [] for node in node_map}
    for left, right in graph_edges:
        adjacency[left].append(right)
    todo = list(roots)
    while todo:
        for target in adjacency[todo.pop()]:
            if target not in reachable:
                reachable.add(target)
                todo.append(target)
    for component in strongly_connected(list(node_map), graph_edges):
        cyclic = len(component) > 1 or (component[0], component[0]) in graph_edges
        if cyclic and not set(component) & reachable:
            raise ModelError("feedback component has no declared input/entrypoint startup path")
        if cyclic and any(node_map[n]["budget_group"] is None for n in component):
            raise ModelError("feedback nodes require an explicit logical-call budget")
    transactions = model.setdefault("transactions", [])
    tx_names = set()
    for transaction in transactions:
        _fields(transaction, {"name", "queue", "steps"}, "transaction")
        identifier = name(transaction.get("name"), "transaction.name")
        if identifier in tx_names or transaction.get("queue") not in queue_names:
            raise ModelError("duplicate transaction name or unknown FIFO")
        tx_names.add(identifier)
        steps = transaction.get("steps")
        if not isinstance(steps, list) or not steps:
            raise ModelError("transaction requires ordered steps")
        for index, step in enumerate(steps):
            _fields(step, {"node", "params", "result_refs"}, "transaction step")
            if step.get("node") not in node_map:
                raise ModelError("transaction step references unknown node")
            for parameter, value in step.setdefault("params", {}).items():
                name(parameter, "transaction parameter")
                if isinstance(value, dict):
                    _fields(value, {"param"}, "transaction external parameter")
                    name(value.get("param"), "transaction external parameter")
                else:
                    bit(value, "transaction constant")
            for parameter, prior in step.setdefault("result_refs", {}).items():
                name(parameter, "transaction result parameter")
                integer(prior, "result_ref")
                if prior >= index or parameter in step["params"]:
                    raise ModelError("result_ref must identify a preceding step without a duplicate binding")
            required = {binding["param"] for binding in node_map[step["node"]]["sources"].values()
                        if binding["kind"] == "PARAM"}
            if required - (step["params"].keys() | step["result_refs"].keys()):
                raise ModelError("transaction step cannot supply all required PARAM bindings")
            declared = required | set(node_map[step["node"]]["trigger"]["ports"])
            if (step["params"].keys() | step["result_refs"].keys()) - declared:
                raise ModelError("transaction step supplies an undeclared parameter")
    frame = model.get("frame_module")
    if frame is not None:
        _fields(frame, {"input_queue", "queue", "data_node", "data_param", "marker_node",
                        "marker_param", "block_capacity", "max_width"}, "frame_module")
        if frame.get("input_queue") not in queue_names or frame.get("queue") not in queue_names:
            raise ModelError("frame module must declare existing input/control FIFOs")
        integer(frame.get("block_capacity"), "frame block_capacity", 1)
        integer(frame.get("max_width"), "frame max_width", 1)
        if frame.get("data_node") == frame.get("marker_node"):
            raise ModelError("frame data and marker must have distinct declared nodes")
        for role in ("data", "marker"):
            identifier, parameter = frame.get(role + "_node"), frame.get(role + "_param")
            name(parameter, "frame " + role + " parameter")
            if identifier not in node_map:
                raise ModelError("frame adapter references an unknown node")
            node = node_map[identifier]
            if node["state"] is not None or node["queue"] != frame["queue"] or node["publish"] != "always" or node["output"] is None:
                raise ModelError("frame adapters require stateless, always-publishing output nodes in the module FIFO")
            dynamic = [(source, binding) for source, binding in node["sources"].items() if binding["kind"] != "CONST"]
            if (len(dynamic) != 1 or dynamic[0][1] != {"kind": "PARAM", "param": parameter}
                    or node["ex"] != f"J0K({dynamic[0][0]})"):
                raise ModelError("frame output adapter must explicitly copy its latched PARAM via J0K(source)")
    if model.get("business_module") is not None:
        from .business import validate_business_contract
        validate_business_contract(model)
    return model


def structure_fingerprint(model: dict) -> str:
    logical = copy.deepcopy(model)
    logical.pop("metadata", None)
    return digest({"canonicalization": "jkcuda.sha256.v1", "structure": logical})
