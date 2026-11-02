"""Independent semantic obligations for the parallel propagation path.

Sources: plan.V6.1 §§3.1, 3.3 and PERF-P/PERF-H. Expected FIFO/event traces
come from the independent scalar Reference, plus explicit hand-derived pairs.
Set JKCUDA_TEST_DEVICE=cuda to execute this same corpus on actual GPU hardware.
Passing native-cpu exercises the optimized algorithm's CPU mirror only.
"""

import os
from pathlib import Path
import tempfile
import unittest

from jkcuda import Runtime
from jkcuda.backend import Core
from jkcuda.model import load_model, digest
from jkcuda.reference import Reference


DEVICE = os.environ.get("JKCUDA_TEST_DEVICE", "native-cpu")


def copy_node(identifier, *, queue="work", ports=(), state=None, output=None):
    return {"id": identifier, "queue": queue, "state": state,
            "ex": "K(p)" if state else "J0K(p)",
            "sources": {"p": {"kind": "PARAM", "param": "p"}},
            "trigger": {"mode": "ANY", "ports": list(ports)}, "output": output}


def normalize(nodes, subscriptions=(), *, queues=None, states=(), transactions=()):
    return load_model({"profile": "jkcuda.v6.1", "format_version": 1,
                       "queues": queues or [{"name": "work", "priority": 5}],
                       "nodes": nodes, "states": list(states), "subscriptions": list(subscriptions),
                       "transactions": list(transactions), "inputs": []})


def requests(values):
    return [{"node": source, "params": {"p": value}, "key": key}
            for source, value, key in values]


def fanout_model(count, *, shared_state=False, mixed_queues=False):
    nodes = [copy_node("source")]
    edges = []
    for index in range(count):
        nodes.append(copy_node(f"target{index}", ports=("p",), output=f"Y{index}",
                               state="shared" if shared_state else None,
                               queue="urgent" if mixed_queues and index % 2 else "work"))
        # Neither array order nor target slot order is publication order.
        edges.append({"source": "source", "target": f"target{index}", "port": "p", "order": count-index})
    queues = [{"name": "work", "priority": 5}]
    if mixed_queues:
        queues.insert(0, {"name": "urgent", "priority": 1})
    return normalize(nodes, edges, queues=queues,
                     states=[{"id": "shared", "initial": 0}] if shared_state else [])


def two_source_model(mode, targets=17):
    nodes = [copy_node("a"), copy_node("b")]
    edges = []
    for index in range(targets):
        identifier = f"join{index}"
        nodes.append({"id": identifier, "queue": "work", "ex": "J0K(a)K(b)",
                      "sources": {"a": {"kind": "PARAM", "param": "a"},
                                  "b": {"kind": "PARAM", "param": "b"}},
                      "trigger": {"mode": mode, "ports": ["a", "b"]}, "output": f"Y{index}"})
        for source in ("a", "b"):
            edges.append({"source": source, "target": identifier, "port": source, "order": targets-index})
    return normalize(nodes, edges)


def duplicate_target_model(mode):
    if mode == "ANY":
        hot = {"id": "hot", "queue": "work", "ex": "J0K1", "sources": {},
               "trigger": {"mode": mode, "ports": ["a", "b"]}, "output": "hot"}
    else:
        hot = {"id": "hot", "queue": "work", "ex": "J0K(a)K(b)",
               "sources": {"a": {"kind": "PARAM", "param": "a"}, "b": {"kind": "PARAM", "param": "b"}},
               "trigger": {"mode": mode, "ports": ["a", "b"]}, "output": "hot"}
    nodes = [copy_node("source"), hot, copy_node("left", ports=("p",), output="left"),
             copy_node("right", ports=("p",), output="right")]
    ordered = [("hot", "a"), ("left", "p"), ("hot", "b"),
               ("right", "p"), ("hot", "a"), ("hot", "b")]
    edges = [{"source": "source", "target": target, "port": port, "order": rank*10}
             for rank, (target, port) in enumerate(ordered)]
    return normalize(nodes, list(reversed(edges)))


def oracle(model, incoming):
    reference = Reference(model)
    reference.enqueue(incoming)
    reference.run()
    return reference


class ParallelPropagationTests(unittest.TestCase):
    def core(self, model, *, chunk=17, block=128, propagation="parallel", capacities=None):
        return Core(model, device=DEVICE, capacities=capacities, propagation=propagation,
                    propagation_chunk=chunk, block_size=block)

    def finish(self, core, *, work=4096, max_tasks=100000):
        for _ in range(100000):
            state = core.advance(max_work=work, max_tasks=max_tasks)
            if state["status"] != "ready":
                self.fail(f"unexpected retained status: {state}")
            if state["active_task"] is None and state["pending"] == 0:
                return
        self.fail("bounded test driver did not reach a complete boundary")

    def same_trace(self, core, reference):
        self.assertEqual(core.trace(), reference.trace)
        self.assertEqual(core.outputs(), reference.outputs)
        self.assertEqual(core.status()["completed"], reference.completed)

    def test_fanout_zero_warp_and_block_boundaries_preserve_every_record(self):
        for size in (0, 1, 31, 32, 33, 127, 128, 129, 257):
            model = fanout_model(size)
            incoming = requests([("source", 0, "repeat"), ("source", 0, "repeat")])
            reference = oracle(model, incoming)
            for chunk, block in ((1, 32), (17, 128), (257, 256)):
                with self.subTest(size=size, chunk=chunk, block=block):
                    core = self.core(model, chunk=chunk, block=block)
                    core.enqueue(incoming)
                    self.finish(core)
                    self.same_trace(core, reference)
                    self.assertEqual(core.status()["metrics"]["D"], 2*size)
                    self.assertEqual(len(core.outputs()), 2*size)
                    physical = core.status()["physical_metrics"]
                    if size:
                        self.assertGreater(physical["parallel_batches"], 0)
                        self.assertEqual(physical["parallel_edges"], 2*size)
                        self.assertEqual(physical["parallel_target_groups"], 2*size)
                        self.assertEqual(physical["parallel_tasks_formed"], 2*size)
                        self.assertLessEqual(physical["max_parallel_chunk"], chunk)
                    self.assertEqual([row["target"] for row in core.trace()
                                      if row["kind"] == "delivery" and row["task"] == 1],
                                     [f"target{i}" for i in range(size-1, -1, -1)])

    def test_shared_state_successors_still_bind_and_execute_serially(self):
        model = fanout_model(65, shared_state=True)
        incoming = requests([("source", 1, None)])
        core = self.core(model, chunk=33)
        core.enqueue(incoming)
        self.finish(core)
        reference = oracle(model, incoming)
        self.same_trace(core, reference)
        self.assertEqual([row["value"] for row in core.outputs()], [1, 0]*32 + [1])
        self.assertEqual(core.status()["states"]["shared"], {"value": 1, "version": 65})

    def test_one_event_repeated_target_ports_cross_chunk_boundaries(self):
        for mode in ("ANY", "ALL_LATEST", "ZIP", "KEYED"):
            model = duplicate_target_model(mode)
            incoming = requests([("source", 0, "f"), ("source", 1, "f")])
            reference = oracle(model, incoming)
            expected_hot = 8 if mode == "ANY" else 4
            self.assertEqual(len([row for row in reference.outputs if row["node"] == "hot"]), expected_hot)
            for chunk in (1, 2, 3, 4, 64):
                with self.subTest(mode=mode, chunk=chunk):
                    core = self.core(model, chunk=chunk)
                    core.enqueue(incoming)
                    self.finish(core)
                    self.same_trace(core, reference)
                    hot_matches = [row["params"] for row in core.trace() if row["kind"] == "match" and row["node"] == "hot"]
                    if mode != "ANY":
                        self.assertEqual(hot_matches, [{"a": 0, "b": 0}]*2 + [{"a": 1, "b": 1}]*2)

    def test_latest_zip_and_keyed_keep_distinct_matching_rules(self):
        values = [("a", 0, "x"), ("a", 1, "x"), ("a", 0, "y"),
                  ("b", 1, "y"), ("b", 0, "x"), ("b", 1, "x")]
        expectations = {
            "ALL_LATEST": [{"a": 0, "b": 1}],
            "ZIP": [{"a": 0, "b": 1}, {"a": 1, "b": 0}, {"a": 0, "b": 1}],
            "KEYED": [{"a": 0, "b": 1}, {"a": 0, "b": 0}, {"a": 1, "b": 1}],
        }
        for mode, expected in expectations.items():
            with self.subTest(mode=mode):
                model = two_source_model(mode)
                incoming = requests(values)
                core = self.core(model, chunk=9)
                core.enqueue(incoming)
                self.finish(core)
                self.same_trace(core, oracle(model, incoming))
                self.assertEqual([row["params"] for row in core.trace()
                                  if row["kind"] == "match" and row["node"] == "join0"], expected)

    def test_multi_event_transaction_keeps_both_all_latest_pairs(self):
        model = two_source_model("ALL_LATEST", targets=33)
        steps = [{"node": source, "params": {"p": value}} for source, value in
                 (("a", 0), ("b", 1), ("a", 1), ("b", 0))]
        model["transactions"] = [{"name": "four-events", "queue": "work", "steps": steps}]
        incoming = [{"transaction": steps, "queue": "work", "contract": "four-events", "key": "same"}]
        reference = oracle(model, incoming)
        for chunk in (1, 17, 128):
            with self.subTest(chunk=chunk):
                core = self.core(model, chunk=chunk)
                core.enqueue(incoming)
                self.finish(core)
                self.same_trace(core, reference)
                self.assertEqual([row["params"] for row in core.trace()
                                  if row["kind"] == "match" and row["node"] == "join0"],
                                 [{"a": 0, "b": 1}, {"a": 1, "b": 0}])
                first_complete = next(i for i, row in enumerate(core.trace()) if row["kind"] == "complete")
                self.assertTrue(all(row["task"] == 1 for row in core.trace()[:first_complete]
                                    if row["kind"] == "select"))

    def test_mixed_fifo_priority_does_not_reorder_publication(self):
        model = fanout_model(33, mixed_queues=True)
        incoming = requests([("source", 0, None)])
        core = self.core(model, chunk=8)
        core.enqueue(incoming); self.finish(core)
        self.same_trace(core, oracle(model, incoming))
        self.assertEqual([row["node"] for row in core.trace() if row["kind"] == "select"],
                         ["source"] + [f"target{i}" for i in range(32, -1, -1) if i % 2]
                         + [f"target{i}" for i in range(32, -1, -1) if not i % 2])

    def test_active_owner_remains_until_all_targets_are_formally_enqueued(self):
        model = fanout_model(129)
        core = self.core(model, chunk=7)
        core.enqueue(requests([("source", 0, None)]))
        for _ in range(1000):
            core.advance(max_work=1, max_tasks=1)
            trace = core.trace()
            if any(row["kind"] == "complete" and row["task"] == 1 for row in trace):
                break
            self.assertTrue(all(row["task"] == 1 for row in trace if row["kind"] == "select"))
            if any(row["kind"] == "delivery" for row in trace):
                self.assertEqual(core.status()["active_task"], 1)
        else:
            self.fail("source did not finish within a bounded number of phases")
        self.assertEqual(len([row for row in trace if row["kind"] == "delivery"]), 129)
        self.assertEqual(len([row for row in trace if row["kind"] == "enqueue"]), 130)
        self.assertEqual(core.outputs(), [])  # Matched successors still have not executed.

    def test_partial_propagation_restore_changes_only_physical_configuration(self):
        model = fanout_model(65)
        incoming = requests([("source", 1, "frame")])
        core = self.core(model, chunk=7, block=32)
        core.enqueue(incoming)
        for _ in range(100):
            core.advance(max_work=1, max_tasks=1)
            count = sum(row["kind"] == "delivery" for row in core.trace())
            if 0 < count < 65:
                break
        else:
            self.fail("test requires an observable partial propagation boundary")
        saved = core.dump()
        logical_hash = digest(core.logical_state())
        restored = Core.from_dump(model, saved, device=DEVICE, propagation="parallel",
                                  propagation_chunk=33, block_size=256)
        self.assertEqual(digest(restored.logical_state()), logical_hash)
        self.assertEqual(restored.trace(), core.trace())
        self.finish(restored)
        self.same_trace(restored, oracle(model, incoming))

    def test_fault_resume_does_not_repeat_or_skip_any_delivery(self):
        model = fanout_model(65)
        incoming = requests([("source", 0, None), ("source", 1, None)])
        reference = oracle(model, incoming)
        for point, after in (("before_commit", 0), ("after_commit", 0),
                             ("before_delivery", 0), ("after_delivery", 0), ("after_delivery", 32)):
            with self.subTest(point=point, after=after):
                core = self.core(model, chunk=17)
                core.enqueue(incoming); core.set_fault(point, after)
                for _ in range(1000):
                    status = core.advance(max_work=4096, max_tasks=10000)
                    if status["status"] == "failed":
                        break
                else:
                    self.fail("fault was not reached")
                self.assertEqual(status["active_task"], 1)
                self.assertEqual([row["task"] for row in core.trace() if row["kind"] == "select"], [1])
                count = sum(row["kind"] == "delivery" for row in core.trace())
                if point == "after_delivery":
                    self.assertEqual(count, after+1)
                elif point == "before_delivery":
                    self.assertEqual(count, after)
                restored = Core.from_dump(model, core.dump(), device=DEVICE, propagation="parallel",
                                          propagation_chunk=3, block_size=64)
                restored.retry(); self.finish(restored)
                self.same_trace(restored, reference)

    def test_resource_wait_preserves_active_task_and_published_prefix(self):
        model = fanout_model(65)
        incoming = requests([("source", 1, "frame")])
        core = self.core(model, chunk=7, capacities={"tasks": 11})
        core.enqueue(incoming)
        for _ in range(1000):
            status = core.advance(max_work=4096, max_tasks=100000)
            if status["status"] == "resource_wait":
                break
        else:
            self.fail("bounded task arena did not apply backpressure")
        self.assertEqual(status["active_task"], 1)
        prefix = core.trace()
        delivered = sum(row["kind"] == "delivery" for row in prefix)
        self.assertLess(delivered, 65)
        self.assertEqual([row["task"] for row in prefix if row["kind"] == "select"], [1])
        self.assertFalse(any(row["kind"] == "complete" for row in prefix))
        core.grow({"tasks": 128})
        self.assertEqual(core.trace(), prefix)
        self.finish(core)
        self.same_trace(core, oracle(model, incoming))

    def test_mid_propagation_ingress_has_one_recorded_fifo_position(self):
        model = fanout_model(65)
        initial = requests([("source", 0, None)])
        external = requests([("source", 1, "late")])
        core = self.core(model, chunk=7)
        core.enqueue(initial)
        for _ in range(100):
            core.advance(max_work=1, max_tasks=1)
            delivered = sum(row["kind"] == "delivery" for row in core.trace())
            if 0 < delivered < 65:
                break
        else:
            self.fail("no partial publication boundary exposed")
        before = core.trace()
        ids = core.enqueue(external)
        self.assertEqual(ids, [delivered+2])
        self.assertEqual(core.trace()[:-1], before)
        self.assertEqual(core.trace()[-1]["kind"], "enqueue")
        self.assertEqual(core.status()["active_task"], 1)

        class IngressReference(Reference):
            def _deliver(self, *args):
                super()._deliver(*args)
                count = sum(row["kind"] == "delivery" for row in self.trace)
                if count == delivered:
                    self.enqueue(external)

        reference = IngressReference(model)
        reference.enqueue(initial); reference.run()
        self.finish(core); self.same_trace(core, reference)

    def test_serial_and_parallel_have_equal_logical_fingerprints(self):
        model = two_source_model("KEYED", targets=33)
        incoming = requests([("a", 0, "k"), ("a", 1, "k"), ("b", 1, "k"), ("b", 0, "k")])
        serial = self.core(model, propagation="serial")
        serial.enqueue(incoming); self.finish(serial)
        for chunk, block in ((1, 32), (17, 128), (64, 256)):
            with self.subTest(chunk=chunk, block=block):
                core = self.core(model, chunk=chunk, block=block)
                core.enqueue(incoming); self.finish(core)
                self.assertEqual(core.logical_state(), serial.logical_state())
                self.assertEqual(digest(core.logical_state()), digest(serial.logical_state()))

    def test_public_runtime_active_snapshot_restores_with_new_parallel_configuration(self):
        model = fanout_model(65)
        model["entrypoints"] = ["source"]
        runtime = Runtime(model, device=DEVICE, work_slice=1, propagation="parallel",
                          propagation_chunk=7, block_size=32)
        self.addCleanup(runtime.close)
        ticket = runtime.submit("source", {"p": 1}, request_id="stable-frame", key="frame")
        ticket.wait("device_visible", 5)
        runtime._core.set_fault("after_delivery", after=8)
        self.assertEqual(runtime.step()["reason"], "injected_fault")
        self.assertEqual(sum(r["kind"] == "delivery" for r in runtime.trace()), 9)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "parallel-active.json"
            runtime.snapshot(path, active=True)
            restored = Runtime.restore_runtime(path, device=DEVICE, propagation="parallel",
                                               propagation_chunk=33, block_size=256)
            self.addCleanup(restored.close)
            self.assertEqual(restored.fingerprint(), runtime.fingerprint())
            self.assertEqual(restored.trace(), runtime.trace())
            self.assertEqual(restored.query_request("stable-frame")["task_ids"], ticket.task_ids)
            restored.retry_failed(); restored.run()
            runtime.retry_failed(); runtime.run()
            self.assertEqual(restored.trace(), runtime.trace())
            self.assertEqual(restored.read_output(), runtime.read_output())
            self.assertEqual(restored.fingerprint(), runtime.fingerprint())
            self.assertEqual(restored.trace(), oracle(model, requests([("source", 1, "frame")])).trace)


if __name__ == "__main__":
    unittest.main()
