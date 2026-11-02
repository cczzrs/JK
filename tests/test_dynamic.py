"""Dynamic-version invariants independently derived from V6.1 T03 and L01."""

import os
import unittest
from copy import deepcopy

from jkcuda.backend import Core
from tests.test_reference import inputs, matcher_model, model, node


TEST_DEVICE = os.environ.get("JKCUDA_TEST_DEVICE", "native-cpu")

class DynamicTests(unittest.TestCase):
    Core = Core

    def test_new_node_becomes_addressable_only_after_its_structure_task(self):
        m = model([node("original")],
                  queues=[{"name": "control", "priority": 0}, {"name": "work", "priority": 1}])
        core = self.Core(m, device=TEST_DEVICE)
        candidate = deepcopy(m)
        candidate["nodes"].append(node("created", output="Y"))
        core.modify(candidate, queue="control")
        with self.assertRaises(KeyError):
            core.enqueue([{"node": "created", "params": {"p": 0}}])
        self.assertEqual([node["id"] for node in core.current_model()["nodes"]], ["original"])
        core.advance(max_tasks=1)
        core.enqueue([{"node": "created", "params": {"p": 0}}])
        core.advance(max_tasks=100)
        self.assertEqual([row["value"] for row in core.outputs()], [0])

    def test_queued_structure_change_does_not_replace_active_event_graph(self):
        m = model([node("source"), node("sink", ports=("p",), output="Y")],
                  queues=[{"name": "control", "priority": 0}, {"name": "work", "priority": 1}],
                  subscriptions=[{"source": "source", "target": "sink", "port": "p", "order": 0}])
        core = self.Core(m, device=TEST_DEVICE)
        core.enqueue([{"node": "source", "params": {"p": 0}}])
        core.advance(max_work=3, max_tasks=1)
        self.assertEqual(core.status()["phase"], "PROPAGATING")
        candidate = deepcopy(m)
        candidate["subscriptions"] = []
        core.modify(candidate, queue="control")
        self.assertFalse(any(row["kind"] == "structure" for row in core.trace()))
        core.advance(max_tasks=100)
        trace = core.trace()
        completed = next(i for i, row in enumerate(trace) if row["kind"] == "complete" and row["task"] == 1)
        modified = next(i for i, row in enumerate(trace) if row["kind"] == "structure")
        self.assertLess(completed, modified)
        self.assertEqual([row["value"] for row in core.outputs()], [0])
        core.enqueue([{"node": "source", "params": {"p": 1}}])
        core.advance(max_tasks=100)
        self.assertEqual([row["value"] for row in core.outputs()], [0])

    def test_stateful_generation_reuse_requires_distinct_slot_and_preserves_old_holder(self):
        m = model([node("n", state="old", output="Y"), node("keep")], states=[("old", 0)],
                  queues=[{"name": "control", "priority": 0}, {"name": "work", "priority": 1}])
        core = self.Core(m, device=TEST_DEVICE)
        core.enqueue([{"node": "n", "params": {"p": 1}}])
        retired = deepcopy(m)
        retired["nodes"] = retired["nodes"][1:]
        core.modify(retired, queue="control")
        core.advance(max_tasks=1)
        reused = deepcopy(m)
        reused["nodes"][0]["generation"] = 2
        with self.assertRaises(ValueError):
            core.modify(reused, queue="control")
        reused["nodes"][0]["state"] = "new"
        reused["states"].append({"id": "new", "initial": 0})
        core.modify(reused, queue="control")
        core.advance(max_tasks=1)
        core.advance(max_tasks=100)
        self.assertEqual(core.status()["states"], {"old": {"value": 1, "version": 1},
                                                  "new": {"value": 0, "version": 0}})
        core.enqueue([{"node": "n", "params": {"p": 0}}])
        core.advance(max_tasks=100)
        self.assertEqual(core.status()["states"], {"old": {"value": 1, "version": 1},
                                                  "new": {"value": 0, "version": 1}})

    def test_actual_scc_merge_and_split_rejected_even_with_same_budget_members(self):
        m = model([node("a", ports=("p",)), node("b", ports=("p",))], subscriptions=[
            {"source": "a", "target": "a", "port": "p", "order": 0},
            {"source": "b", "target": "b", "port": "p", "order": 0}])
        m["entrypoints"] = ["a", "b"]
        m["budgets"] = [{"id": 7, "limit": 10}]
        for definition in m["nodes"]:
            definition["budget_group"] = 7
        merged = deepcopy(m)
        merged["subscriptions"] += [
            {"source": "a", "target": "b", "port": "p", "order": 1},
            {"source": "b", "target": "a", "port": "p", "order": 1}]
        for original, candidate in ((m, merged), (merged, m)):
            with self.subTest(original_edges=len(original["subscriptions"])):
                core = self.Core(original, device=TEST_DEVICE)
                before = core.logical_state()
                with self.assertRaises(ValueError):
                    core.modify(candidate, queue="work")
                self.assertEqual(core.logical_state(), before)

    def test_queued_program_versions_survive_structure_task_and_restore(self):
        m = model([node("n", output="Y")],
                  queues=[{"name": "control", "priority": 0}, {"name": "work", "priority": 1}])
        core = self.Core(m, device=TEST_DEVICE)
        core.enqueue([{"node": "n", "params": {"p": 1}}, {"node": "n", "params": {"p": 0}}])
        candidate = deepcopy(m)
        changed = candidate["nodes"][0]
        changed["version"] = 2
        changed["sources"]["one"] = {"kind": "CONST", "value": 1}
        changed["ops"].append(["K", "one"])
        changed["ex"] += "K(one)"
        core.modify(candidate, queue="control")
        self.assertEqual(core.outputs(), [])
        core.advance(max_tasks=1)
        self.assertEqual(core.outputs(), [])
        restored = self.Core.from_dump(m, core.dump(), device=TEST_DEVICE)
        restored.enqueue([{"node": "n", "params": {"p": 1}}])
        restored.advance(max_tasks=100)
        self.assertEqual([row["value"] for row in restored.outputs()], [1, 0, 0])

    def test_program_change_retains_unmatched_token_ownership(self):
        m = matcher_model("ALL_LATEST")
        m["queues"].append({"name": "control", "priority": 0})
        core = self.Core(m, device=TEST_DEVICE)
        core.enqueue(inputs([("a", 0, "frame")]))
        core.advance(max_tasks=100)
        candidate = deepcopy(m)
        changed = candidate["nodes"][-1]
        changed["version"] = 2
        changed["sources"]["one"] = {"kind": "CONST", "value": 1}
        changed["ops"].append(["K", "one"])
        changed["ex"] += "K(one)"
        core.modify(candidate, queue="control")
        core.advance(max_tasks=1)
        core.enqueue(inputs([("b", 1, "frame")]))
        core.advance(max_tasks=100)
        self.assertEqual([row["params"] for row in core.trace() if row["kind"] == "match"], [{"a": 0, "b": 1}])
        self.assertEqual([row["value"] for row in core.outputs()], [0])

    def test_trigger_change_with_residual_tokens_is_rejected_without_loss(self):
        m = matcher_model("ALL_LATEST")
        m["queues"].append({"name": "control", "priority": 0})
        core = self.Core(m, device=TEST_DEVICE)
        core.enqueue(inputs([("a", 0, None)]))
        core.advance(max_tasks=100)
        candidate = deepcopy(m)
        candidate["nodes"][-1]["trigger"]["mode"] = "ZIP"
        core.modify(candidate, queue="control")
        core.advance(max_tasks=1)
        structures = [row for row in core.trace() if row["kind"] == "structure"]
        self.assertEqual(structures[-1]["outcome"], "rejected_pending_tokens")
        core.enqueue(inputs([("b", 1, None)]))
        core.advance(max_tasks=100)
        self.assertEqual([row["value"] for row in core.outputs()], [1])

    def test_retired_generation_cannot_publish_to_reused_identity_subscriptions(self):
        m = model([node("source"), node("sink", ports=("p",), output="Y")],
                  queues=[{"name": "control", "priority": 0}, {"name": "work", "priority": 1}])
        core = self.Core(m, device=TEST_DEVICE)
        core.enqueue([{"node": "source", "params": {"p": 1}}])
        retired = deepcopy(m)
        retired["nodes"] = retired["nodes"][1:]
        core.modify(retired, queue="control")
        core.advance(max_tasks=1)
        reused = deepcopy(m)
        reused["nodes"][0]["generation"] = 2
        reused["subscriptions"] = [{"source": "source", "target": "sink", "port": "p", "order": 0}]
        core.modify(reused, queue="control")
        core.advance(max_tasks=1)
        core.advance(max_tasks=100)
        self.assertEqual(core.outputs(), [])
        self.assertFalse(any(row["kind"] == "delivery" and row["task"] == 1 for row in core.trace()))
        core.enqueue([{"node": "source", "params": {"p": 1}}])
        core.advance(max_tasks=100)
        self.assertEqual([row["value"] for row in core.outputs()], [1])


if __name__ == "__main__":
    unittest.main()
