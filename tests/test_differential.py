"""Compare production C++ state-machine traces to the independent oracle.

The native CPU backend exercises production code without claiming GPU memory
ordering coverage. scripts/validate_cuda.py repeats this corpus on CUDA.
"""

import random
import unittest
from copy import deepcopy
from itertools import product

from jkcuda.reference import Reference
from tests.test_reference import inputs, matcher_model, model, node


def semantic_cases():
    """A deterministic corpus whose reference is calculated without Core."""
    cases = []
    transaction_events = matcher_model("ALL_LATEST")
    event_steps = [{"node": "a", "params": {"p": 0}}, {"node": "b", "params": {"p": 1}},
                   {"node": "a", "params": {"p": 1}}, {"node": "b", "params": {"p": 0}}]
    transaction_events["transactions"] = [{"name": "ordered_pair", "queue": "work", "steps": event_steps}]
    cases.append(("transaction_ordered_event_pairs", transaction_events,
                  [{"transaction": event_steps, "queue": "work", "contract": "ordered_pair"}]))
    transaction_alias = model([node("n", state="S", sources={"p": {"kind": "PARAM", "param": "p"}},
                                    ops=[["K", "p"]], output="Y")], states=[("S", 0)])
    alias_steps = [{"node": "n", "params": {"p": 1}}, {"node": "n", "result_refs": {"p": 0}},
                   {"node": "n", "result_refs": {"p": 1}}, {"node": "n", "result_refs": {"p": 0}}]
    transaction_alias["transactions"] = [{"name": "toggle_chain", "queue": "work", "steps": alias_steps}]
    cases.append(("transaction_alias_and_result", transaction_alias,
                  [{"transaction": alias_steps, "queue": "work", "contract": "toggle_chain"}]))
    missing_steps = [{"node": "n", "params": {"p": 1}}, {"node": "n"}]
    transaction_alias["transactions"].append({"name": "incomplete", "queue": "work", "steps": missing_steps})
    cases.append(("transaction_missing_rolls_back_candidates", transaction_alias,
                  [{"transaction": missing_steps, "queue": "work", "contract": "incomplete"}]))
    state_alias = model([
        node("write", state="S", sources={"p": {"kind": "PARAM", "param": "p"}}, ops=[["K", "p"]], output="S"),
        node("read", state="T", sources={"zero": {"kind": "CONST", "value": 0},
                                           "s": {"kind": "STATE", "state": "S"}, "self": {"kind": "SELF"}},
             ops=[["J", "zero"], ["K", "s"], ["K", "self"]], output="T")],
        states=[("S", 0), ("T", 1)])
    state_steps = [{"node": "write", "params": {"p": 1}}, {"node": "read"},
                   {"node": "write", "result_refs": {"p": 1}}]
    state_alias["transactions"] = [{"name": "state_alias", "queue": "work", "steps": state_steps}]
    cases.append(("transaction_state_source_alias", state_alias,
                  [{"transaction": state_steps, "queue": "work", "contract": "state_alias"}]))
    for mode in ("ALL_LATEST", "ZIP", "KEYED"):
        requests = inputs([("a", 0, "one"), ("a", 1, "one"),
                           ("a", 0, "two"), ("b", 1, "two"),
                           ("b", 0, "one"), ("b", 1, "one"),
                           ("b", 0, 1), ("a", 0, "1"),
                           ("b", 1, "1"), ("a", 1, 1)])
        cases.append(("trigger_" + mode.lower(), matcher_model(mode), requests))
    fanout = model([node("input")] + [node("target" + str(i), ports=("p",), output="Y" + str(i))
                                      for i in range(24)],
                   subscriptions=[{"source": "input", "target": "target" + str(i),
                                   "port": "p", "order": 100 - i} for i in range(24)])
    cases.append(("high_fanout_explicit_order", fanout,
                  inputs([("input", 0, None), ("input", 1, None)])))
    priorities = model([node("low"), node("high", queue="urgent", ports=("p",), output="Y")],
                       queues=[{"name": "work", "priority": 5}, {"name": "urgent", "priority": 1}],
                       subscriptions=[{"source": "low", "target": "high", "port": "p", "order": 0}])
    cases.append(("priority_after_complete", priorities,
                  inputs([("low", 0, None), ("low", 1, None), ("low", 0, None)])))
    same_event = matcher_model("ALL_LATEST")
    same_event["subscriptions"] = [
        {"source": "a", "target": "join", "port": "b", "order": 2},
        {"source": "a", "target": "join", "port": "a", "order": 1}]
    cases.append(("one_event_two_ports", same_event,
                  inputs([("a", 0, "f"), ("a", 1, "g")])))
    sources = {"zero": {"kind": "CONST", "value": 0},
               "one": {"kind": "CONST", "value": 1},
               "self": {"kind": "SELF"}, "s": {"kind": "STATE", "state": "S"},
               "p": {"kind": "PARAM", "param": "p"},
               "v": {"kind": "VALUE", "value_id": "zero"}}
    long_ex = model([node("n", state="S", sources=sources, output="Y",
                          ops=[["J", "zero"], ["K", "self"]] + [["K", "s"], ["K", "p"], ["J", "one"]] * 257)],
                    states=[("S", 1)], values={"zero": 0})
    cases.append(("long_ex_fixed_bindings", long_ex, inputs([("n", bit, None) for bit in (0, 1, 1, 0)])))
    missing = model([node("n", state="S", sources=sources, output="Y",
                          ops=[["J", "zero"], ["K", "self"], ["K", "v"]])],
                    states=[("S", 1)], values={"zero": 0})
    cases.append(("unused_required_parameter", missing, [{"node": "n"}, {"node": "n", "params": {"p": 0}}]))
    for condition in ("always", "zero", "one", "never", "changed"):
        m = model([node("n", state="S", publish=condition, output="Y")], states=[("S", 0)])
        cases.append(("publication_" + condition, m, inputs([("n", bit, None) for bit in (0, 1, 1, 0)])))
    rng = random.Random(610027)
    for case in range(16):
        mode = rng.choice(("ALL_LATEST", "ZIP", "KEYED"))
        m = matcher_model(mode, state="S")
        sink = m["nodes"][-1]
        sink["sources"].update({"self": {"kind": "SELF"}, "s": {"kind": "STATE", "state": "S"}})
        sink["ops"] = [[rng.choice(("J", "K")), rng.choice(tuple(sink["sources"]))]
                      for _ in range(rng.randint(1, 100))]
        sink["ex"] = "".join(op + "(" + source + ")" for op, source in sink["ops"])
        requests = inputs([(rng.choice(("a", "b")), rng.randrange(2), rng.choice((None, 0, 1, "0", "1")))
                           for _ in range(25)])
        cases.append(("random_" + str(case), m, requests))
    return cases


def execute_core(core, expected_trace, *, max_work=1, max_tasks=1):
    """Bounded driver; correctness is the entire ordered trace, not a count."""
    limit = max(100, len(expected_trace) * 4)
    for _ in range(limit):
        core.advance(max_work=max_work, max_tasks=max_tasks)
        trace = core.trace()
        if len(trace) >= len(expected_trace):
            break
        status = core.status()
        if status.get("status") in ("resource_wait", "failed", "budget_paused"):
            raise AssertionError("unexpected stopped core: " + repr(status))
    # Extra advancement cannot duplicate the final commit or invent an event.
    core.advance(max_work=max_work, max_tasks=max_tasks)
    actual = core.trace()
    if actual != expected_trace:
        for index, (got, wanted) in enumerate(zip(actual, expected_trace)):
            if got != wanted:
                raise AssertionError("trace mismatch at %d\nactual=%r\nexpected=%r" % (index, got, wanted))
        raise AssertionError("trace lengths differ: actual %d expected %d" % (len(actual), len(expected_trace)))
    return actual


class DifferentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from jkcuda.backend import Core
        cls.Core = Core

    def test_complete_traces_across_work_bounds(self):
        for case, m, requests in semantic_cases():
            ref = Reference(m)
            ref.enqueue(requests)
            ref.run()
            for work, tasks in ((1, 1), (7, 1), (10000, 10000)):
                with self.subTest(case=case, work=work, tasks=tasks):
                    core = self.Core(m, device="native-cpu")
                    core.enqueue(requests)
                    execute_core(core, ref.trace, max_work=work, max_tasks=tasks)

    def test_all_boolean_operations_and_two_instruction_compositions(self):
        sources = {"zero": {"kind": "CONST", "value": 0}, "one": {"kind": "CONST", "value": 1},
                   "self": {"kind": "SELF"}, "p": {"kind": "PARAM", "param": "p"}}
        instructions = list(product(("J", "K"), sources))
        definitions, requests = [], []
        for length in (1, 2):
            for program in product(instructions, repeat=length):
                for seed in (0, 1):
                    name = "expression" + str(len(definitions))
                    definitions.append(node(name, seed=seed, sources=sources,
                                            ops=[list(instruction) for instruction in program], output="Y"))
                    requests.extend([{"node": name, "params": {"p": bit}} for bit in (0, 1)])
        m = model(definitions)
        reference = Reference(m)
        reference.enqueue(requests)
        reference.run()
        core = self.Core(m, device="native-cpu")
        core.enqueue(requests)
        execute_core(core, reference.trace, max_work=100000, max_tasks=100000)
        self.assertEqual(core.outputs(), reference.outputs)

    def test_source_task_keeps_ownership_until_all_fanout_is_published(self):
        _, m, requests = next(case for case in semantic_cases() if case[0] == "high_fanout_explicit_order")
        core = self.Core(m, device="native-cpu")
        core.enqueue(requests)
        ref = Reference(m)
        ref.enqueue(requests)
        ref.run()
        seen_partial = False
        for _ in range(2000):
            core.advance(max_work=1, max_tasks=1)
            trace = core.trace()
            first_complete = next((i for i, row in enumerate(trace)
                                   if row["kind"] == "complete" and row["task"] == 1), None)
            deliveries = [row for row in trace if row["kind"] == "delivery" and row["task"] == 1]
            if deliveries and first_complete is None:
                seen_partial = True
                self.assertEqual([row["task"] for row in trace if row["kind"] == "select"], [1])
            if first_complete is not None:
                self.assertEqual(len(deliveries), 24)
                break
        self.assertTrue(seen_partial)
        execute_core(core, ref.trace, max_work=7)

    def test_input_accepted_during_propagation_only_enqueues(self):
        _, m, _ = next(case for case in semantic_cases() if case[0] == "high_fanout_explicit_order")
        m["queues"].append({"name": "urgent", "priority": 0})
        m["nodes"].append(node("arriving", queue="urgent", output="arriving"))
        core = self.Core(m, device="native-cpu")
        core.enqueue([{"node": "input", "params": {"p": 0}}])
        for _ in range(100):
            core.advance(max_work=1, max_tasks=1)
            if any(row["kind"] == "delivery" for row in core.trace()):
                break
        before = core.trace()
        self.assertEqual(core.status()["active_task"], 1)
        self.assertEqual(core.status()["completed"], 0)
        arriving = core.enqueue([{"node": "arriving", "params": {"p": 1}}])[0]
        self.assertEqual(core.trace()[:-1], before)
        self.assertEqual(core.trace()[-1]["kind"], "enqueue")
        self.assertEqual(core.status()["active_task"], 1)
        core.advance(max_work=10000, max_tasks=10000)
        trace = core.trace()
        self.assertEqual([row["task"] for row in trace if row["kind"] == "select"][:2], [1, arriving])
        first_complete = next(i for i, row in enumerate(trace) if row["kind"] == "complete" and row["task"] == 1)
        arriving_select = next(i for i, row in enumerate(trace) if row["kind"] == "select" and row["task"] == arriving)
        self.assertLess(first_complete, arriving_select)
        self.assertEqual(len([row for row in trace[:first_complete] if row["kind"] == "delivery"]), 24)
        self.assertEqual([(row["port"], row["value"]) for row in core.outputs()],
                         [("arriving", 1)] + [("Y" + str(i), 0) for i in reversed(range(24))])

    def test_fault_retry_and_capsule_resume_preserve_complete_trace(self):
        case_names = ("high_fanout_explicit_order", "transaction_ordered_event_pairs", "transaction_alias_and_result")
        for name, m, requests in semantic_cases():
            if name not in case_names:
                continue
            reference = Reference(m)
            reference.enqueue(requests)
            reference.run()
            faults = [("before_commit", 0), ("after_commit", 0)]
            if m["subscriptions"]:
                faults += [("before_delivery", 0), ("after_delivery", 1)]
            for point, after in faults:
                for restore in (False, True):
                    with self.subTest(case=name, point=point, after=after, restored=restore):
                        core = self.Core(m, device="native-cpu")
                        core.enqueue(requests)
                        core.set_fault(point, after=after)
                        core.advance(max_work=10000, max_tasks=10000)
                        stopped = core.status()
                        self.assertEqual(stopped["status"], "failed")
                        self.assertEqual(stopped["active_task"], 1)
                        self.assertEqual(stopped["completed"], 0)
                        frozen_trace = core.trace()
                        if point == "before_commit":
                            self.assertFalse(any(row["kind"] == "commit" for row in frozen_trace))
                            self.assertEqual({name: entry["value"] for name, entry in stopped["states"].items()},
                                             {state["id"]: state["initial"] for state in m["states"]})
                        else:
                            self.assertTrue(any(row["kind"] == "commit" for row in frozen_trace))
                        core.advance(max_work=10000, max_tasks=10000)
                        self.assertEqual(core.trace(), frozen_trace)
                        if restore:
                            snapshot = core.dump()
                            core = self.Core.from_dump(m, snapshot, device="native-cpu")
                            self.assertEqual(core.trace(), frozen_trace)
                            self.assertEqual(core.status()["active_task"], 1)
                        core.retry()
                        execute_core(core, reference.trace, max_work=1)
                        self.assertEqual(core.outputs(), reference.outputs)
                        self.assertEqual(core.status()["states"],
                                         {name: {"value": value, "version": reference.versions[name]}
                                          for name, value in reference.states.items()})

    def test_capacity_wait_keeps_active_and_growth_does_not_change_trace(self):
        _, m, requests = next(case for case in semantic_cases() if case[0] == "high_fanout_explicit_order")
        reference = Reference(m)
        reference.enqueue(requests)
        reference.run()
        for resource in ("tasks", "tokens", "events", "outputs", "traces"):
            capacities = {resource: {"tasks": 2, "tokens": 1, "events": 1, "outputs": 1, "traces": 6}[resource]}
            with self.subTest(resource=resource):
                core = self.Core(m, device="native-cpu", capacities=capacities)
                core.enqueue(requests)
                for _ in range(1000):
                    core.advance(max_work=1, max_tasks=1)
                    if core.status()["status"] == "resource_wait":
                        break
                stopped = core.status()
                self.assertEqual(stopped["status"], "resource_wait")
                active = stopped["active_task"]
                self.assertIsNotNone(active)
                frozen = core.trace()
                core.advance(max_work=10000, max_tasks=10000)
                self.assertEqual(core.trace(), frozen)
                core.grow({resource: 65536})
                self.assertEqual(core.status()["active_task"], active)
                execute_core(core, reference.trace, max_work=7)

    def test_budget_stops_before_selection_and_preserves_fifo(self):
        loop = node("loop", queue="urgent", state="S", ports=("p",),
                    sources={"one": {"kind": "CONST", "value": 1}}, ops=[["K", "one"]], output="Y")
        loop["budget_group"] = 7
        m = model([loop, node("later", output="later")],
                  states=[("S", 0)],
                  queues=[{"name": "urgent", "priority": 1}, {"name": "work", "priority": 5}],
                  subscriptions=[{"source": "loop", "target": "loop", "port": "p", "order": 0}])
        m["budgets"] = [{"id": 7, "limit": 3}]
        m["entrypoints"] = ["loop", "later"]
        requests = [{"node": "loop"}, {"node": "later", "params": {"p": 0}}]
        ref = Reference(m)
        ref.enqueue(requests)
        ref.run(3)
        core = self.Core(m, device="native-cpu")
        core.enqueue(requests)
        core.advance(max_work=10000, max_tasks=10000)
        self.assertEqual(core.status()["status"], "budget_paused")
        self.assertIsNone(core.status()["active_task"])
        self.assertEqual(core.trace(), ref.trace)
        self.assertFalse(any(row["kind"] == "select" and row["node"] == "later" for row in core.trace()))
        frozen = core.dump()
        restored = self.Core.from_dump(m, frozen, device="native-cpu")
        self.assertEqual(restored.status()["budgets"], [{"id": 7, "limit": 3, "used": 3}])
        restored.resume_budget(7, 2)
        ref.run(2)
        restored.advance(max_work=10000, max_tasks=10000)
        self.assertEqual(restored.trace(), ref.trace)
        self.assertEqual(restored.status()["budgets"], [{"id": 7, "limit": 5, "used": 5}])

    def test_unmatched_tokens_snapshot_continues_without_losing_zero(self):
        for mode in ("ALL_LATEST", "ZIP", "KEYED"):
            with self.subTest(mode=mode):
                m = matcher_model(mode)
                initial = inputs([("a", 0, "x"), ("a", 1, "x")])
                later = inputs([("b", 1, "x"), ("b", 0, "x")])
                reference = Reference(m)
                reference.enqueue(initial)
                reference.run()
                core = self.Core(m, device="native-cpu")
                core.enqueue(initial)
                execute_core(core, reference.trace)
                restored = self.Core.from_dump(m, core.dump(), device="native-cpu", capacities={"tokens": 16384})
                self.assertEqual(restored.logical_state(), core.logical_state())
                reference.enqueue(later)
                reference.run()
                restored.enqueue(later)
                execute_core(restored, reference.trace)

    def test_restore_rejects_corrupt_trace_output_and_active_candidate(self):
        m = model([node("n", state="S", output="Y")], states=[("S", 0)])
        core = self.Core(m, device="native-cpu")
        core.enqueue([{"node": "n", "params": {"p": 1}}])
        core.advance(max_work=10000, max_tasks=1)
        snapshot = core.dump()
        mutations = [("traces", 0, 0, 999), ("traces", 0, 1, 999999),
                     ("outputs", 0, 1, 999999), ("outputs", 0, 4, 999999)]
        for section, row, field, value in mutations:
            with self.subTest(section=section, field=field):
                corrupted = deepcopy(snapshot)
                corrupted["logical"]["sections"][section][row][field] = value
                with self.assertRaises(ValueError):
                    self.Core.from_dump(m, corrupted, device="native-cpu")
        core = self.Core(m, device="native-cpu")
        core.enqueue([{"node": "n", "params": {"p": 1}}])
        core.set_fault("before_commit")
        core.advance(max_work=10000, max_tasks=1)
        for field in (5, 6):
            with self.subTest(candidate_field=field):
                corrupted = deepcopy(core.dump())
                corrupted["logical"]["sections"]["tasks"][0][field] = 7
                with self.assertRaises(ValueError):
                    self.Core.from_dump(m, corrupted, device="native-cpu")

    def test_restore_rejects_skipping_unfinished_event(self):
        _, m, requests = next(case for case in semantic_cases() if case[0] == "high_fanout_explicit_order")
        core = self.Core(m, device="native-cpu")
        core.enqueue(requests)
        core.set_fault("after_delivery")
        core.advance(max_work=10000, max_tasks=1)
        corrupted = deepcopy(core.dump())
        task = corrupted["logical"]["sections"]["tasks"][0]
        task[9] = task[8]
        with self.assertRaises(ValueError):
            self.Core.from_dump(m, corrupted, device="native-cpu")



if __name__ == "__main__":
    unittest.main()
