#!/usr/bin/env python3
"""Finite checks of current JKRD7 JKI/JKS examples; not a loader or executor."""
import argparse
import copy
from datetime import datetime, timezone
import hashlib
import itertools
import json
from pathlib import Path
import re
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets/jks-factory-v7-design"
JKI_FIELDS = {"id", "q", "trigger", "sources", "publish", "pro", "runtime"}
JKI_REQUIRED = {"id", "q", "trigger"}
JKS_FIELDS = {"id", "members", "trigger", "queue", "pro", "runtime"}
# Literal result sets and (q_before, result) tables from the approved publish rules.
PUBLICATION = {
    "always": ([0, 1], {(0, 0), (0, 1), (1, 0), (1, 1)}),
    "zero": ([0], {(0, 0), (1, 0)}),
    "one": ([1], {(0, 1), (1, 1)}),
    "never": ([], set()),
    "always_changed": ([0, 1], {(0, 1), (1, 0)}),
    "zero_changed": ([0], {(1, 0)}),
    "one_changed": ([1], {(0, 1)}),
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def bit(value):
    return type(value) is int and value in (0, 1)


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def parse(text):
    def invalid_constant(value):
        raise ValueError(f"Non-JSON numeric constant: {value}")
    return json.loads(text, object_pairs_hook=strict_pairs,
                      parse_constant=invalid_constant)


def read(path):
    return parse(path.read_text(encoding="utf-8"))


def references(values):
    return isinstance(values, list) and bool(values) and all(
        isinstance(value, str) and value for value in values)


def check_jki(node, *, allow_unbound_entry=False):
    require(JKI_REQUIRED <= set(node) <= JKI_FIELDS, "JKI required and optional fields")
    require(isinstance(node["id"], str) and re.fullmatch(r"Q[0-9]+", node["id"]),
            "JKI id must be Q followed by a decimal number")
    require(bit(node["q"]), "q must be an integer bit")
    trigger = node["trigger"]
    require(isinstance(trigger, dict) and set(trigger) in ({"any"}, {"all"}),
            "Exactly one trigger mode: any or all")
    mode = next(iter(trigger))
    refs = trigger[mode]
    require(isinstance(refs, list)
            and all(isinstance(source, str) and source for source in refs)
            and len(set(refs)) == len(refs), "Unique trigger source array")
    require(bool(refs) or allow_unbound_entry and mode == "any",
            "Trigger sources must be connected except explicitly registered editable entries")
    sources = node.get("sources", {})
    require(isinstance(sources, dict) and set(sources) <= {"s", "ex", "seed"},
            "Only optional s/ex/seed in sources")
    source_ids, operations = sources.get("s", []), sources.get("ex", [])
    require(isinstance(source_ids, list)
            and all(isinstance(source, str) and source for source in source_ids), "Source ID array")
    require(isinstance(operations, list) and all(op in ("J", "K") for op in operations),
            "J/K operation array")
    if operations:
        require(len(source_ids) == len(operations), "Nonempty EX source array alignment")
    if "seed" in sources:
        require(bit(sources["seed"]), "seed must be an integer bit when present")
    publication = node.get("publish", {})
    require(isinstance(publication, dict), "Publish object")
    publication = publication or {"always": [0, 1]}
    require(len(publication) == 1, "Single publish mode")
    pub_mode = next(iter(publication))
    values = publication[pub_mode]
    require(pub_mode in PUBLICATION and isinstance(values, list)
            and all(bit(value) for value in values)
            and values == PUBLICATION[pub_mode][0], "Exact publish result set")
    pro = node.get("pro", {})
    require(isinstance(pro, dict) and set(pro) <= {"jksid", "tag"},
            "Only approved JKI.pro fields")
    if "jksid" in pro:
        require(isinstance(pro["jksid"], str) and pro["jksid"], "jksid")
    if "tag" in pro:
        require(isinstance(pro["tag"], list) and all(isinstance(tag, str) for tag in pro["tag"]),
                "Purpose tags must be a string array")
    runtime = node.get("runtime", {})
    require(isinstance(runtime, dict), "Runtime container")
    if mode == "any":
        require(runtime == {}, "ANY has no trigger_all record")
    else:
        require(set(runtime) == {"trigger_all"}, "ALL arrival record")
        arrivals = runtime["trigger_all"]
        require(isinstance(arrivals, list) and len(arrivals) == len(refs)
                and all(value is None or bit(value) for value in arrivals),
                "ALL arrival record alignment and null/0/1 markers")


def check_jks(node, *, path=None):
    require(isinstance(node, dict), "JKS must be an object")
    require(set(node) == JKS_FIELDS, "JKS must have exactly six fields")
    require(isinstance(node["id"], str) and node["id"], "JKS id")
    path = node["id"] if path is None else path
    members = node["members"]
    require(isinstance(members, list) and bool(members)
            and all(isinstance(member, dict) for member in members),
            "JKS members must be nonempty complete JKI/JKS object arrays")
    identities = [member.get("id") for member in members]
    require(all(isinstance(identity, str) and identity for identity in identities)
            and len(set(identities)) == len(identities), "Unique member IDs in each JKS scope")
    trigger = node["trigger"]
    # JKS registrations follow the actual internal structure and are not a fixed list.
    # Checking their format does not replace verification of that structure.
    require(isinstance(trigger, dict)
            and all(isinstance(name, str) and name for name in trigger),
            "JKS registration names")
    registered_paths = []
    for registrations in trigger.values():
        require(references(registrations), "Used JKS registration needs prerequisite IDs")
        registered_paths.extend(reference_path(reference, path) for reference in registrations)
    require(len(set(registered_paths)) == len(registered_paths),
            "Each actual source may appear only once across the entire JKS trigger registration")
    require(isinstance(node["queue"], str) and node["queue"], "JKS queue name")
    require(isinstance(node["pro"], dict) and isinstance(node["runtime"], dict),
            "JKS pro/runtime containers")
    entries = set(registered_paths)
    for member in members:
        member_path = path + "." + member["id"]
        if "members" in member:
            check_jks(member, path=member_path)
        else:
            check_jki(member, allow_unbound_entry=member_path in entries)
    # This checks definitions, not JKS arrival collection, rollback or queue scheduling.


def index_structure(root):
    """Index a JKS or an explicitly supplied list of roots by complete absolute paths.

    This is a bounded structural helper, not a model-file envelope or loader.
    A dot inside an existing JKS ID does not create an implicit extra group.
    External references may remain unresolved until their roots are supplied.
    """
    roots = root if isinstance(root, list) else [root]
    require(bool(roots), "At least one explicit JKS root is needed")
    index = {"nodes": {}, "groups": {}, "scopes": {}}

    def visit(group, path):
        require(path not in index["nodes"] and path not in index["groups"],
                f"Ambiguous absolute structural path: {path}")
        index["groups"][path] = group
        for member in group["members"]:
            member_path = path + "." + member["id"]
            require(member_path not in index["nodes"] and member_path not in index["groups"],
                    f"Ambiguous absolute member path: {member_path}")
            if "members" in member:
                visit(member, member_path)
            else:
                index["nodes"][member_path] = member
                index["scopes"][member_path] = path

    for group in roots:
        check_jks(group)
        visit(group, group["id"])
    return index


def reference_path(reference, scope):
    """Normalize only a same-scope Q ID; an absolute path is already complete."""
    require(isinstance(reference, str) and reference, "JKI reference must be a string")
    return scope + "." + reference if re.fullmatch(r"Q[0-9]+", reference) else reference


def resolve_jki(reference, scope, index):
    """Resolve a local Q ID in its own scope or an exact absolute JKI path."""
    require(scope in index["groups"], f"Unknown referencing scope: {scope}")
    path = reference_path(reference, scope)
    require(path in index["nodes"], f"Unresolved JKI reference from {scope}: {reference}")
    return path


def check_resolved_connections(index):
    """Check connections only when the caller supplies a closed structural fixture."""
    checks = 0
    for path, node in index["nodes"].items():
        scope = index["scopes"][path]
        refs = next(iter(node["trigger"].values()))
        resolved = [resolve_jki(ref, scope, index) for ref in refs]
        require(len(set(resolved)) == len(resolved), "Trigger aliases cannot repeat the same source")
        for ref in node.get("sources", {}).get("s", []):
            resolve_jki(ref, scope, index)
            checks += 1
        checks += len(refs)
    for path, group in index["groups"].items():
        registered = []
        for refs in group["trigger"].values():
            registered.extend(resolve_jki(ref, path, index) for ref in refs)
            checks += len(refs)
        require(len(set(registered)) == len(registered),
                "JKS source uniqueness spans all registration types, including path aliases")
    return checks


def objects(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from objects(child)
    elif isinstance(value, list):
        for child in value:
            yield from objects(child)


def check_examples():
    text = (ROOT / "JKRD7.md").read_text(encoding="utf-8")
    blocks = [parse(raw) for raw in re.findall(r"```json\s*\n(.*?)\n```", text, re.S)]
    nodes, groups = [], []
    for block in blocks:
        block_nodes = [obj for obj in objects(block)
                       if {"id", "trigger"} <= set(obj) and "members" not in obj]
        block_groups = [obj for obj in objects(block) if {"id", "members", "trigger"} <= set(obj)]
        # Validate at each example root so nested local IDs are never flattened.
        def visit(value):
            if isinstance(value, dict):
                if {"id", "members", "trigger"} <= set(value):
                    index_structure(value)
                elif {"id", "trigger"} <= set(value):
                    check_jki(value)
                else:
                    for child in value.values():
                        visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(block)
        nodes.extend(block_nodes)
        groups.extend(block_groups)
    require(nodes, "No JKI examples found")
    require(any("all" in node["trigger"] for node in nodes), "ALL example coverage")
    require(any("any" in node["trigger"] for node in nodes), "ANY example coverage")
    require(any("seed" in node.get("sources", {}) for node in nodes)
            and any("seed" not in node.get("sources", {}) for node in nodes), "Both start modes covered")
    require(groups, "No JKS examples found")
    return len(blocks), nodes, groups


def check_unbound_entry_context():
    node = {"id": "Q2", "q": 1, "trigger": {"any": []}, "pro": {"tag": ["pre", "1"]}}
    group = {"id": "G_INPUT", "members": [node], "trigger": {"any": ["Q2"]},
             "queue": "work", "pro": {}, "runtime": {}}
    positive = 0
    for purpose in ("any", "all", "transaction", "ack", "pre", "post", "comp", "frame", "test_purpose"):
        for reference in ("Q2", "G_INPUT.Q2"):
            check_jks({**group, "trigger": {purpose: [reference]}})
            positive += 1
    nested = {"id": "G_PARENT", "members": [
        {**group, "trigger": {"pre": ["G_PARENT.G_INPUT.Q2"]}}
    ], "trigger": {}, "queue": "work", "pro": {}, "runtime": {}}
    index_structure(nested)
    positive += 1
    cases = [
        (check_jki, node),  # A purpose tag alone grants no entry exception.
        (check_jks, {**group, "trigger": {"any": ["Q3"]}}),
        (check_jks, {**group, "trigger": {}}),
        (check_jks, {**group, "members": ["Q2"]}),
        (check_jks, {**group, "members": [{**node, "trigger": {"all": []},
                                          "runtime": {"trigger_all": []}}]}),
        (check_jks, {**group, "members": [{key: value for key, value in node.items()
                                          if key != "trigger"}]}),
    ]
    for checker, candidate in cases:
        try:
            checker(candidate)
        except ValueError:
            continue
        raise ValueError("An unregistered or invalid empty-trigger entry was accepted")
    return positive + len(cases)


def check_document_nested_connections():
    """Resolve the explicitly closed section 5.3 example, not external fragments."""
    text = (ROOT / "JKRD7.md").read_text(encoding="utf-8")
    section = text.split("### 5.3 完整 JSON 示例", 1)[1].split("## 6.", 1)[0]
    root = parse(re.search(r"```json\s*\n(.*?)\n```", section, re.S).group(1))
    index = index_structure(root)
    require(set(index["nodes"]) == {"G1.Q1", "G1.G2.Q1", "G1.Q2"}
            and set(index["groups"]) == {"G1", "G1.G2"},
            "Section 5.3 contains the declared complete nested structure")
    return {"JKS_count": len(index["groups"]), "JKI_count": len(index["nodes"]),
            "resolved_connection_references": check_resolved_connections(index)}


def result_from(q_before, seed, operations, values):
    # A finite arithmetic reference, never used to run a model or resolve inputs.
    require(operations and len(operations) == len(values), "Arithmetic requires a nonempty complete EX")
    accumulator = q_before if seed is None else seed
    for operation, value in zip(operations, values):
        accumulator = accumulator & value if operation == "J" else accumulator ^ value
    return accumulator


def publishes(mode, q_before, result):
    base = mode.removesuffix("_changed")
    accepted = base == "always" or base == "zero" and result == 0 or base == "one" and result == 1
    return accepted and (not mode.endswith("_changed") or result != q_before)


def check_example_calculations():
    # Section 9.4 explicitly fixes all three source q values to 1 at each entry.
    # Read its standalone section 9.2 definitions, never flatten IDs across scopes.
    text = (ROOT / "JKRD7.md").read_text(encoding="utf-8")
    section = text.split("### 9.2 JKI", 1)[1].split("### 9.3", 1)[0]
    nodes = parse(re.search(r"```json\s*\n(.*?)\n```", section, re.S).group(1))
    source_q = {"Q2": 1, "Q3": 1, "Q4": 1}
    indexed = {node["id"]: node for node in nodes}
    require({"Q5", "Q6"} <= set(indexed), "Section 9.4 example identities")
    checks = 0
    for identity, expected_results, expected_changed in (
        ("Q5", [1, 0], [True, True]),
        ("Q6", [1, 1], [True, False]),
    ):
        node = indexed[identity]
        q = node["q"]
        sources = node["sources"]
        for expected, changed in zip(expected_results, expected_changed):
            result = result_from(q, sources.get("seed"), sources["ex"],
                                 [source_q[source] for source in sources["s"]])
            require(result == expected and publishes("always_changed", q, result) == changed,
                    f"Section 9.4 actual {identity} definition and changed baseline")
            q = result
            checks += 1
    return checks


def check_calculation():
    # Expected arithmetic comes from literal JK truth tables, independent of result_from.
    gates = {"J": ((0, 0), (0, 1)), "K": ((0, 1), (1, 0))}
    checks = 0
    for operation, table in gates.items():
        for before, value in itertools.product((0, 1), repeat=2):
            require(result_from(before, None, [operation], [value]) == table[before][value],
                    "J/K truth table")
            checks += 1
    # Distinguish previous result from seed, and preserve every operation on repeated sources.
    for before, seed, operations, values, expected in (
        (0, None, ["J", "K"], [1, 1], 1),
        (1, None, ["J", "K"], [1, 1], 0),
        (1, 0, ["J", "K"], [1, 1], 1),
        (0, 1, ["K", "K"], [1, 1], 1),
    ):
        require(result_from(before, seed, operations, values) == expected, "Complete EX arithmetic")
        checks += 1
    publication_checks = 0
    for mode, (_, expected_pairs) in PUBLICATION.items():
        for before, seed, desired_result in itertools.product((0, 1), (None, 0, 1), (0, 1)):
            start = before if seed is None else seed
            operand = start ^ desired_result
            result = result_from(before, seed, ["K"], [operand])
            require(publishes(mode, before, result) == ((before, desired_result) in expected_pairs),
                    "Publication compares q_before, independently of seed")
            publication_checks += 1
    return checks, publication_checks


def arrival(mode, records, position):
    # Returns trigger satisfaction, not necessarily task admission: empty EX admits no task.
    if mode == "any":
        return records, True
    updated = records.copy()
    updated[position] = 0 if updated[position] is None else 1
    if all(value is not None for value in updated):
        return [None] * len(updated), True
    return updated, False


def trigger_action(node, records, position):
    # Finite decision only. It reads neither computation sources nor seed for empty EX.
    mode = next(iter(node["trigger"]))
    records, satisfied = arrival(mode, records, position)
    has_ex = bool(node.get("sources", {}).get("ex", []))
    publication = node.get("publish", {}) or {"always": [0, 1]}
    notify = satisfied and not has_ex and publishes(next(iter(publication)), node["q"], node["q"])
    return records, satisfied and has_ex, notify


def check_arrivals():
    # Literal traces of trigger satisfaction and round consumption, independent of EX presence.
    cases = [
        ("all", [None, None], [0, 0, 0, 1, 1],
         [([0, None], False), ([1, None], False), ([1, None], False),
          ([None, None], True), ([None, 0], False)]),
        ("all", [None, None], [0, 1, 0, 1],
         [([0, None], False), ([None, None], True),
          ([0, None], False), ([None, None], True)]),
        ("all", [None], [0, 0], [([None], True), ([None], True)]),
        ("any", [], [0, 0, 1], [([], True), ([], True), ([], True)]),
    ]
    count = 0
    for mode, records, sequence, expected in cases:
        for position, (expected_records, expected_satisfied) in zip(sequence, expected):
            records, satisfied = arrival(mode, records, position)
            require(records == expected_records and satisfied == expected_satisfied, "Arrival trace")
            count += 1
    return count


def check_empty_ex():
    # Literal acceptance sets: q is unchanged, so no changed mode can publish.
    allowed = {0: {"always", "zero"}, 1: {"always", "one"}}
    source_forms = [None, {}, {"seed": 0}, {"seed": 1},
                    {"s": [], "ex": []}, {"s": ["UNREAD"], "seed": 1}]
    publication_forms = [("always", None), ("always", {})]
    publication_forms += [(mode, {mode: values}) for mode, (values, _) in PUBLICATION.items()]
    checks = 0
    for q, sources, (mode, publication) in itertools.product((0, 1), source_forms, publication_forms):
        node = {"id": "Q100", "q": q, "trigger": {"any": ["A"]}}
        if sources is not None:
            node["sources"] = sources
        if publication is not None:
            node["publish"] = publication
        check_jki(node)
        snapshot = copy.deepcopy(node)
        records, task, notify = trigger_action(node, [], 0)
        require(records == [] and not task and notify == (mode in allowed[q]),
                "Empty EX uses current q publication and never creates a task")
        require(node == snapshot, "Empty EX does not apply seed or mutate q/definition")
        checks += 1
    # Two identical ANY arrivals still produce two default notifications without tasks.
    node = {"id": "Q100", "q": 0, "trigger": {"any": ["A"]}}
    for _ in range(2):
        require(trigger_action(node, [], 0) == ([], False, True), "Default repeated empty-EX notification")
        checks += 1
    # ALL consumes and clears its satisfied round even when publication is never.
    for publication in (None, {"never": []}):
        node = {"id": "Q100", "q": 0, "trigger": {"all": ["A", "B"]},
                "runtime": {"trigger_all": [None, None]}}
        if publication is not None:
            node["publish"] = publication
        check_jki(node)
        records = [None, None]
        expected = [([0, None], False), ([1, None], False),
                    ([None, None], publication is None), ([None, 0], False)]
        for position, (expected_records, expected_notify) in zip((0, 0, 1, 1), expected):
            records, task, notify = trigger_action(node, records, position)
            require(records == expected_records and not task and notify == expected_notify,
                    "Empty-EX ALL saturation, consumption and publication")
            require(node["q"] == 0, "Empty-EX ALL preserves q")
            checks += 1
    return checks


def check_rejections():
    baseline = {"id": "Q0", "q": 0, "trigger": {"any": ["A"]},
                "sources": {"s": ["A"], "ex": ["K"]},
                "publish": {"always": [0, 1]}, "pro": {}, "runtime": {}}
    mutations = [
        lambda n: n.update(state={"q": 0}),
        lambda n: n.update(q=True),
        lambda n: n["sources"].update(seed=True),
        lambda n: n["sources"].update(seed=None),
        lambda n: n["sources"].update(v=[0]),
        lambda n: n["sources"].update(ex=["K", "J"]),
        lambda n: n.update(sources=None),
        lambda n: n.update(publish=None),
        lambda n: n.update(pro=None),
        lambda n: n.update(runtime=None),
        lambda n: n["trigger"].update(v=[0]),
        lambda n: n["trigger"].update(any=[]),
        lambda n: n["trigger"].update(any=["A", "A"]),
        lambda n: n["trigger"].update(all=["A"]),
        lambda n: n.update(trigger={"transaction": ["A"]}),
        lambda n: n.update(trigger={"test_purpose": ["A"]}),
        lambda n: n["runtime"].update(trigger_all=[None]),
        lambda n: n.update(trigger={"all": ["A"]}, runtime={}),
        lambda n: n.update(trigger={"all": ["A"]}, runtime={"trigger_all": []}),
        lambda n: n.update(trigger={"all": ["A"]}, runtime={"trigger_all": [True]}),
        lambda n: n["publish"].update(never=[]),
        lambda n: n["pro"].update(unapproved=1),
        lambda n: n["pro"].update(tag="purpose"),
        lambda n: n["pro"].update(tag=[1]),
    ]
    mutations += [lambda n, value=value: n.update(id=value)
                  for value in ("B1", "done", "pre", "Q_FIXED", "Q")]
    check_jki(baseline)
    positive = copy.deepcopy(baseline)
    positive["sources"] = {"s": ["A", "A"], "ex": ["J", "K"], "seed": 1}
    check_jki(positive)
    for tags in ([], ["purpose"], ["purpose", "purpose"]):
        tagged = {"id": "Q101", "q": 0, "trigger": {"any": ["A"]}, "pro": {"tag": tags}}
        check_jki(tagged)
    for mutate in mutations:
        node = copy.deepcopy(baseline)
        mutate(node)
        try:
            check_jki(node)
        except ValueError:
            continue
        raise ValueError("Invalid counterexample was accepted")
    for raw in ('{"q":0,"q":1}', '{"q":NaN}'):
        try:
            parse(raw)
        except ValueError:
            continue
        raise ValueError("Invalid JSON was accepted")
    return len(mutations) + 2


def check_jks_rejections():
    child = {"id": "G1", "members": [{"id": "Q1", "q": 0, "trigger": {"any": ["G.Q1"]}}],
             "trigger": {}, "queue": "work", "pro": {}, "runtime": {}}
    baseline = {"id": "G", "members": [child, {"id": "Q1", "q": 1, "trigger": {"any": ["G_INPUT.Q1"]}}],
                "trigger": {"transaction": ["Q0"]},
                "queue": "work", "pro": {}, "runtime": {}}
    check_jks(baseline)
    positive = copy.deepcopy(baseline)
    positive["trigger"] = {key: [f"Q{number}"] for number, key in enumerate(
                           ("any", "all", "transaction", "ack", "pre", "post", "comp", "frame"), 10)}
    check_jks(positive)
    mutations = [
        lambda n: n.update(extra=1),
        lambda n: n.update(members=[]),
        lambda n: n.update(members=[{"id": "Q1"}]),
        lambda n: n.update(members=[1]),
        lambda n: n.update(members=["Q1"]),
        lambda n: n["members"].append(copy.deepcopy(n["members"][1])),
        lambda n: n["members"][0]["members"].append({"id": "Q1", "q": 1, "trigger": {"any": ["G.Q1"]}}),
        lambda n: n["trigger"].update(transaction=[]),
        lambda n: n["trigger"].update(transaction="Q0"),
        lambda n: n["trigger"].update(transaction=["Q0", "Q0"]),
        lambda n: n["trigger"].update(all=["Q0"]),
        lambda n: n["trigger"].update(pre=["G.Q0"]),
        lambda n: n["trigger"].update(ack=[True]),
        lambda n: n.update(queue=[]),
        lambda n: n.update(pro=[]),
        lambda n: n.update(runtime=[]),
    ]
    for mutate in mutations:
        node = copy.deepcopy(baseline)
        mutate(node)
        try:
            check_jks(node)
        except ValueError:
            continue
        raise ValueError("Invalid JKS counterexample was accepted")
    return len(mutations)


def check_jks_registration_formats():
    """Check ALL/transaction/extension shapes and endpoints, never their runtime behavior."""
    root = {"id": "G", "members": [
        {"id": "Q1", "q": 1, "trigger": {"any": ["Q2"]}},
        {"id": "Q2", "q": 1, "trigger": {"any": []}},
        {"id": "G_CHILD", "members": [
            {"id": "Q1", "q": 0, "trigger": {"any": ["G.Q1"]}}
        ], "trigger": {}, "queue": "work", "pro": {}, "runtime": {}}
    ], "trigger": {"any": ["Q2"]}, "queue": "work", "pro": {}, "runtime": {}}
    positive = 0
    for name in ("all", "transaction", "test_purpose"):
        candidate = copy.deepcopy(root)
        candidate["trigger"][name] = ["Q1", "G.G_CHILD.Q1"]
        require(check_resolved_connections(index_structure(candidate)) == 5,
                "A JKS registration resolves every local/absolute prerequisite to an actual JKI")
        positive += 1
    # The uniqueness scope is one JKS.trigger, not all unrelated structures.
    candidate = copy.deepcopy(root)
    candidate["trigger"]["pre"] = ["G.G_CHILD.Q1"]
    candidate["members"][2]["trigger"] = {"pre": ["Q1"]}
    require(check_resolved_connections(index_structure(candidate)) == 5,
            "Separate JKS registrations may refer to the same actual source")
    positive += 1
    # test_purpose exists only in this format fixture; it defines no new control type.
    rejected = 0
    for refs in ([], "Q1", [True], ["Q1", "Q1"], ["Q1", "G.Q1"],
                 ["G_CHILD.Q1"], ["G.G_CHILD"], ["G.G_CHILD.Q9"]):
        candidate = copy.deepcopy(root)
        candidate["trigger"]["all"] = refs
        try:
            check_resolved_connections(index_structure(candidate))
        except ValueError:
            rejected += 1
        else:
            raise ValueError("Invalid JKS ALL registration was accepted")
    cross_type_rejected = 0
    for first, second in (("Q1", "Q1"), ("Q1", "G.Q1"),
                          ("G.G_CHILD.Q1", "G.G_CHILD.Q1"), ("Q2", "G.Q2")):
        candidate = copy.deepcopy(root)
        candidate["trigger"]["all"] = [first]
        candidate["trigger"]["transaction"] = [second]
        try:
            check_resolved_connections(index_structure(candidate))
        except ValueError:
            cross_type_rejected += 1
        else:
            raise ValueError("The same actual source was accepted in multiple JKS registration types")
    return {"positive_format_cases": positive, "rejected_ALL_cases": rejected,
            "rejected_cross_type_source_duplicates": cross_type_rejected,
            "execution_semantics_checked": False}


def check_absolute_paths():
    def group(identity, members, trigger=None):
        return {"id": identity, "members": members, "trigger": trigger or {},
                "queue": "work", "pro": {}, "runtime": {}}

    entry = {"id": "Q1", "q": 1, "trigger": {"any": []}}
    child = group("G2", [{"id": "Q1", "q": 0,
                          "trigger": {"any": ["G1.Q1"]},
                          "sources": {"seed": 0, "s": ["G1.Q1"], "ex": ["K"]}}])
    leaf = {"id": "Q2", "q": 0, "trigger": {"any": ["G1.G2.Q1"]},
            "sources": {"s": ["G1.G2.Q1", "G1.G2.Q1"], "ex": ["K", "K"]}}
    root = group("G1", [entry, child, leaf], {"any": ["Q1"]})
    index = index_structure(root)
    require(set(index["nodes"]) == {"G1.Q1", "G1.G2.Q1", "G1.Q2"},
            "Nested local Q1 identities remain separate")
    require(index["scopes"] == {"G1.Q1": "G1", "G1.G2.Q1": "G1.G2", "G1.Q2": "G1"},
            "Every node retains its containing JKS scope")
    positive = 2
    for reference, scope, expected in (
        ("Q1", "G1", "G1.Q1"), ("Q1", "G1.G2", "G1.G2.Q1"),
        ("G1.Q1", "G1.G2", "G1.Q1"), ("G1.G2.Q1", "G1", "G1.G2.Q1"),
    ):
        require(resolve_jki(reference, scope, index) == expected, "Exact local/absolute reference resolution")
        positive += 1
    connection_checks = check_resolved_connections(index)

    dotted = index_structure(group("ASCII.bit.DIGITS", [entry], {"any": ["Q1"]}))
    require(set(dotted["groups"]) == {"ASCII.bit.DIGITS"}
            and resolve_jki("Q1", "ASCII.bit.DIGITS", dotted) == "ASCII.bit.DIGITS.Q1",
            "Existing dots in an ID do not manufacture implicit nested JKS objects")
    positive += 1
    other = group("OTHER", [copy.deepcopy(entry)], {"any": ["Q1"]})
    multiple = index_structure([root, other])
    require(resolve_jki("OTHER.Q1", "G1", multiple) == "OTHER.Q1", "Explicit independent roots")
    positive += 1

    rejected = 0
    for reference, scope in (
        ("Q2", "G1.G2"),  # No parent fallback.
        ("G2.Q1", "G1"),  # No implicit relative descendant lookup.
        ("G1.G2", "G1"),  # JKS is not a JKI endpoint.
        ("G1.MISSING.Q1", "G1"),
        ("Q1", "G_UNKNOWN"),
        ("pre", "G1"),
    ):
        try:
            resolve_jki(reference, scope, index)
        except ValueError:
            rejected += 1
        else:
            raise ValueError("An unresolved or non-JKI path was accepted")
    alias = copy.deepcopy(root)
    alias["members"][2]["trigger"] = {"any": ["Q1", "G1.Q1"]}
    unresolved = copy.deepcopy(root)
    unresolved["members"][2]["sources"]["s"][0] = "G_UNKNOWN.Q1"
    aliases = []
    for name in ("any", "all", "transaction", "ack", "pre", "post", "comp", "frame"):
        candidate = copy.deepcopy(root)
        candidate["trigger"][name] = ["Q1", "G1.Q1"]
        aliases.append(candidate)
    for candidate in (alias, unresolved, *aliases):
        try:
            check_resolved_connections(index_structure(candidate))
        except ValueError:
            rejected += 1
        else:
            raise ValueError("Invalid closed-fixture connection was accepted")
    for roots in ([root, copy.deepcopy(root)],
                  [root, group("G1.G2", [copy.deepcopy(entry)], {"any": ["Q1"]})]):
        try:
            index_structure(roots)
        except ValueError:
            rejected += 1
        else:
            raise ValueError("An ambiguous absolute structural address was accepted")
    return {"positive_cases": positive, "resolved_connection_references": connection_checks,
            "rejected_cases": rejected}


def check_links(config):
    count = 0
    docs = [ROOT / name for name in ("README.md", "AGENTS.md", "JKRD7.md")]
    docs += sorted((ROOT / "docs").glob("*.md"))
    for doc in docs:
        for href in re.findall(r"\]\(([^\s)]+)\)", doc.read_text(encoding="utf-8")):
            target = unquote(href.split("#")[0].split("?")[0])
            if not target or re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", target):
                continue
            require((doc.parent / target).exists(), f"Broken local link in {doc.name}: {target}")
            count += 1
    for group in (config["documents"], config["assets"], config["tools"]):
        for target in group.values():
            require((ROOT / target).is_file(), f"Missing indexed file: {target}")
            count += 1
    require(config["canonical"]["rules"] == "JKRD7.md" and config["canonical"]["rules_version"] == "7.0.0", "Canonical rules")
    return count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()
    config = read(ROOT / "jk.config.json")
    blocks, nodes, groups = check_examples()
    attachment_paths = sorted(path for path in ASSETS.glob("*.json")
                              if path.name != "verification.json")
    for path in attachment_paths:
        read(path)  # Syntax only; these definitions still require redesign.
    arithmetic, publication = check_calculation()
    counts = {"document_JSON_examples": blocks, "current_JKI_examples": len(nodes),
              "document_empty_EX_examples": sum(not node.get("sources", {}).get("ex", []) for node in nodes),
              "current_JKS_examples": len(groups),
              "document_EX_cases": check_example_calculations(),
              "document_nested_connections": check_document_nested_connections(),
              "factory_JSON_syntax_only": len(attachment_paths),
              "arithmetic_reference_cases": arithmetic, "publication_reference_cases": publication,
              "arrival_reference_steps": check_arrivals(),
              "empty_EX_reference_cases": check_empty_ex(),
              "editable_entry_context_cases": check_unbound_entry_context(),
              "rejection_counterexamples": check_rejections(),
              "JKS_rejection_counterexamples": check_jks_rejections(),
              "JKS_registration_format_checks": check_jks_registration_formats(),
              "nested_absolute_path_checks": check_absolute_paths(),
              "local_file_links": check_links(config)}
    report = {"spec_version": "7.0.0", "jki_rule_revision": "2026-11-05",
              "jks_rule_revision": "2026-11-05",
              "status": "current_jki_jks_static_checks_passed",
              "factory_assets_status": "requires_redesign",
              "verified_at_utc": datetime.now(timezone.utc).isoformat(),
              "command": "python3 scripts/validate_jkrd7.py --write-report",
              "checks": counts, "executor_implemented": False,
              "coverage": ["current document JKI field/array/trigger/runtime/publication shapes",
                           "JKI Q-plus-decimal identifier spelling and unique direct-member IDs per explicit JKS scope",
                           "JKI omitted fields/default publication/purpose-tag shapes",
                           "empty JKI ANY in actual-member editable-entry contexts registered under any structure-required JKS control purpose",
                           "current document JKS six-field structure with recursively embedded complete JKI/JKS objects",
                           "structure-required JKS registration formats, actual JKI endpoints and source uniqueness across the entire JKS trigger including local/absolute aliases; JKI remains any/all only",
                           "finite scoped JKI reference resolution, exact absolute paths, independent same-named local nodes and ambiguous-path rejection",
                           "closed nested fixtures resolve JKI trigger/sources and JKS prerequisites; fragments may retain external references",
                           "actual section 5.3 complete nested example resolves all six trigger/source/registration references",
                           "finite independent JKI arithmetic, q_before publication and JKI arrival reference cases",
                           "empty EX direct current-q publication without task admission or q/seed updates; JKI ALL clear independent of publication",
                           "actual section 9.4 JKI example arithmetic and q_before comparison",
                           "document/attachment JSON syntax, rejected shape counterexamples and local file links"],
              "not_verified": ["factory JSON compatibility, factory bit encoding or factory operations under current JKI/JKS rules",
                               "JKI number allocation order, JKM envelope or production namespace management",
                               "general model loading, unresolved external fragments, self-reference legality or graph topology",
                               "actual queues, cross-FIFO scheduling, atomic enqueue/clear or failure handling",
                               "production execution of the defined JKS trigger/clear/next-round contract",
                               "JKS transaction execution, success commit or failure rollback of the current computation",
                               "JKS pro/runtime extension semantics",
                               "JKS transaction integration, dynamic installation, output delivery or persisted recovery",
                               "hardware execution or performance"],
              "source_sha256": {}}
    paths = [ROOT / name for name in ("README.md", "AGENTS.md", "JKRD7.md", "jk.config.json", ".gitignore")]
    paths += sorted((ROOT / "docs").glob("*.md"))
    paths += [Path(__file__).resolve()] + sorted(ASSETS.glob("*.json"))
    report_path = ASSETS / "verification.json"
    # Hashing an attachment records its identity, not conformance to current JKI rules.
    for path in sorted(paths):
        if path.is_file() and path != report_path:
            report["source_sha256"][str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    if args.write_report:
        report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": report["status"], "factory_assets_status": report["factory_assets_status"],
                      "checks": counts, "report_written": args.write_report,
                      "executor_implemented": False}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        raise SystemExit(f"JKRD7 check failed: {error}")
