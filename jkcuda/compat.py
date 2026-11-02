"""Strict legacy inspection and explicit V5 base-structure migration.

This module does not restore historical V5 runtime/module checkpoints. Fingerprint
verification is a content check, never a declaration of executable compatibility.
Sources: JKRD.md (V5), snapshot-recovery-pending.md §8 and the draft-2
readiness-format-extension.json (which retains the draft-1 hash domains).
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class CompatibilityError(ValueError):
    """Invalid legacy data or an unsupported compatibility operation."""


SUPPORT_MATRIX = {
    "V5.draft-1.fingerprints": "verify canonical bytes and contract/F/M digests",
    "V5.draft-2-a03-ready.fingerprints": "verify canonical bytes and contract/F/M digests",
    "V5.draft-1.static-base-structure": "validate and explicitly migrate to a fresh V6.1 run",
    "V5.draft-1.runtime": "unsupported: no native restore",
    "V5.draft-2-a03-ready.runtime": "unsupported: no native A03 module restore",
    "V5.modules-and-factories": "unsupported: no implicit behavior conversion",
    "V4.runtime": "unsupported: missing V5 event/input history cannot be reconstructed",
    "V4.structure": "unsupported: requires a separate validated migration",
}

_PROFILES = {
    "draft-1": "JKRD-V5-DAG-1-2-5",
    "draft-2-a03-ready": "JKRD-V5-DAG-1-2-5+A03-ready-2",
}
_FORMATS = {"jk-logic-structure-V5.0.0", "jk-logic-runtime-V5.0.0"}
_ID = re.compile(r"([QXY])(0|[1-9][0-9]*)\Z")
_POSITIVE = re.compile(r"[1-9][0-9]*\Z")
_HEX = re.compile(r"[0-9a-f]{32}\Z")
_OP = re.compile(r"([JK])(?:([01])|\(([QX](?:0|[1-9][0-9]*))\))")


def _fail(message: str) -> None:
    raise CompatibilityError(message)


def _keys(value: Any, required: set[str], optional: set[str] = frozenset(), *, path: str) -> None:
    if not isinstance(value, dict):
        _fail(f"{path}: expected object")
    missing = required - value.keys()
    extra = value.keys() - required - optional
    if missing or extra:
        _fail(f"{path}: missing={sorted(missing)}, unknown={sorted(extra)}")


def _json_tree(value: Any, path: str = "$") -> None:
    if value is None or type(value) is bool:
        return
    if type(value) is int:
        if value < 0 or value > 9007199254740991:
            _fail(f"{path}: JSON integer must be safe and nonnegative; large identities use decimal strings")
        return
    if isinstance(value, str):
        if any(0xD800 <= ord(ch) <= 0xDFFF for ch in value):
            _fail(f"{path}: lone Unicode surrogate")
        return
    if isinstance(value, list):
        for i, item in enumerate(value):
            _json_tree(item, f"{path}[{i}]")
        return
    if isinstance(value, dict):
        for key, item in value.items():
            if not isinstance(key, str):
                _fail(f"{path}: object key must be a string")
            _json_tree(key, path)
            _json_tree(item, f"{path}.{key}")
        return
    _fail(f"{path}: unsupported JSON value (floating point is forbidden)")


def canonical_bytes(value: Any) -> bytes:
    """Unicode scalar key ordering; arrays and all nested behavior fields retained."""
    _json_tree(value)
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def load_document(source: str | bytes | Path | dict[str, Any]) -> dict[str, Any]:
    """Read strict JSON text/bytes, a Path, or copy an already decoded document.

Use text/bytes/Path for lexical validation; a dict cannot retain duplicate keys,
exponent spelling, or negative-zero spelling from the original JSON.
"""
    if isinstance(source, dict):
        _json_tree(source)
        return copy.deepcopy(source)
    if isinstance(source, Path):
        source = source.read_bytes()
    if isinstance(source, bytes):
        try:
            source = source.decode("utf-8", errors="strict")
        except UnicodeDecodeError as exc:
            raise CompatibilityError("invalid UTF-8") from exc
    if not isinstance(source, str) or source.startswith("\ufeff"):
        _fail("expected JSON text without a BOM")

    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                _fail(f"duplicate decoded object key: {key!r}")
            result[key] = value
        return result

    def integer(text):
        if not re.fullmatch(r"0|[1-9][0-9]*", text):
            _fail("negative or noncanonical integer")
        return int(text)

    def forbidden(text):
        _fail(f"forbidden JSON number: {text}")

    try:
        result = json.loads(source, object_pairs_hook=pairs, parse_int=integer,
                            parse_float=forbidden, parse_constant=forbidden)
    except (json.JSONDecodeError, UnicodeError) as exc:
        raise CompatibilityError(f"invalid JSON: {exc}") from exc
    if not isinstance(result, dict):
        _fail("document root must be an object")
    _json_tree(result)
    return result


def _envelope(doc: dict[str, Any]) -> None:
    _keys(doc, {"format", "schema_revision", "rule_profile", "canonicalization", "structure", "metadata", "fingerprints"}, {"runtime"}, path="document")
    if not isinstance(doc["format"], str) or doc["format"] not in _FORMATS:
        _fail(f"unsupported format: {doc['format']!r}")
    revision = doc["schema_revision"]
    if not isinstance(revision, str) or revision not in _PROFILES or doc["rule_profile"] != _PROFILES[revision]:
        _fail("unknown or mismatched V5 schema_revision/rule_profile")
    if doc["canonicalization"] != "jk-json-v5-draft-1":
        _fail("unsupported canonicalization")
    is_runtime = doc["format"] == "jk-logic-runtime-V5.0.0"
    if is_runtime != ("runtime" in doc):
        _fail("runtime field must exist only on runtime documents")
    if is_runtime and not isinstance(doc["runtime"], dict):
        _fail("runtime must be an object")
    if not isinstance(doc["structure"], dict) or not isinstance(doc["structure"].get("nodes"), list):
        _fail("structure.nodes must be an array")
    _keys(doc["fingerprints"], {"format_md5", "md5"}, path="fingerprints")
    for value in doc["fingerprints"].values():
        if not isinstance(value, str) or not _HEX.fullmatch(value):
            _fail("fingerprint must be 32 lowercase hex digits")


def fingerprints_v5(source: str | bytes | Path | dict[str, Any]) -> dict[str, str]:
    """Compute the historical F/M digests without claiming semantic validity."""
    doc = load_document(source)
    _envelope(doc)
    structure = copy.deepcopy(doc["structure"])
    for node in structure["nodes"]:
        if not isinstance(node, dict):
            _fail("structure.nodes entry must be an object")
        if node.get("pro") == "q=0/1":
            del node["pro"]
    fmt = {"domain": "jk-v5-format-draft-1", "schema_revision": doc["schema_revision"],
           "rule_profile": doc["rule_profile"], "canonicalization": doc["canonicalization"],
           "structure": structure}
    run = {"domain": "jk-v5-document-draft-1", "format": doc["format"],
           "format_payload": fmt, "runtime": doc.get("runtime")}
    return {"format_md5": hashlib.md5(canonical_bytes(fmt)).hexdigest(),
            "md5": hashlib.md5(canonical_bytes(run)).hexdigest()}


def verify_v5_fingerprints(source: str | bytes | Path | dict[str, Any]) -> dict[str, str]:
    """Verify contract and document hashes; this is not a runtime validator."""
    doc = load_document(source)
    actual = fingerprints_v5(doc)
    if actual != doc["fingerprints"]:
        _fail("V5 document fingerprint mismatch")
    contracts = doc["structure"].get("contracts")
    if not isinstance(contracts, list):
        _fail("structure.contracts must be an array")
    for contract in contracts:
        _keys(contract, {"id", "revision", "definition_md5", "definition"}, path="contract")
        digest = hashlib.md5(canonical_bytes(contract["definition"])).hexdigest()
        if digest != contract["definition_md5"]:
            _fail(f"contract definition fingerprint mismatch: {contract['id']}")
    return actual


def parse_v5_ex(expression: str) -> list[tuple[str, str]]:
    """Consume the complete strict legacy EX grammar, retaining repeated ops."""
    if not isinstance(expression, str) or not expression:
        _fail("EX must be a nonempty string")
    result = []
    offset = 0
    while offset < len(expression):
        match = _OP.match(expression, offset)
        if match is None:
            _fail(f"invalid EX token at offset {offset}: {expression!r}")
        result.append((match[1], match[2] if match[2] is not None else match[3]))
        offset = match.end()
    return result


def _number(symbol: Any, kind: str) -> int:
    match = _ID.fullmatch(symbol) if isinstance(symbol, str) else None
    if match is None or match[1] != kind:
        _fail(f"expected canonical {kind} identifier: {symbol!r}")
    return int(match[2])


def _ordered_ids(symbols: list, kind: str, path: str) -> None:
    if not isinstance(symbols, list):
        _fail(f"{path}: expected array")
    numbers = [_number(symbol, kind) for symbol in symbols]
    if numbers != sorted(set(numbers)):
        _fail(f"{path}: identifiers must be unique and numerically ordered")


def _positive(value: Any, path: str) -> int:
    if not isinstance(value, str) or not _POSITIVE.fullmatch(value):
        _fail(f"{path}: positive decimal string required")
    result = int(value)
    if result > 2**63 - 1:
        _fail(f"{path}: generation/version exceeds device signed 64-bit representation")
    return result


@dataclass(frozen=True)
class MigrationResult:
    model: dict[str, Any]
    report: dict[str, Any]


def import_v5_structure(source: str | bytes | Path | dict[str, Any]) -> MigrationResult:
    """Validate draft-1 static base semantics and create a fresh V6.1 model.

No old runtime, module, FIFO, pending event, or output is silently discarded.
The explicitly named migration result records that this is a new execution.
"""
    doc = load_document(source)
    verify_v5_fingerprints(doc)
    if doc["format"] != "jk-logic-structure-V5.0.0":
        _fail("native V5 runtime restore is unsupported; refusing to discard execution history")
    if doc["schema_revision"] != "draft-1":
        _fail("A03 draft-2 structure/module execution is unsupported")
    structure = doc["structure"]
    _keys(structure, {"nodes", "initial_q", "inputs", "outputs", "q_y", "capacity", "contracts", "factories", "modules"}, path="structure")
    for name in ("contracts", "factories", "modules"):
        if structure[name] != []:
            _fail(f"static base migration does not implement {name}; refusing implicit conversion")
    _keys(structure["capacity"], {"max_live_nodes"}, path="capacity")
    if structure["capacity"]["max_live_nodes"] is not None:
        _fail("legacy model-imposed node capacity requires a registered equivalent V6.1 resource contract")
    metadata = doc["metadata"]
    _keys(metadata, {"name", "created_unix_ns", "display", "provenance"}, path="metadata")
    if not isinstance(metadata["name"], str) or not isinstance(metadata["created_unix_ns"], str) or not re.fullmatch(r"0|[1-9][0-9]*", metadata["created_unix_ns"]):
        _fail("invalid metadata name/timestamp")
    if not isinstance(metadata["display"], dict) or not isinstance(metadata["provenance"], dict):
        _fail("metadata display/provenance must be objects")
    nodes = structure["nodes"]
    if not nodes:
        _fail("a base structure requires nodes")
    for node in nodes:
        _keys(node, {"id", "generation", "ex_version", "ex"}, {"pro"}, path="node")
        _positive(node["generation"], "node.generation")
        _positive(node["ex_version"], "node.ex_version")
    _ordered_ids([node["id"] for node in nodes], "Q", "nodes")
    by_id = {node["id"]: node for node in nodes}
    initial = structure["initial_q"]
    _keys(initial, {"0", "1"}, path="initial_q")
    for bit in ("0", "1"):
        _ordered_ids(initial[bit], "Q", f"initial_q.{bit}")
    if set(initial["0"]) & set(initial["1"]):
        _fail("initial_q duplicates a state across values")
    state_values = {node: bit for bit in (0, 1) for node in initial[str(bit)]}
    if not state_values.keys() <= by_id.keys():
        _fail("initial_q references an absent node")
    for kind, name in (("X", "inputs"), ("Y", "outputs")):
        ports = structure[name]
        if not isinstance(ports, list):
            _fail(f"{name} must be an array")
        for port in ports:
            _keys(port, {"id", "external"}, path=name)
            if not isinstance(port["external"], str) or not port["external"]:
                _fail("external port names must be nonempty strings")
        _ordered_ids([port["id"] for port in ports], kind, name)
        if [port["id"] for port in ports] != [f"{kind}{i}" for i in range(len(ports))]:
            _fail(f"{name} must use contiguous {kind}0..{kind}(N-1) identifiers")
        if len({port["external"] for port in ports}) != len(ports):
            _fail(f"{name} external names must be unique")
    input_nodes = {f"Q{_number(port['id'], 'X')}": port["id"] for port in structure["inputs"]}
    if not input_nodes.keys() <= by_id.keys():
        _fail("input lacks its same-numbered copy node")
    parsed = {node["id"]: parse_v5_ex(node["ex"]) for node in nodes}
    refs = {}
    consumers = {node: set() for node in by_id}
    for node in nodes:
        nid = node["id"]
        ops = parsed[nid]
        sources = {arg for _, arg in ops if arg not in ("0", "1")}
        stateful = nid in state_values
        pro = node.get("pro", "q=0/1")
        if pro not in ("q=0/1", "q=0", "q=1", "q="):
            _fail("invalid propagation condition")
        if not stateful and (ops[0] != ("J", "0") or pro == "q=" or nid in sources):
            _fail(f"{nid}: stateless EX must start J0, cannot be silent or self-referential")
        if nid in input_nodes:
            if node["ex"] != f"J0K({input_nodes[nid]})":
                _fail(f"{nid}: input copy EX must be J0K(same Xi)")
        else:
            if any(arg.startswith("X") for arg in sources):
                _fail(f"{nid}: only matching input copy may reference Xi")
            if not (sources - {nid}):
                _fail(f"{nid}: at least one non-self Q source is required")
        qrefs = {arg for arg in sources if arg.startswith("Q")}
        if not qrefs <= by_id.keys():
            _fail(f"{nid}: missing Q source")
        refs[nid] = qrefs - {nid}
        for ref in refs[nid]:
            consumers[ref].add(nid)
    bindings = structure["q_y"]
    if not isinstance(bindings, list) or len(bindings) != len(structure["outputs"]):
        _fail("q_y must bind every declared output exactly once")
    outputs_by_node = {node: [] for node in by_id}
    for index, binding in enumerate(bindings):
        _keys(binding, {"output", "node"}, path="q_y")
        _keys(binding["node"], {"id", "generation"}, path="q_y.node")
        if binding["output"] != structure["outputs"][index]["id"]:
            _fail("q_y output order or identity mismatch")
        nid = binding["node"]["id"]
        if nid not in by_id or binding["node"]["generation"] != by_id[nid]["generation"]:
            _fail("q_y references an absent node or stale generation")
        if by_id[nid].get("pro", "q=0/1") != "q=0/1":
            _fail("Yi may bind only an unconditional publishing Q")
        consumers[nid].add(binding["output"])
        outputs_by_node[nid].append(structure["outputs"][index]["external"])
    if any(not value for value in consumers.values()):
        _fail("every live Q requires a non-self Q consumer or Yi binding")
    # Independent Kahn traversal: self is excluded, all other Q references count,
    # including silent nodes and otherwise inactive state.
    indegree = {nid: len(value) for nid, value in refs.items()}
    frontier = [nid for nid, count in indegree.items() if count == 0]
    visited = 0
    while frontier:
        source_id = frontier.pop()
        visited += 1
        for target in consumers[source_id]:
            if target not in indegree:
                continue
            indegree[target] -= 1
            if indegree[target] == 0:
                frontier.append(target)
    if visited != len(nodes):
        _fail("V5 base graph must be a DAG after excluding valid state self references")

    result_nodes = []
    subscriptions = []
    for target_order, node in enumerate(nodes):
        nid = node["id"]
        event_sources = {ref for ref in refs[nid] if ref not in state_values or ref in input_nodes}
        sources = {}
        operations = []
        for op, arg in parsed[nid]:
            key = f"${arg}" if arg in ("0", "1") else arg
            operations.append([op, key])
            if arg in ("0", "1"):
                sources[key] = {"kind": "CONST", "value": int(arg)}
            elif arg == nid:
                sources[key] = {"kind": "SELF"}
            elif arg in event_sources or arg.startswith("X"):
                sources[key] = {"kind": "PARAM", "param": arg}
            else:
                sources[key] = {"kind": "STATE", "state": arg}
        trigger_sources = event_sources if event_sources else refs[nid]
        trigger_sources = sorted(trigger_sources, key=lambda ref: _number(ref, "Q"))
        converted = {"id": nid, "generation": int(node["generation"]), "version": int(node["ex_version"]),
                     "queue": "Xi.FIFO" if nid in input_nodes else "Qi.FIFO",
                     "state": nid if nid in state_values else None, "seed": 0,
                     "ex": node["ex"], "ops": operations, "sources": sources,
                     "trigger": {"mode": "ALL_LATEST" if event_sources else "ANY", "ports": trigger_sources},
                     "publish": {"q=0/1": "always", "q=0": "zero", "q=1": "one", "q=": "never"}[node.get("pro", "q=0/1")]}
        if outputs_by_node[nid]:
            # Multiple Yi bindings must remain distinct output records. The V6.1
            # base node API currently has one output field: refuse lossy collapse.
            if len(outputs_by_node[nid]) != 1:
                _fail("multiple Yi bindings per Q require multi-output backend support")
            converted["output"] = outputs_by_node[nid][0]
        result_nodes.append(converted)
        for ref in trigger_sources:
            # A compact rank preserves numeric-ID ordering without truncating a
            # sparse or arbitrarily large logical node ID into a device index.
            subscriptions.append({"source": ref, "target": nid, "port": ref, "order": target_order})
    model = {"profile": "jkcuda.v6.1", "format_version": 1,
             "queues": [{"name": "Xi.FIFO", "priority": 1}, {"name": "RAM.FIFO", "priority": 2}, {"name": "Qi.FIFO", "priority": 5}],
             "states": [{"id": nid, "initial": state_values[nid]} for nid in by_id if nid in state_values],
             "values": {}, "nodes": result_nodes, "subscriptions": subscriptions,
             "inputs": [{"name": port["external"], "node": f"Q{_number(port['id'], 'X')}", "param": port["id"]} for port in structure["inputs"]]}
    report = {"operation": "import-structure-as-new-run", "source_format": doc["format"],
              "source_revision": doc["schema_revision"], "source_fingerprints": doc["fingerprints"],
              "destination_profile": "jkcuda.v6.1", "native_restore": False,
              "preserved": ["initial_q", "original_EX_and_repeated_operations", "q_seed_self", "Xi_event_latching",
                            "input_copy_event_source_classification", "ALL_LATEST_overwrite_and_clear", "Xi_RAM_Qi_priority", "numeric_target_order", "publication_conditions"],
              "scope": "static V5 base structure; no RAM/factory/module behavior or historical runtime",
              "limitations": ["V6.1 snapshot/failure/I/O protocol applies to the new run", "no claim of full V5 runtime compatibility"]}
    return MigrationResult(model=model, report=report)
