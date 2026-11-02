"""Public business-runtime tests with independent bit-arithmetic expectations.

V6.1 S01 requires PRE ownership, real COMP EX, and independent POST/NEXT
storage. S02/S03 require ACK replay/consume without executing COMP again.
The explicit business/1 profile declares per-width S=parity^previous_C and
C=parity. Expected results below are literals or elementary Python arithmetic;
no production evaluator, matcher, or frame-control helper computes them.
"""
from copy import deepcopy
import os
from pathlib import Path
import tempfile
import unittest

from jkcuda import Runtime
from jkcuda.business import build_business_model


DEVICE = os.environ.get("JKCUDA_TEST_DEVICE", "native-cpu")
EXAMPLE = Path(__file__).parents[1] / "examples/cuda/business.json"


def accumulator_spec(widths=(1,), *, capacity=2):
    definitions = {}
    for width in widths:
        sources = {"x" + str(i): {"kind": "INPUT", "index": i} for i in range(width)}
        sources["old"] = {"kind": "STATE", "state": "acc"}
        definitions[str(width)] = {
            "nodes": [{"id": "sum", "ex": "J0" + "".join("K(x" + str(i) + ")" for i in range(width)) + "K(old)",
                       "sources": sources}],
            "outputs": ["sum"], "state": {"acc": 0}, "next_state": {"acc": "sum"}}
    return {"block_capacity": capacity, "widths": definitions}


class BusinessTests(unittest.TestCase):
    def test_invalid_business_dependencies_and_state_contract_are_rejected(self):
        base = accumulator_spec()
        candidates = []
        candidate = deepcopy(base)
        candidate["widths"]["1"]["nodes"][0]["sources"]["x"] = {"kind": "RESULT", "node": "sum"}
        candidates.append(("result cycle", candidate))
        candidate = deepcopy(base)
        candidate["widths"]["1"]["nodes"][0]["dependencies"] = ["sum"]
        candidates.append(("explicit dependency cycle", candidate))
        candidate = deepcopy(base)
        candidate["widths"]["1"]["nodes"][0]["sources"]["x0"]["index"] = 1
        candidates.append(("input outside declared width", candidate))
        candidate = deepcopy(base)
        candidate["widths"]["1"]["nodes"][0]["sources"]["old"]["state"] = "unknown"
        candidates.append(("unknown state", candidate))
        candidate = deepcopy(base)
        candidate["widths"]["1"]["next_state"] = {}
        candidates.append(("missing next-state mapping", candidate))
        candidate = deepcopy(base)
        candidate["widths"]["1"]["outputs"] = ["unknown"]
        candidates.append(("unknown output result", candidate))
        for reason, candidate in candidates:
            with self.subTest(reason=reason), self.assertRaises(ValueError):
                build_business_model(candidate)

    def make(self, model=None, **options):
        runtime = Runtime(model or build_business_model(accumulator_spec()),
                          device=DEVICE, work_slice=64, **options)
        self.addCleanup(runtime.close)
        return runtime

    def submit(self, runtime, bits, request):
        return runtime.submit_frame(bits, request_id=request).wait("device_visible", 10)

    def idle(self, runtime):
        status = runtime.run()
        self.assertEqual(status["status"], "ready", status)
        self.assertEqual(status["pending"], 0, status)
        self.assertIsNone(status["active_task"], status)
        return status

    def commits(self, runtime, node):
        return [entry for entry in runtime.trace() if entry["kind"] == "commit" and entry["node"] == node]

    def test_acceptance_owns_input_without_running_business_or_state(self):
        runtime = self.make(build_business_model(accumulator_spec((3,))))
        values = [1, 0, 1]
        before = runtime.status()["states"]
        ticket = self.submit(runtime, values, "owned")
        values[:] = [0, 0, 0]
        self.assertEqual(len(ticket.task_ids), 3)
        self.assertEqual(runtime.status()["completed"], 0)
        self.assertEqual(runtime.status()["states"], before)
        frame = runtime.frame_status()["frames"][0]
        self.assertEqual(frame["pre_values"], [None, None, None])
        self.assertIsNone(frame["post_values"])
        self.assertFalse(frame["stored"])
        self.assertTrue(all(entry["kind"] == "enqueue" for entry in runtime.trace()))
        self.idle(runtime)
        frame = runtime.frame_status()["frames"][0]
        self.assertEqual(frame["pre_values"], [1, 0, 1])
        self.assertEqual(frame["post_values"], [0])

    def test_three_round_accumulator_progresses_without_ack(self):
        model = build_business_model(accumulator_spec())
        runtime = self.make(model)
        tickets = [self.submit(runtime, [bit], "round:" + str(i)) for i, bit in enumerate((1, 0, 1))]
        self.idle(runtime)
        state = runtime.frame_status()
        self.assertEqual([frame["post_values"] for frame in state["frames"]], [[1], [1], [0]])
        self.assertEqual([frame["frame_id"] for frame in state["frames"]], [ticket.details["frame_id"] for ticket in tickets])
        self.assertTrue(all(frame["pre_stage"] == 4 and frame["stored"] and not frame["consumed"] for frame in state["frames"]))
        self.assertEqual(state["business"], {"active_frame": None, "pre_queue": []})
        profile = model["business_module"]["widths"][0]
        self.assertEqual(runtime.status()["states"][profile["state_slots"]["acc"]], {"value": 0, "version": 3})
        self.assertEqual([entry["value"] for entry in self.commits(runtime, "business.w1.COMP.sum")], [1, 1, 0])
        # The head alone is externally emitted. Lack of ACK does not hold the
        # business CLAIM or prevent later frames from finishing POST/NEXT.
        self.assertEqual([batch["values"] for batch in runtime.read_frame_batches()], [[1]])

    def test_width_one_eight_nine_keep_independent_sc_and_next_state(self):
        model = build_business_model(accumulator_spec((1, 8, 9)))
        runtime = self.make(model, propagation_chunk=3, block_size=64)
        parity_by_width = {1: [0, 1, 1, 0], 8: [0, 1, 0, 0], 9: [0, 1, 0, 1]}
        expected_s = {1: [0, 1, 0, 1], 8: [0, 1, 1, 0], 9: [0, 1, 1, 1]}
        expected_acc = {1: [0, 1, 0, 0], 8: [0, 1, 1, 1], 9: [0, 1, 1, 0]}
        expected_posts = []
        for round_index in range(4):
            for width in (1, 8, 9):
                parity = parity_by_width[width][round_index]
                bits = [parity] + [0] * (width - 1)
                # Include nonzero even-parity frames, not only all-zero ones.
                if round_index == 2 and width in (8, 9):
                    bits[:2] = [1, 1]
                self.submit(runtime, bits, f"w{width}:{round_index}")
                expected_posts.append([expected_acc[width][round_index]])
        self.idle(runtime)
        self.assertEqual([frame["post_values"] for frame in runtime.frame_status()["frames"]], expected_posts)
        trace = runtime.trace()
        for profile in model["business_module"]["widths"]:
            width = profile["input_width"]
            s = self.commits(runtime, f"business.w{width}.S")
            c = self.commits(runtime, f"business.w{width}.C")
            self.assertEqual([row["value"] for row in s], expected_s[width])
            self.assertEqual([row["value"] for row in c], parity_by_width[width])
            for s_row, c_row in zip(s, c):
                self.assertLess(trace.index(s_row), trace.index(c_row))
            states = runtime.status()["states"]
            self.assertEqual(states[profile["s_state"]], {"value": expected_s[width][-1], "version": 4})
            self.assertEqual(states[profile["c_state"]], {"value": parity_by_width[width][-1], "version": 4})
            self.assertEqual(states[profile["state_slots"]["acc"]], {"value": expected_acc[width][-1], "version": 4})

    def test_real_dag_dependencies_and_different_output_width(self):
        spec = {"widths": {"3": {"state": {"memory": 1}, "next_state": {"memory": "final"},
            "nodes": [
                {"id": "base", "ex": "J0K(a)K(b)", "sources": {
                    "a": {"kind": "INPUT", "index": 0}, "b": {"kind": "INPUT", "index": 1}}},
                {"id": "mixed", "ex": "J0K(value)K(old)", "sources": {
                    "value": {"kind": "RESULT", "node": "base"}, "old": {"kind": "STATE", "state": "memory"}}},
                {"id": "gated", "ex": "J0K(value)J(gate)", "sources": {
                    "value": {"kind": "RESULT", "node": "mixed"}, "gate": {"kind": "INPUT", "index": 2}}},
                {"id": "final", "ex": "J0K(value)K(a)", "dependencies": ["mixed"], "sources": {
                    "value": {"kind": "RESULT", "node": "gated"}, "a": {"kind": "INPUT", "index": 0}}}],
            "outputs": ["mixed", "final"]}}}
        runtime = self.make(build_business_model(spec), propagation_chunk=1)
        for index, bits in enumerate(([1, 0, 1], [1, 1, 0], [0, 1, 1], [1, 0, 1])):
            self.submit(runtime, bits, f"dag:{index}")
        self.idle(runtime)
        self.assertEqual([frame["post_values"] for frame in runtime.frame_status()["frames"]],
                         [[0, 1], [1, 1], [0, 0], [1, 0]])
        for name, expected in {"base": [1, 0, 1, 1], "mixed": [0, 1, 0, 1],
                               "gated": [0, 0, 0, 1], "final": [1, 1, 0, 0]}.items():
            self.assertEqual([row["value"] for row in self.commits(runtime, "business.w3.COMP." + name)], expected)
        self.assertEqual(runtime.read_frame_batches()[0]["values"], [0, 1])

    def test_ack_replays_retained_post_and_consumes_without_new_comp(self):
        runtime = self.make()
        first = self.submit(runtime, [1], "first")
        second = self.submit(runtime, [0], "second")
        self.idle(runtime)
        original = runtime.read_frame_batches()[0]
        self.idle(runtime)  # host completion is a separate FIFO control task
        comp_before = self.commits(runtime, "business.w1.COMP.sum")
        runtime.ack_frame(0, request_id="replay").wait("device_visible", 10)
        self.idle(runtime)
        replay = runtime.read_frame_batches()[-1]
        self.assertEqual((replay["frame_id"], replay["values"], replay["marker"], replay["replay"]),
                         (first.details["frame_id"], [1], 0, True))
        self.assertNotEqual(replay["batch_id"], original["batch_id"])
        self.idle(runtime)
        runtime.ack_frame(1, request_id="consume").wait("device_visible", 10)
        self.idle(runtime)
        following = runtime.read_frame_batches()[-1]
        self.assertEqual((following["frame_id"], following["values"], following["marker"]),
                         (second.details["frame_id"], [1], 1))
        self.assertEqual(self.commits(runtime, "business.w1.COMP.sum"), comp_before)
        self.assertEqual([frame["consumed"] for frame in runtime.frame_status()["frames"]], [True, False])

    def test_new_frame_claims_after_idle_without_ack_or_stale_owner(self):
        runtime = self.make()
        self.submit(runtime, [1], "first"); self.idle(runtime)
        first = runtime.frame_status()["frames"][0]
        self.assertEqual(runtime.frame_status()["business"], {"active_frame": None, "pre_queue": []})
        self.submit(runtime, [1], "later"); self.idle(runtime)
        frames = runtime.frame_status()["frames"]
        self.assertEqual([frame["post_values"] for frame in frames], [[1], [0]])
        self.assertEqual(frames[0]["claim_task_id"], first["claim_task_id"])
        self.assertGreater(frames[1]["claim_task_id"], frames[0]["finish_task_id"])

    def test_undeclared_width_rejection_does_not_change_device_business(self):
        runtime = self.make(build_business_model(accumulator_spec((1, 9))))
        before_frames = runtime.frame_status()  # initialize the immutable table
        before_states, before_trace = runtime.status()["states"], runtime.trace()
        ticket = runtime.submit_frame([0] * 8, request_id="unsupported")
        with self.assertRaisesRegex(RuntimeError, "no declared business DAG"):
            ticket.wait("device_visible", 10)
        self.assertFalse(ticket.accepted)
        self.assertEqual(runtime.frame_status(), before_frames)
        self.assertEqual(runtime.status()["states"], before_states)
        self.assertEqual(runtime.trace(), before_trace)
        self.assertEqual(runtime.status()["pending"], 0)

    def test_unrelated_structure_version_preserves_registered_business_identity(self):
        runtime = self.make()
        self.submit(runtime, [1], "queued-before-version")
        candidate = deepcopy(runtime.current_model())
        candidate["nodes"].append({"id": "unrelated", "queue": "business.work", "ex": "J0K1", "sources": {}})
        candidate["entrypoints"].append("unrelated")
        runtime.modify(candidate, queue="business.input", request_id="new-version").wait("device_visible", 10)
        self.idle(runtime)
        self.submit(runtime, [1], "queued-after-version"); self.idle(runtime)
        self.assertEqual([frame["post_values"] for frame in runtime.frame_status()["frames"]], [[1], [0]])
        self.assertEqual(len(self.commits(runtime, "business.w1.FINISH")), 2)
        self.assertIn("unrelated", [node["id"] for node in runtime.current_model()["nodes"]])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dynamic-business.json"
            runtime.snapshot(path)
            restored = Runtime.restore_runtime(path, device=DEVICE)
            self.addCleanup(restored.close)
            self.assertEqual(restored.fingerprint(), runtime.fingerprint())
            self.submit(restored, [0], "after-restore"); self.idle(restored)
            self.assertEqual([frame["post_values"] for frame in restored.frame_status()["frames"]], [[1], [0], [0]])

    def test_partial_input_claim_and_comp_snapshot_resume_identical_tasks(self):
        model = build_business_model(accumulator_spec((3,)))
        for cut in ("input", "claim", "comp"):
            with self.subTest(cut=cut):
                runtime = self.make(model, propagation_chunk=1, block_size=32)
                self.submit(runtime, [1, 0, 0], "first")
                self.submit(runtime, [1, 1, 0], "second")
                for _ in range(100):
                    runtime.step()
                    frame = runtime.frame_status()["frames"][0]
                    reached = {"input": frame["arrived"] == 1,
                               "claim": frame["pre_stage"] == 3,
                               "comp": bool(self.commits(runtime, "business.w3.COMP.sum"))}[cut]
                    if reached:
                        break
                else:
                    self.fail("did not reach requested partial business phase")
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "partial-business.json"
                    runtime.snapshot(path)
                    restored = Runtime.restore_runtime(path, device=DEVICE, propagation_chunk=9, block_size=64)
                    self.addCleanup(restored.close)
                    self.assertEqual(restored.fingerprint(), runtime.fingerprint())
                    self.idle(runtime); self.idle(restored)
                    self.assertEqual(restored.trace(), runtime.trace())
                    self.assertEqual(restored.frame_status(), runtime.frame_status())
                    self.assertEqual(restored.status()["states"], runtime.status()["states"])
                    self.assertEqual([frame["post_values"] for frame in restored.frame_status()["frames"]], [[1], [1]])

    def test_partial_then_full_storage_block_reuse_keeps_business_state(self):
        runtime = self.make()
        records = []
        for index, value in enumerate((1, 0, 1)):
            self.submit(runtime, [value], f"frame:{index}"); self.idle(runtime)
            records.append(deepcopy(runtime.frame_status()["frames"][-1]))
            runtime.read_frame_batches(); self.idle(runtime)
            runtime.ack_frame(1, request_id=f"consume:{index}").wait("device_visible", 10)
            self.idle(runtime)
        first, second, third = records
        self.assertEqual([row["post_values"] for row in records], [[1], [1], [0]])
        self.assertEqual([row["block_id"] for row in records], [first["block_id"]] * 3)
        self.assertEqual([row["slot"] for row in records], [0, 1, 0])
        self.assertEqual(second["slot_generation"], first["slot_generation"])
        self.assertEqual(third["slot_generation"], first["slot_generation"] + 1)
        self.assertEqual(len({row["frame_id"] for row in records}), 3)
        self.assertEqual(runtime.frame_status()["blocks"][0]["live"], 0)

    def test_checked_in_example_is_runnable_with_width_one_and_nine(self):
        runtime = self.make(EXAMPLE)
        for index, bits in enumerate(([1], [1] + [0] * 8, [0], [0] * 9, [1], [1] * 9)):
            self.submit(runtime, bits, f"example:{index}")
        self.idle(runtime)
        self.assertEqual([frame["post_values"] for frame in runtime.frame_status()["frames"]],
                         [[1], [1], [1], [1], [0], [0]])


if __name__ == "__main__":
    unittest.main()
