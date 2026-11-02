"""Independent negative and recovery tests for the declared V6.1 business DAG.

Expected results follow ordinary JK XOR/copy operations and plan.V6.1 S01:
only completed real COMP results may be saved to independent POST/NEXT tasks.
The native control hook may transfer those results, never calculate them.
"""
from copy import deepcopy
import os
from pathlib import Path
import tempfile
import unittest

from jkcuda import Runtime
from jkcuda.backend import Core
from jkcuda.business import build_business_model
from jkcuda.model import load_model
from jkcuda.persistence import read_checkpoint, write_checkpoint


DEVICE = os.environ.get("JKCUDA_TEST_DEVICE", "native-cpu")


def declaration(*, input_width=1, outputs=2):
    # Output order intentionally repeats a true result. NEXT must copy the
    # result once; repeated POST references must remain distinct output items.
    return {"block_capacity": 2, "widths": {str(input_width): {
        "nodes": [{"id": "sum", "ex": "J0K(x)K(old)",
                   "sources": {"x": {"kind": "INPUT", "index": 0},
                               "old": {"kind": "STATE", "state": "acc"}}}],
        "outputs": ["sum"] * outputs, "state": {"acc": 0}, "next_state": {"acc": "sum"}}}}


class BusinessAuditTests(unittest.TestCase):
    def runtime(self, model, **options):
        runtime = Runtime(model, device=DEVICE, work_slice=1, **options)
        self.addCleanup(runtime.close)
        return runtime

    def wait_for_finish(self, runtime, finish):
        # One submitted frame and one FIFO: when the final POST/NEXT task
        # completes, its new FINISH task is the remaining declared successor.
        for _ in range(1000):
            trace = runtime.trace()
            enqueued = [row for row in trace if row["kind"] == "enqueue" and row["node"] == finish]
            if enqueued:
                task = enqueued[-1]["task"]
                self.assertFalse(any(row["kind"] == "select" and row["task"] == task for row in trace))
                return task
            status = runtime.step()
            self.assertEqual(status["status"], "ready")
        self.fail("real POST/NEXT completion never formed FINISH")

    def test_generated_arrival_alias_does_not_overwrite_user_expression_source(self):
        spec = {"widths": {"1": {"nodes": [{"id": "zero", "ex": "J0K(_contract_0)",
                  "sources": {"_contract_0": {"kind": "CONST", "value": 0}}}], "outputs": ["zero"]}}}
        model = build_business_model(spec)
        comp = next(node for node in model["nodes"] if node["id"].endswith(".COMP.zero"))
        self.assertEqual(comp["sources"]["_contract_0"], {"kind": "CONST", "value": 0})
        runtime = self.runtime(model)
        runtime.submit_frame([1], request_id="one").wait("device_visible", 5)
        runtime.run()
        self.assertEqual([batch["values"] for batch in runtime.read_frame_batches()], [[0]])

    def test_recomputed_contract_cannot_authorize_changed_protected_graph(self):
        model = build_business_model(declaration())
        finish = model["business_module"]["widths"][0]["finish_node"]
        state = model["business_module"]["widths"][0]["state_slots"]["acc"]
        outsider = {"id": "outside", "queue": model["frame_module"]["queue"], "ex": "J0K1", "sources": {}}
        variants = []
        changed = deepcopy(model)
        next(node for node in changed["nodes"] if node["id"].endswith(".COMP.sum"))["ex"] = "J0K1"
        next(node for node in changed["nodes"] if node["id"].endswith(".COMP.sum")).pop("ops")
        variants.append(("altered real COMP program", changed))
        changed = deepcopy(model)
        changed["nodes"].append(deepcopy(outsider))
        changed["subscriptions"].append({"source": "outside", "target": finish, "port": "p0", "order": 0})
        variants.append(("external FINISH event", changed))
        changed = deepcopy(model)
        writer = deepcopy(outsider); writer["state"] = state
        changed["nodes"].append(writer)
        variants.append(("external state writer", changed))
        changed = deepcopy(model)
        reader = deepcopy(outsider); reader["ex"] = "J0K(old)"
        reader["sources"] = {"old": {"kind": "STATE", "state": state}}
        changed["nodes"].append(reader)
        variants.append(("external state reader", changed))
        changed = deepcopy(model); changed["entrypoints"] = [finish]
        variants.append(("manual FINISH entrypoint", changed))
        changed = deepcopy(model)
        changed["transactions"] = [{"name": "spoof", "queue": model["frame_module"]["queue"],
                                    "steps": [{"node": finish, "params": {"p0": 1, "p1": 1, "s_acc": 1}}]}]
        variants.append(("external FINISH transaction", changed))
        for label, candidate in variants:
            with self.subTest(attack=label), self.assertRaises(ValueError):
                load_model(candidate)

    def test_direct_core_ingress_cannot_spoof_finish_or_comp(self):
        model = build_business_model(declaration())
        core = Core(model, device=DEVICE)
        before = core.logical_state()
        for node in model["business_module"]["protected_nodes"]:
            with self.subTest(node=node):
                with self.assertRaises(ValueError):
                    core.enqueue([{"node": node, "params": {}}])
                with self.assertRaises(ValueError):
                    core.enqueue([{"transaction": [{"node": node}], "queue": model["frame_module"]["queue"]}])
                self.assertEqual(core.logical_state(), before)

    def test_finish_commit_fault_keeps_post_and_next_real_and_exactly_once(self):
        model = build_business_model(declaration())
        profile = model["business_module"]["widths"][0]
        for fault in ("before_commit", "after_commit"):
            with self.subTest(fault=fault):
                runtime = self.runtime(model)
                runtime.submit_frame([1], request_id="frame").wait("device_visible", 5)
                task = self.wait_for_finish(runtime, profile["finish_node"])
                self.assertEqual(runtime.status()["states"][profile["state_slots"]["acc"]], {"value": 1, "version": 1})
                self.assertEqual(runtime.read_frame_batches(), [])
                runtime._core.set_fault(fault)
                status = runtime.step()
                self.assertEqual(status["reason"], "injected_fault")
                self.assertEqual(status["active_task"], task)
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "finish.json"
                    runtime.snapshot(path, active=True)
                    restored = Runtime.restore_runtime(path, device=DEVICE, propagation_chunk=3, block_size=64)
                    self.addCleanup(restored.close)
                    self.assertEqual(restored.fingerprint(), runtime.fingerprint())
                    restored.retry_failed(); restored.run()
                    batches = restored.read_frame_batches()
                    self.assertEqual([batch["values"] for batch in batches], [[1, 1]])
                    commits = [row for row in restored.trace() if row["kind"] == "commit" and row["task"] == task]
                    self.assertEqual(len(commits), 1)
                    self.assertEqual(restored.status()["states"][profile["state_slots"]["acc"]], {"value": 1, "version": 1})

    def test_different_input_output_widths_restore_before_and_after_post(self):
        for input_width, output_width in ((1, 3), (3, 1)):
            model = build_business_model(declaration(input_width=input_width, outputs=output_width))
            profile = model["business_module"]["widths"][0]
            for stage in ("accepted", "finish", "output"):
                with self.subTest(input_width=input_width, output_width=output_width, stage=stage):
                    runtime = self.runtime(model)
                    ticket = runtime.submit_frame([1] + [0]*(input_width-1), request_id="original")
                    ticket.wait("device_visible", 5)
                    if stage == "finish":
                        self.wait_for_finish(runtime, profile["finish_node"])
                    elif stage == "output":
                        runtime.run()
                    with tempfile.TemporaryDirectory() as directory:
                        path = Path(directory) / "widths.json"
                        runtime.snapshot(path)
                        restored = Runtime.restore_runtime(path, device=DEVICE, propagation_chunk=9)
                        self.addCleanup(restored.close)
                        self.assertEqual(restored.fingerprint(), runtime.fingerprint())
                        restored.run()
                        batches = restored.read_frame_batches()
                        self.assertEqual([batch["values"] for batch in batches], [[1]*output_width])
                        self.assertEqual(restored.query_request("original")["task_ids"], ticket.task_ids)
                        self.assertEqual(len(ticket.task_ids), input_width)

    def test_finish_capacity_wait_is_not_a_partial_commit(self):
        model = build_business_model(declaration())
        profile = model["business_module"]["widths"][0]
        # 1 input + PRE_ACCEPT + CLAIM + 1 PRE + S/C + GO + 1 COMP +
        # COMMIT + 2 POST + 1 NEXT + FINISH = 13 real tasks before STORE.
        # PRE_ACCEPT registers the immutable frame, and CLAIM is a separate
        # FIFO task that locks ownership before scheduling ordinary PRE nodes.
        runtime = self.runtime(model, capacities={"tasks": 13})
        runtime.submit_frame([1], request_id="frame").wait("device_visible", 5)
        task = self.wait_for_finish(runtime, profile["finish_node"])
        status = runtime.step()
        self.assertEqual(status["status"], "resource_wait")
        self.assertEqual(status["active_task"], task)
        self.assertFalse(any(row["kind"] == "commit" and row["task"] == task for row in runtime.trace()))
        self.assertEqual(runtime.read_frame_batches(), [])
        runtime.grow(tasks=128)
        runtime.run()
        self.assertEqual([batch["values"] for batch in runtime.read_frame_batches()], [[1, 1]])
        self.assertEqual(sum(row["kind"] == "commit" and row["task"] == task for row in runtime.trace()), 1)

    def test_rehashed_snapshot_cannot_replace_finish_latched_post_value(self):
        model = build_business_model(declaration())
        profile = model["business_module"]["widths"][0]
        runtime = self.runtime(model)
        runtime.submit_frame([1], request_id="frame").wait("device_visible", 5)
        task = self.wait_for_finish(runtime, profile["finish_node"])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "forged-finish.json"
            runtime.snapshot(path)
            payload = read_checkpoint(path)
            logical = payload["core"]["logical"]
            node_slot = logical["sections"]["tasks"][task-1][0]
            parameter = runtime._core._param_names[node_slot].index("p0")
            self.assertEqual(logical["sections"]["params"][task-1][parameter], 1)
            logical["sections"]["params"][task-1][parameter] = 0
            write_checkpoint(path, payload)  # A new checksum cannot replace source-event proof.
            with self.assertRaises(ValueError):
                Runtime.restore_runtime(path, device=DEVICE)


if __name__ == "__main__":
    unittest.main()
