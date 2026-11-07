#!/usr/bin/env python3
"""Bounded, explicitly scheduled reference traces for the proposed ASCII digit graph."""
import argparse
from collections import Counter, deque
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import itertools
import json
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parents[1]
MODEL = ROOT / "assets/ascii-bit-design/digits.paired-state.proposal.json"
REPORT = ROOT / "assets/ascii-bit-design/digits.paired-state.verification.json"
VALIDATOR = Path(__file__).resolve().with_name("validate_jkrd7.py")
RULE_CHECKS = runpy.run_path(str(VALIDATOR))
COMPONENT_ID = "ASCII.bit.DIGITS"
INPUT_IDS = [f"Q{i}" for i in range(1, 11)]
OUTPUT_IDS = {"B7": "Q11", "B6": "Q12", "B5": "Q13", "B4": "Q14",
              "B3": "Q25", "B2": "Q26", "B1": "Q27", "B0": "Q28"}
EXPECTED_NODES = {f"Q{i}" for i in range(1, 29)}


def component_path(identity):
    return COMPONENT_ID + "." + identity


INPUTS = [component_path(identity) for identity in INPUT_IDS]
OUTPUTS = {label: component_path(identity) for label, identity in OUTPUT_IDS.items()}
REQUEST = component_path("Q23")
COMPLETION = component_path("Q24")
REQUIRED = {REQUEST, *OUTPUTS.values()}
CORE_EMPTY_EX_NODES = {component_path(identity) for identity in ("Q11", "Q12", "Q13", "Q14", "Q23", "Q24")}
EMPTY_EX_NODES = CORE_EMPTY_EX_NODES | set(INPUTS)
# Fixture sources are actual JKI definitions in a separate root. Only their notifications
# are injected: this does not claim to implement the external upstream application.
TEST_BINDINGS = {identity: [f"UPSTREAM.Q{index + 1}"] for index, identity in enumerate(INPUTS)}
UPSTREAM_IDS = [f"Q{i}" for i in range(1, 12)]
UPSTREAM = {"id": "UPSTREAM",
            "members": [{"id": identity, "q": 1, "trigger": {"any": []}} for identity in UPSTREAM_IDS],
            "trigger": {"any": UPSTREAM_IDS}, "queue": "work", "pro": {}, "runtime": {}}
FIXTURE_SOURCES = {f"UPSTREAM.{identity}" for identity in UPSTREAM_IDS}
POLICIES = ("event-first", "task-first")
DEMO = [0, 1, 0, 0, 1, 4, 7, 7, 8, 9, 9, 0]
SWEEP = [*range(10), *range(8, -1, -1)]


def require(condition, message):
    if not condition:
        raise ValueError(message)


def expected_bits(digit):
    # Independent ASCII encoding; never computed from the graph or trigger subsets.
    return [int(value) for value in format(ord(str(digit)), "08b")]


def read_model():
    group = RULE_CHECKS["parse"](MODEL.read_text(encoding="utf-8"))
    require(isinstance(group, dict) and group.get("id") == COMPONENT_ID,
            "Proposal is one complete recursive JKS object")
    RULE_CHECKS["check_jks"](group)
    index = RULE_CHECKS["index_structure"](group)
    require(len(index["groups"]) == 1 and len(index["nodes"]) == 28,
            "Expected one ordinary JKS containing twenty-eight full JKI definitions")
    nodes = group["members"]
    require({node["id"] for node in nodes} == EXPECTED_NODES, "Expected actual node identities")
    require(group["trigger"] == {"any": INPUT_IDS}, "Ten editable JKS entry registrations")
    for identity, node in index["nodes"].items():
        mode, refs = next(iter(node["trigger"].items()))
        for ref in [*refs, *node.get("sources", {}).get("s", [])]:
            RULE_CHECKS["resolve_jki"](ref, index["scopes"][identity], index)
        sources = node.get("sources", {})
        empty_ex = not sources.get("ex", [])
        require(empty_ex == (identity in EMPTY_EX_NODES), "Optimized empty-EX node inventory")
        require((node.get("publish") or {"always": [0, 1]}) == {"always": [0, 1]},
                "Proposal uses default/explicit always publication")
        expected_runtime = {} if mode == "any" else {"trigger_all": [None] * len(refs)}
        require(node.get("runtime", {}) == expected_runtime, "Initial arrival records")
    for digit, identity in enumerate(INPUTS):
        node = index["nodes"][identity]
        require(node["q"] == 1 and node["trigger"] == {"any": []},
                "Editable template entries retain an unbound ANY and initial q=1")
        require(node.get("pro", {}).get("tag") == ["pre", str(digit)],
                "Entry purpose tags describe their digit without controlling execution")
    for identity, expected_q in {"Q11": 0, "Q12": 0, "Q13": 1, "Q14": 1, "Q23": 1, "Q24": 1}.items():
        require(index["nodes"][component_path(identity)]["q"] == expected_q, "Fixed empty-EX initial q")
    for label, identity in {**OUTPUTS, "pre": REQUEST, "done": COMPLETION}.items():
        require(label in index["nodes"][identity].get("pro", {}).get("tag", []),
                "Expected purpose tag on the actual Q identity")
    completion = index["nodes"][COMPLETION]
    refs = {RULE_CHECKS["resolve_jki"](ref, COMPONENT_ID, index)
            for ref in completion["trigger"].get("all", [])}
    require(set(completion["trigger"]) == {"all"} and refs == REQUIRED, "Nine completion prerequisites")
    return group


def bind_entries(template, bindings=None):
    """Register fixture absolute upstream paths on a copy, before building indexes."""
    bindings = TEST_BINDINGS if bindings is None else bindings
    require(set(bindings) == set(INPUTS), "Fixture binding covers exactly the ten real entries")
    group = deepcopy(template)
    index = RULE_CHECKS["index_structure"](group)
    for identity, refs in bindings.items():
        index["nodes"][identity]["trigger"] = {"any": list(refs)}
    RULE_CHECKS["check_jks"](group)
    return group


class ReferenceTrace:
    """Finite ordinary-JKS trace evaluator; both FIFOs hold absolute JKI paths.

    JKI any/all are supported. JKS all, transactions and other control purposes
    require separate behavior and must not silently run as ordinary node graphs.
    """

    def __init__(self, roots, policy, fixture_sources=()):
        require(policy in POLICIES, "Explicit reference scheduling policy")
        self.index = RULE_CHECKS["index_structure"](roots)
        for path, group in self.index["groups"].items():
            unsupported = set(group["trigger"]) - {"any"}
            require(not unsupported,
                    f"Unsupported JKS trigger registrations in this reference evaluator at {path}: "
                    f"{sorted(unsupported)}; only empty or any registration is implemented")
        RULE_CHECKS["check_resolved_connections"](self.index)
        self.nodes = self.index["nodes"]
        self.q = {path: node["q"] for path, node in self.nodes.items()}
        self.arrivals = {path: deepcopy(node["runtime"]["trigger_all"])
                         for path, node in self.nodes.items() if "all" in node["trigger"]}
        self.fixture_sources = set(fixture_sources)
        require(self.fixture_sources <= set(self.nodes), "Fixture sources must be actual indexed JKI")
        self.trigger_refs, self.source_refs, self.subscribers = {}, {}, {}
        for path, node in self.nodes.items():  # Declaration order is an explicit reference assumption.
            scope = self.index["scopes"][path]
            resolve = lambda ref: RULE_CHECKS["resolve_jki"](ref, scope, self.index)
            refs = [resolve(ref) for ref in next(iter(node["trigger"].values()))]
            require(len(set(refs)) == len(refs), "Resolved trigger sources must remain unique")
            self.trigger_refs[path] = refs
            self.source_refs[path] = [resolve(ref) for ref in node.get("sources", {}).get("s", [])]
            for source in refs:
                self.subscribers.setdefault(source, []).append(path)
        self.events = deque()  # Absolute source JKI paths; no result or batch label.
        self.tasks = deque()   # Absolute target JKI paths; no captured source values.
        self.policy = policy
        self.trace = []        # External instrumentation, never read by the evaluator.
        self.steps = 0

    def record(self, kind, **fields):
        self.trace.append({"seq": len(self.trace), "step": self.steps, "kind": kind, **fields})

    def queue_event(self, identity):
        require(isinstance(identity, str) and identity in self.nodes,
                "Event admission requires an indexed absolute source JKI path")
        self.events.append(identity)

    def queue_task(self, identity):
        require(isinstance(identity, str) and identity in self.nodes,
                "Task admission requires an indexed absolute target JKI path")
        self.tasks.append(identity)

    def publish(self, identity, before, result, response_kind):
        publication = self.nodes[identity].get("publish") or {"always": [0, 1]}
        mode, accepted = next(iter(publication.items()))
        allowed = result in accepted and (not mode.endswith("_changed") or result != before)
        if allowed:
            self.queue_event(identity)
            self.record("notification_appended", source=identity, response_kind=response_kind)
        return allowed

    def activate(self, identity):
        node = self.nodes[identity]
        if node.get("sources", {}).get("ex", []):
            self.queue_task(identity)
            self.record("task_admitted", node=identity)
            return
        # Empty EX has no task, source read, seed application, accumulator or q write.
        value = self.q[identity]
        published = self.publish(identity, value, value, "direct")
        fields = {"node": identity, "q": value, "published": published}
        if identity == COMPLETION:
            fields["output_readout"] = "".join(str(self.q[node_id]) for node_id in OUTPUTS.values())
        self.record("direct_completed", **fields)

    def inject(self, digit):
        require(type(digit) is int and 0 <= digit <= 9, "Decimal input")
        self.inject_upstream(TEST_BINDINGS[INPUTS[digit]][0])

    def inject_upstream(self, source):
        require(source in self.fixture_sources,
                "Inject only a declared fixture upstream absolute path, never an internal entry")
        self.queue_event(source)
        self.record("fixture_upstream_notification", source=source)

    def deliver(self):
        source = self.events.popleft()
        require(isinstance(source, str) and source in self.nodes,
                "Event queue contains only indexed absolute JKI paths")
        self.record("notification_dequeued", source=source)
        for target in self.subscribers.get(source, []):
            node = self.nodes[target]
            refs = self.trigger_refs[target]
            if "all" in node["trigger"]:
                records = self.arrivals[target]
                position = refs.index(source)
                records[position] = 0 if records[position] is None else 1
                satisfied = all(value is not None for value in records)
                self.record("all_arrival", source=source, target=target,
                            records=records.copy(), satisfied=satisfied)
                if satisfied:
                    records[:] = [None] * len(records)
                    self.activate(target)
            else:
                self.record("any_arrival", source=source, target=target, satisfied=True)
                self.activate(target)

    def execute(self):
        identity = self.tasks.popleft()
        require(isinstance(identity, str) and identity in self.nodes,
                "Task queue contains only indexed absolute JKI paths")
        node = self.nodes[identity]
        sources = node["sources"]
        require(sources.get("ex"), "Empty EX must never enter the task FIFO")
        before = self.q[identity]
        refs = self.source_refs[identity]
        entry = {source: self.q[source] for source in refs}
        accumulator = sources.get("seed", before)
        for source, operation in zip(refs, sources["ex"]):
            value = entry[source]
            accumulator = accumulator & value if operation == "J" else accumulator ^ value
        published = self.publish(identity, before, accumulator, "task")
        self.q[identity] = accumulator
        self.record("task_completed", node=identity, q_before=before,
                    entry_q=entry, result=accumulator, published=published)

    def drain(self, limit=10000):
        begin = self.steps
        while self.events or self.tasks:
            require(self.steps - begin < limit, "Reference trace exceeded finite drain bound")
            self.steps += 1
            use_event = bool(self.events) and (self.policy == "event-first" or not self.tasks)
            if use_event:
                self.deliver()
            else:
                self.execute()
        return self.trace


def observe(trace):
    results = {label: [] for label in OUTPUTS}
    outputs_by_id = {identity: label for label, identity in OUTPUTS.items()}
    completions = []
    seen = set()
    ready_positions = deque()
    ready_count = 0
    notification_counts = Counter()
    task_admissions = Counter()
    task_completions = Counter()
    direct_responses = Counter()
    for item in trace:
        if item["kind"] == "notification_appended":
            if item["source"] == COMPLETION:
                require(ready_positions and ready_positions[0] < item["seq"],
                        "Q24 notification preceded its nine-source satisfaction")
            notification_counts[item["source"]] += 1
        elif item["kind"] == "task_admitted":
            require(item["node"] not in EMPTY_EX_NODES, "Empty EX admitted to task FIFO")
            task_admissions[item["node"]] += 1
        elif item["kind"] == "all_arrival" and item["target"] == COMPLETION:
            # Independent set-based oracle for nine prerequisites, separate from array transitions.
            seen.add(item["source"])
            expected_ready = seen == REQUIRED
            require(item["satisfied"] == expected_ready, "Q24 responded without all nine arrivals")
            if expected_ready:
                ready_positions.append(item["seq"])
                ready_count += 1
                seen.clear()
        elif item["kind"] in ("task_completed", "direct_completed"):
            identity = item["node"]
            if item["kind"] == "task_completed":
                require(identity not in EMPTY_EX_NODES, "Empty EX executed as a task")
                task_completions[identity] += 1
                value = item["result"]
            else:
                require(identity in EMPTY_EX_NODES, "Computational node bypassed its task")
                direct_responses[identity] += 1
                value = item["q"]
            if identity in outputs_by_id and item["published"]:
                results[outputs_by_id[identity]].append(value)
            if identity == COMPLETION:
                require(ready_positions and ready_positions.popleft() < item["seq"],
                        "Q24 completed before its nine source arrivals in trace order")
                completions.append({"step": item["step"], "seq": item["seq"], "q": value,
                                    "output_readout": item["output_readout"]})
    require(not ready_positions, "Satisfied Q24 round produced no direct response")
    require(task_admissions == task_completions, "Admitted task did not complete")
    return {"output_results": results, "notification_counts": dict(notification_counts),
            "internal_notifications": sum(notification_counts.values()),
            "computation_tasks": sum(task_completions.values()),
            "task_nodes": dict(task_completions), "direct_nodes": dict(direct_responses),
            "completions": completions, "nine_source_ready_rounds": ready_count,
            "unmatched_completion_sources": sorted(seen)}


def check_serial_input(engine, digit, upstream=None):
    require(not engine.events and not engine.tasks, "Serial test requires quiescence before next input")
    begin = len(engine.trace)
    if upstream is None:
        engine.inject(digit)
    else:
        engine.inject_upstream(upstream)
    engine.drain()
    observed = observe(engine.trace[begin:])
    expected = expected_bits(digit)
    for (label, identity), value in zip(OUTPUTS.items(), expected):
        require(observed["output_results"][label] == [value],
                f"{engine.policy} digit {digit}: expected one correct {label} result")
        require(observed["notification_counts"].get(identity, 0) == 1,
                f"{engine.policy} digit {digit}: expected one {label} publication")
    require(engine.q[REQUEST] == 1 and engine.q[COMPLETION] == 1, "Request/completion q must be 1")
    require(observed["notification_counts"].get(REQUEST, 0) == 1
            and observed["notification_counts"].get(COMPLETION, 0) == 1, "One request/completion publication")
    expected_tasks = Counter({component_path(f"Q{15 + 2 * index + value}"): 1
                              for index, value in enumerate(expected[4:])})
    expected_tasks.update({OUTPUTS[f"B{index}"]: 1 for index in range(4)})
    require(observed["task_nodes"] == dict(expected_tasks) and observed["computation_tasks"] == 8,
            "Exactly four selected setters and four low-bit output tasks")
    require(observed["direct_nodes"] == {identity: 1 for identity in CORE_EMPTY_EX_NODES | {INPUTS[digit]}},
            "Exactly seven direct responses, including only the selected real entry")
    require(observed["notification_counts"].get(INPUTS[digit], 0) == 1
            and all(observed["notification_counts"].get(identity, 0) == 0
                    for identity in INPUTS if identity != INPUTS[digit]),
            "One selected entry publishes and the nine unselected entries remain inactive")
    require(observed["internal_notifications"] == 15, "Fifteen internal notifications per serial input")
    require(all(engine.q[identity] == engine.nodes[identity]["q"] for identity in EMPTY_EX_NODES),
            "Empty EX preserves fixed q")
    require(len(observed["completions"]) == 1 and observed["nine_source_ready_rounds"] == 1
            and not observed["unmatched_completion_sources"], "Exactly one complete nine-source round")
    actual = observed["completions"][0]["output_readout"]
    require(actual == "".join(map(str, expected)), "ASCII readout at completion")
    require(all(value is None for value in engine.arrivals[COMPLETION]), "Completion arrivals cleared")
    return {"digit": digit, "ascii_bits": actual, "ascii_decimal": int(actual, 2),
            "output_publications_each": 1, "completion_publications": 1,
            "selected_entry": INPUTS[digit],
            "computation_tasks": 8, "direct_responses": 7, "internal_notifications": 15}


def initialized_trace(group, policy):
    engine = ReferenceTrace([group, UPSTREAM], policy, FIXTURE_SOURCES)
    engine.drain()
    require(not engine.trace and engine.steps == 0, "Initialization must not create notifications or tasks")
    require(engine.q[REQUEST] == engine.q[COMPLETION] == 1,
            "Initial request/completion q values do not imply an emitted notification")
    return engine


def check_entry_gating(template, policy):
    # A template registration identifies an editable member; it does not activate it.
    unbound = initialized_trace(template, policy)
    initial_q = unbound.q.copy()
    unbound.inject(0)
    unbound.drain()
    observed = observe(unbound.trace)
    require(observed["internal_notifications"] == 0 and observed["computation_tasks"] == 0
            and not observed["direct_nodes"], "An unregistered upstream must not activate the template")
    require(unbound.q == initial_q, "An unregistered notification must preserve every q")

    registered = bind_entries(template)
    selected = check_serial_input(initialized_trace(registered, policy), 0)

    silent_group = deepcopy(registered)
    RULE_CHECKS["index_structure"](silent_group)["nodes"][INPUTS[0]]["publish"] = {"never": []}
    silent = initialized_trace(silent_group, policy)
    silent.inject(0)
    silent.drain()
    silent_observation = observe(silent.trace)
    require(silent_observation["direct_nodes"] == {INPUTS[0]: 1}
            and silent_observation["internal_notifications"] == 0
            and silent_observation["computation_tasks"] == 0,
            "The registered entry's publish.never must silence the downstream graph")
    require(any(item["kind"] == "any_arrival" and item["source"] == "UPSTREAM.Q1"
                and item["target"] == INPUTS[0] for item in silent.trace),
            "The silent path must still pass through the actual entry trigger")

    two_sources = deepcopy(TEST_BINDINGS)
    two_sources[INPUTS[0]] = ["UPSTREAM.Q1", "UPSTREAM.Q11"]
    # Registration edit precedes construction: no claim about live index updates.
    multiple = initialized_trace(bind_entries(template, two_sources), policy)
    two_source_results = [check_serial_input(multiple, 0, upstream=source)
                          for source in two_sources[INPUTS[0]]]
    template_nodes = RULE_CHECKS["index_structure"](template)["nodes"]
    require(all(template_nodes[identity]["trigger"] == {"any": []} for identity in INPUTS),
            "Fixture registration must not mutate the component template")
    return {"policy": policy, "unbound_template_ignores_unregistered_upstream": True,
            "registered_entry_completes": selected,
            "entry_publish_never": {"direct_entry_responses": 1,
                                    "internal_notifications": 0, "computation_tasks": 0},
            "two_sources_registered_before_index_construction": {INPUTS[0]: two_sources[INPUTS[0]]},
            "two_source_results": two_source_results}


def overlap_case(component, policy, digits):
    engine = initialized_trace(component, policy)
    for digit in digits:
        engine.inject(digit)
    engine.drain()
    observed = observe(engine.trace)
    expected = {label: [expected_bits(digit)[index] for digit in digits]
                for index, label in enumerate(OUTPUTS)}
    expected_readouts = ["".join(map(str, expected_bits(digit))) for digit in digits]
    actual_readouts = [item["output_readout"] for item in observed["completions"]]
    matches_serial = observed["output_results"] == expected and actual_readouts == expected_readouts
    return {"policy": policy,
            "upstream_notifications_before_drain": [TEST_BINDINGS[INPUTS[digit]][0] for digit in digits],
            "requested_entry_absolute_paths": [INPUTS[digit] for digit in digits],
            "status": "matches_serial_in_this_trace" if matches_serial else "counterexample_to_overlap_safety",
            "matches_two_serial_inputs": matches_serial,
            "expected_serial_output_results": expected,
            "expected_serial_completion_readouts": expected_readouts,
            **observed, "final_trigger_all": engine.arrivals[COMPLETION],
            "trace": engine.trace}


def check_nested_paths(policy):
    """Different local Q1 definitions must never alias when connecting across scopes."""
    def group(identity, members, entries):
        return {"id": identity, "members": members, "trigger": {"any": entries},
                "queue": "work", "pro": {}, "runtime": {}}

    root = group("G1", [
        {"id": "Q1", "q": 0, "trigger": {"any": []}},
        group("G2", [
            {"id": "Q1", "q": 0, "trigger": {"any": ["G1.G3.Q1"]},
             "sources": {"seed": 0, "s": ["G1.G3.Q1"], "ex": ["K"]}},
            {"id": "Q2", "q": 0, "trigger": {"any": ["Q1"]},
             "sources": {"seed": 0, "s": ["Q1"], "ex": ["K"]}}
        ], ["Q1"]),
        group("G3", [
            {"id": "Q1", "q": 1, "trigger": {"any": []}},
            {"id": "Q9", "q": 0, "trigger": {"any": []}}
        ], ["Q1", "Q9"])
    ], ["Q1"])
    engine = ReferenceTrace(root, policy, {"G1.G3.Q1"})
    require(set(engine.nodes) == {"G1.Q1", "G1.G2.Q1", "G1.G2.Q2", "G1.G3.Q1", "G1.G3.Q9"},
            "Every nested occurrence has its own absolute identity")
    engine.inject_upstream("G1.G3.Q1")
    source_event = list(engine.events)
    require(source_event == ["G1.G3.Q1"], "Injected event stores only its absolute source path")
    engine.deliver()
    cross_layer_task = list(engine.tasks)
    require(cross_layer_task == ["G1.G2.Q1"], "Cross-layer trigger admits the exact absolute target")
    engine.execute()
    result_event = list(engine.events)
    require(result_event == ["G1.G2.Q1"], "Calculation publication stores no result payload")
    engine.deliver()
    local_task = list(engine.tasks)
    require(local_task == ["G1.G2.Q2"], "Local Q1 trigger normalizes to its containing scope")
    engine.drain()
    require(engine.q["G1.Q1"] == 0 and engine.q["G1.G3.Q1"] == 1
            and engine.q["G1.G2.Q1"] == engine.q["G1.G2.Q2"] == 1,
            "Cross-layer calculation reads G3.Q1; local calculation reads G2.Q1; root Q1 is untouched")
    first = next(item for item in engine.trace if item["kind"] == "task_completed")
    require(first["entry_q"] == {"G1.G3.Q1": 1}, "Calculation operands use resolved absolute paths")

    rejected = 0
    for enqueue in (engine.queue_event, engine.queue_task):
        for bad in ("Q1", "G1.G2", {"source": "G1.G3.Q1", "result": 1}):
            try:
                enqueue(bad)
            except ValueError:
                rejected += 1
            else:
                raise ValueError("FIFO admitted a short ID, a JKS path or a value-bearing object")
    require(not engine.events and not engine.tasks, "Rejected admissions leave both FIFOs unchanged")
    bad = deepcopy(root)
    bad["members"][1]["members"][0]["trigger"] = {"any": ["Q9"]}
    try:
        ReferenceTrace(bad, policy)
    except ValueError:
        rejected += 1
    else:
        raise ValueError("Bare Q9 incorrectly searched a sibling JKS")
    return {"policy": policy, "source_event_queue": source_event,
            "cross_layer_task_queue": cross_layer_task, "result_event_queue": result_event,
            "normalized_local_task_queue": local_task, "final_q": engine.q,
            "invalid_admissions_and_cross_scope_fallback_rejected": rejected,
            "trace": engine.trace}


def check_unsupported_jks_registrations(policy):
    """Valid all/transaction structures must fail explicitly before reference execution."""
    source = {"id": "G_SOURCE",
              "members": [{"id": "Q1", "q": 1, "trigger": {"any": []}}],
              "trigger": {"any": ["Q1"]}, "queue": "work", "pro": {}, "runtime": {}}
    rejected = []
    for mode in ("all", "transaction"):
        target = {"id": "G_TARGET",
                  "members": [{"id": "Q1", "q": 0,
                               "trigger": {"any": ["G_SOURCE.Q1"]},
                               "sources": {"seed": 0, "s": ["G_SOURCE.Q1"], "ex": ["K"]}}],
                  "trigger": {mode: ["G_SOURCE.Q1"]},
                  "queue": "work", "pro": {}, "runtime": {}}
        roots = [source, target]
        # Establish that rejection concerns unimplemented behavior, not malformed JSON.
        index = RULE_CHECKS["index_structure"](roots)
        RULE_CHECKS["check_resolved_connections"](index)
        try:
            ReferenceTrace(roots, policy, {"G_SOURCE.Q1"})
        except ValueError as error:
            require("Unsupported JKS trigger registrations" in str(error),
                    "Expected the explicit reference-capability guard")
            rejected.append(mode)
        else:
            raise ValueError(f"Reference evaluator silently accepted unimplemented JKS {mode}")
    return {"policy": policy, "structurally_valid_registrations_rejected": rejected,
            "rejection_count": len(rejected)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()
    template = read_model()
    component = bind_entries(template)
    serial = []
    for policy in POLICIES:
        engine = initialized_trace(component, policy)
        demo = [check_serial_input(engine, digit) for digit in DEMO]
        pair_count = 0
        for first, second in itertools.product(range(10), repeat=2):
            engine = initialized_trace(component, policy)
            check_serial_input(engine, first)
            check_serial_input(engine, second)
            pair_count += 1
        engine = initialized_trace(component, policy)
        sweep = [check_serial_input(engine, digit) for digit in SWEEP]
        serial.append({"policy": policy, "demo": demo, "ordered_digit_pairs_passed": pair_count,
                       "serial_input_checks": len(DEMO) + 2 * pair_count,
                       "continuous_sweep": sweep, "additional_sweep_input_checks": len(sweep)})
    overlap = [overlap_case(component, policy, digits)
               for policy in POLICIES for digits in ((0, 1), (0, 0))]
    gating = [check_entry_gating(template, policy) for policy in POLICIES]
    nested_paths = [check_nested_paths(policy) for policy in POLICIES]
    unsupported_registrations = [check_unsupported_jks_registrations(policy) for policy in POLICIES]
    report = {
        "status": "template_static_and_bound_reference_checks_passed",
        "template_static_status": "passed",
        "registered_reference_status": "bounded_serial_traces_passed",
        "verified_at_utc": datetime.now(timezone.utc).isoformat(),
        "model": str(MODEL.relative_to(ROOT)), "executor_implemented": False,
        "structure_validator": str(VALIDATOR.relative_to(ROOT)),
        "observation_label_to_absolute_node_path": OUTPUTS,
        "internal_JKI_count": len(RULE_CHECKS["index_structure"](component)["nodes"]), "empty_EX_JKI_count": len(EMPTY_EX_NODES),
        "editable_entry_absolute_paths": INPUTS,
        "fixture_upstream_registration": TEST_BINDINGS,
        "fixture_registration_scope": "Test-only absolute UPSTREAM.Q1..Q11 paths reference full JKI definitions in a separate fixture root; bindings are edited on a deep copy, never on the saved component",
        "per_serial_input": {"computation_tasks": 8, "direct_responses": 7,
                             "internal_notifications": 15, "initialization_notifications": 0},
        "scope": "Finite ordinary-JKS reference interpretation of this proposal; JKS all, transactions and other control registrations are explicitly unsupported; not a production executor or canonical scheduler",
        "assumptions": ["Each input injects only a registered fixture UPSTREAM.Q1..Q10 absolute source path; its actual component entry must satisfy trigger and publish before downstream work",
                        "Serial checks drain both FIFOs completely before the next external input",
                        "event-first prioritizes notifications; task-first prioritizes tasks; these are reference trace choices",
                        "One notification fans out in JSON node declaration order before another queue item executes",
                        "Nonempty EX snapshots source q, computes, conditionally appends a notification, then writes q without internal queue switching",
                        "Empty EX responds directly to satisfied JKI any/all using current q, without a task or q write; JKI ALL consumes its satisfied round",
                        "JKS.trigger.any registers ten actual editable member entries; their template empty ANY lists do not trigger or publish automatically",
                        "Only empty or any JKS registration is accepted by this reference evaluator; this is a tool capability limit, not a closed JKS type enumeration",
                        "Local Q references resolve only in their containing JKS; cross-layer references use exact absolute paths",
                        "Task admission and notification admission both store only indexed absolute JKI paths",
                        "Purpose tags neither address nodes nor control execution"],
        "event_payload": "absolute source JKI path only; result and observations exist solely in external trace instrumentation",
        "task_payload": "absolute target JKI path only",
        "evidence_replaces": "Earlier direct Q1..Q10 notification injection bypassed the real entry trigger/publication path and is superseded by these registered-upstream traces",
        "total_serial_input_checks": sum(case["serial_input_checks"] + case["additional_sweep_input_checks"] for case in serial),
        "serial_checks": serial, "entry_gating_checks": gating, "nested_path_checks": nested_paths,
        "unsupported_jks_registration_checks": unsupported_registrations,
        "overlap_checks": overlap,
        "not_verified": ["all possible cross-FIFO schedules or subscriber orders",
                         "JKS all arrival coordination or transaction execution, failure rollback and cancellation of all current transaction computations",
                         "other JKS control-purpose execution semantics",
                         "overlapping inputs as a safe reusable protocol",
                         "actual upstream application execution, live registration edits or JKM envelope/loading",
                         "production execution, concurrency, faults, persistence or topology admission"],
        "source_sha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in (MODEL, Path(__file__).resolve(), VALIDATOR, ROOT / "JKRD7.md")},
    }
    if args.write_report:
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    # Output the report as JSON; full overlap traces remain available in the saved report.
    printed = deepcopy(report)
    for case in [*printed["overlap_checks"], *printed["nested_path_checks"]]:
        case["trace_steps_recorded"] = len(case.pop("trace"))
    printed["report_written"] = args.write_report
    print(json.dumps(printed, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError) as error:
        raise SystemExit(f"ASCII digit reference check failed: {error}")
