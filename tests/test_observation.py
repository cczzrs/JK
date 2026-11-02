"""Observation must not acquire the output protocol's model-changing effects.

Expected transitions follow V6.1 Q01/Q02, N02/N03/N04 and S02/S03. The XOR
truth table and explicitly ordered task IDs below are independent expectations.
Native CPU validates the production core; this suite is not CUDA evidence.
"""
import copy
from pathlib import Path
import unittest
from unittest import mock

from jkcuda import Runtime
from jkcuda.backend import FRAMES
from jkcuda.reference import Reference


ROOT = Path(__file__).parents[1]
XOR = ROOT / "examples/cuda/xor.json"
FRAMES_MODEL = ROOT / "examples/cuda/frames.json"
BUSINESS = ROOT / "examples/cuda/business.json"


class ObservationTests(unittest.TestCase):
    def make(self, model=XOR, **options):
        runtime = Runtime(model, device="native-cpu", **options)
        self.addCleanup(runtime.close)
        return runtime

    def owned_state(self, runtime):
        return (runtime._core.dump(), copy.deepcopy(runtime._outbox),
                set(runtime._acknowledged), copy.deepcopy(runtime._requests),
                {key: value.as_dict() for key, value in runtime._tickets.items()},
                runtime._frames, runtime._accepted_frontier, runtime._pause.is_set())

    def test_fresh_frame_observation_never_initializes_or_transfers(self):
        runtime = self.make(FRAMES_MODEL)
        before = self.owned_state(runtime)
        with mock.patch.object(runtime, "_frame_module", side_effect=AssertionError("initialized")), \
                mock.patch.object(runtime, "_collect_outputs", side_effect=AssertionError("collected")), \
                mock.patch.object(runtime, "_persist", side_effect=AssertionError("persisted")), \
                mock.patch.object(runtime._core, "_upload", side_effect=AssertionError("uploaded")), \
                mock.patch.object(runtime._core, "_download", side_effect=AssertionError("downloaded")):
            result = runtime.observe(include_model=True)
        self.assertEqual(result["schema"], "jkcuda.observe/1")
        self.assertEqual(result["frames"], {"enabled": True, "initialized": False})
        self.assertEqual(result["status"]["completed"], 0)
        self.assertEqual(before, self.owned_state(runtime))
        self.assertEqual(runtime._core._row(FRAMES, 0)[0], 0)

    def test_observation_is_owned_copy_and_does_not_receive_frame_output(self):
        runtime = self.make(FRAMES_MODEL)
        runtime.submit_frame([0, 1], request_id="frame").wait(timeout=5)
        self.assertEqual([task["payload"] for task in runtime.observe()["queues"][0]["tasks"]],
                         [{"frame_id": 1, "position": 0, "value": 0},
                          {"frame_id": 1, "position": 1, "value": 1}])
        runtime.run()
        before = self.owned_state(runtime)
        for _ in range(3):
            result = runtime.observe(include_model=True)
            self.assertEqual(result["status"]["pending"], 0)
            self.assertFalse(result["frames"]["frames"][0]["qualified"])
            self.assertIsNone(result["frames"]["batches"][0]["completion_task_id"])
            self.assertEqual([row["value"] for row in result["outputs"]["items"]], [0, 1, 1])
        self.assertEqual(before, self.owned_state(runtime))
        result["outputs"]["items"][0]["value"] = 99
        result["model"]["nodes"].clear()
        self.assertEqual(before, self.owned_state(runtime))
        runtime.read_frame_batches()  # Explicit reception, unlike observation.
        received = runtime.observe()
        self.assertEqual(received["status"]["pending"], 1)
        self.assertFalse(received["frames"]["frames"][0]["qualified"])
        self.assertEqual(received["queues"][1]["tasks"][0]["control"], "FRAME_COMPLETE")
        self.assertEqual(received["queues"][1]["tasks"][0]["payload"]["batch_id"], 1)
        runtime.step()
        self.assertTrue(runtime.observe()["frames"]["frames"][0]["qualified"])

    def test_fifo_active_event_and_remaining_token_are_distinct(self):
        runtime = self.make(propagation="serial")
        runtime.send({"X1": 1, "X0": 0}, request_id="pair", key="pair").wait(timeout=5)
        queued = runtime.observe()
        self.assertEqual([task["node"] for task in queued["queues"][0]["tasks"]], ["A", "B"])
        self.assertEqual(queued["events"]["total"], 0)
        self.assertIsNone(queued["active_task"])
        runtime.step_work()
        selected = runtime.observe()
        self.assertEqual(selected["active_task"]["task_id"], 1)
        self.assertEqual(selected["status"]["phase"], "ACTIVE")
        self.assertEqual(selected["queues"][0]["head"], 2)
        self.assertEqual(selected["queues"][0]["pending"], 1)
        runtime.step_work()
        self.assertEqual(runtime.observe()["status"]["phase"], "EXECUTED")
        runtime.step_work()
        committed = runtime.observe()
        self.assertEqual(committed["status"]["phase"], "PROPAGATING")
        self.assertEqual(committed["events"]["pending"], 1)
        self.assertEqual(committed["events"]["items"][0], {
            "event_id": 1, "owner_task_id": 1, "source": "A", "value": 0,
            "key": "pair", "key_type": "string", "delivered": 0, "fanout": 1,
            "complete": False, "source_generation": 1, "subscription_version": 0,
            "program_version": 1})
        runtime.step()  # Finish A including its only delivery, without selecting B.
        after_a = runtime.observe()
        self.assertIsNone(after_a["active_task"])
        self.assertEqual(after_a["events"]["pending"], 0)
        self.assertEqual(after_a["events"]["total"], 1)
        self.assertEqual(after_a["tokens"]["pending"], 1)
        self.assertEqual(after_a["tokens"]["items"][0]["value"], 0)
        self.assertEqual(after_a["tokens"]["items"][0]["port"], "a")
        self.assertEqual(after_a["queues"][1]["pending"], 0)
        runtime.step()  # B's propagation forms xor, but does not execute it.
        after_b = runtime.observe()
        self.assertEqual(after_b["status"]["completed"], 2)
        self.assertEqual(after_b["tokens"]["pending"], 0)
        self.assertEqual(after_b["tokens"]["total"], 2)
        successor = after_b["queues"][1]["tasks"][0]
        self.assertEqual((successor["task_id"], successor["cause_task"], successor["cause_event"]), (3, 2, 2))
        self.assertEqual(successor["params"], {"a": 0, "b": 1})
        self.assertEqual(after_b["outputs"]["total"], 0)
        runtime.step()
        self.assertEqual(runtime.observe()["outputs"]["items"][0]["value"], 1)

    def test_key_buckets_preserve_zero_and_integer_string_distinction(self):
        runtime = self.make()
        large = 2**60
        runtime.send({"X0": 0}, request_id="integer", key=large).wait(timeout=5)
        runtime.send({"X1": 1}, request_id="string", key=str(large)).wait(timeout=5)
        runtime.run()
        result = runtime.observe()
        self.assertEqual(result["tokens"]["pending"], 2)
        self.assertEqual([(item["key"], item["key_type"], item["value"])
                          for item in result["tokens"]["items"]],
                         [(large, "integer", 0), (str(large), "string", 1)])
        self.assertEqual(result["outputs"]["total"], 0)
        published = [item for item in result["trace"]["items"] if item["kind"] == "event"]
        self.assertEqual([(item["key"], item["key_type"]) for item in published],
                         [(large, "integer"), (str(large), "string")])

    def test_work_steps_equal_complete_tasks_and_independent_reference(self):
        runtime = self.make(propagation_chunk=1)
        complete = self.make(propagation_chunk=1)
        for instance in (runtime, complete):
            instance.send({"X0": 1, "X1": 1}, request_id="pair", key=None).wait(timeout=5)
        observed_phases = set()
        for _ in range(100):
            before = runtime.status()["completed"]
            runtime.step_work()
            state = runtime.observe()
            self.assertTrue(state["status"]["paused"])
            self.assertLessEqual(state["status"]["completed"]-before, 1)
            observed_phases.add(state["status"]["phase"])
            if not state["active_task"] and not state["status"]["pending"]:
                break
        else:
            self.fail("bounded XOR sequence failed to finish")
        complete.run()
        reference = Reference(runtime.current_model())
        reference.enqueue([{"node": "A", "params": {"input": 1}},
                           {"node": "B", "params": {"input": 1}}])
        reference.run()
        self.assertEqual(runtime.trace(), complete.trace())
        self.assertEqual(runtime.trace(), reference.trace)
        self.assertTrue({"ACTIVE", "EXECUTED", "PROPAGATING", "IDLE"} <= observed_phases)
        self.assertEqual(runtime.observe()["outputs"]["items"][0]["value"], 0)

    def test_trace_pagination_and_tail_decode_only_requested_rows(self):
        runtime = self.make()
        runtime.send({"X0": 0, "X1": 1}, request_id="pair").wait(timeout=5)
        runtime.run()
        expected = runtime.trace()
        rows, cursor = [], 0
        with mock.patch.object(runtime._core, "trace", side_effect=AssertionError("unbounded trace")):
            while True:
                page = runtime.observe(since_trace=cursor, limit=2)["trace"]
                self.assertLessEqual(len(page["items"]), 2)
                rows.extend(page["items"])
                cursor = page["next_cursor"]
                if not page["has_more"]:
                    break
            tail = runtime.observe(since_trace=None, limit=3)["trace"]
        self.assertEqual([row["seq"] for row in rows], list(range(1, len(expected)+1)))
        self.assertEqual([{k: v for k, v in row.items() if k not in ("seq", "key_type", "task_info")}
                          for row in rows], expected)
        self.assertEqual(tail["items"], rows[-3:])
        self.assertEqual(tail["next_cursor"], len(expected))
        self.assertEqual(runtime.observe(since_trace=cursor)["trace"]["items"], [])

    def test_pending_and_retained_capacity_counts_are_not_conflated(self):
        runtime = self.make()
        for index in range(3):
            runtime.send({"X0": index % 2}, request_id=str(index), key=index).wait(timeout=5)
        queued = runtime.observe(limit=1)
        self.assertEqual(queued["queues"][0]["pending"], 3)
        self.assertEqual(len(queued["queues"][0]["tasks"]), 1)
        self.assertTrue(queued["queues"][0]["truncated"])
        runtime.run()
        completed = runtime.observe(limit=1)
        self.assertEqual(completed["status"]["pending"], 0)
        self.assertEqual(completed["tokens"]["pending"], 3)
        self.assertTrue(completed["tokens"]["truncated"])
        storage = {row["name"]: row for row in completed["storage"]}
        self.assertEqual(storage["tasks"]["used"], 3)
        self.assertEqual(storage["events"]["used"], 3)
        self.assertEqual(storage["tokens"]["used"], 3)

    def test_frame_and_business_details_are_bounded(self):
        runtime = self.make(BUSINESS)
        runtime.submit_frame([1] * 9, request_id="frame").wait(timeout=5)
        runtime.run()
        result = runtime.observe(limit=2)
        frame = result["frames"]["frames"][0]
        self.assertEqual(frame["input_width"], 9)
        self.assertEqual(frame["pre_values"], [1, 1])
        self.assertTrue(frame["values_truncated"])
        self.assertEqual(frame["post_values"], [1])
        self.assertEqual(result["frames"]["business"]["active_frame"], None)
        self.assertEqual(result["frames"]["batches"][0]["marker"], 1)

    def test_bounded_frame_view_keeps_current_head_visible_after_consumption(self):
        runtime = self.make(FRAMES_MODEL)
        runtime.submit_frame([0], request_id="first").wait(timeout=5)
        runtime.submit_frame([1], request_id="second").wait(timeout=5)
        runtime.run()
        runtime.read_frame_batches()
        runtime.run()
        runtime.ack_frame(1, request_id="consume").wait(timeout=5)
        runtime.run()
        frames = runtime.observe(limit=1)["frames"]
        self.assertEqual(frames["head"], 2)
        self.assertEqual(frames["frame_total"], 2)
        self.assertEqual(frames["frames"][0]["frame_id"], 2)
        self.assertEqual(frames["batches"][0]["frame_id"], 2)
        self.assertTrue(frames["truncated"])

    def test_work_step_rejects_concurrent_execution_and_bad_budgets(self):
        runtime = self.make()
        runtime._run_lock.acquire()
        try:
            with self.assertRaisesRegex(RuntimeError, "another execution"):
                runtime.step_work()
        finally:
            runtime._run_lock.release()
        for value in (0, -1, True, 1.5, 2**63):
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime.step_work(value)
        for value in (-1, True, "1"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime.observe(since_trace=value)
        for value in (0, -1, True, 10001):
            with self.subTest(value=value), self.assertRaises(ValueError):
                runtime.observe(limit=value)

    def test_failed_cuda_domain_marks_last_host_mirror_unverified(self):
        runtime = self.make()
        # Inject only the host fatal marker, not a simulated device execution.
        runtime._core._fatal = "device execution failed"
        result = runtime.observe()
        self.assertFalse(result["status"]["mirror_valid"])
        self.assertEqual(result["status"]["fatal_error"], "device execution failed")

    def test_work_slice_does_not_select_next_task_after_finishing_one(self):
        runtime = self.make()
        runtime.send({"X0": 1, "X1": 0}, request_id="pair").wait(timeout=5)
        runtime.step_work(max_work=1000)
        result = runtime.observe()
        self.assertEqual(result["status"]["completed"], 1)
        self.assertIsNone(result["active_task"])
        self.assertEqual(result["queues"][0]["head"], 2)
        self.assertEqual([row["task"] for row in result["trace"]["items"] if row["kind"] == "select"], [1])

    def test_resource_wait_and_failed_work_preserve_active_identity(self):
        runtime = self.make(capacities={"tasks": 2})
        runtime.send({"X0": 1, "X1": 0}, request_id="pair").wait(timeout=5)
        runtime.step_work(max_work=100)
        waiting = runtime.observe()
        self.assertEqual(waiting["status"]["status"], "resource_wait")
        self.assertEqual(waiting["status"]["completed"], 0)
        self.assertEqual(waiting["active_task"]["task_id"], 1)
        self.assertEqual(waiting["task_activity"]["nodes"]["A"]["active_task_id"], 1)
        self.assertEqual(waiting["task_activity"]["nodes"]["A"]["completed"], 0)
        self.assertEqual(waiting["queues"][0]["head"], 2)
        self.assertEqual(waiting["events"]["pending"], 0)
        runtime.grow(tasks=4)
        runtime._core.set_fault("after_commit")
        runtime.step_work(max_work=100)
        failed = runtime.observe()
        self.assertEqual(failed["status"]["status"], "failed")
        self.assertEqual(failed["active_task"]["task_id"], 1)
        self.assertEqual(failed["events"]["pending"], 1)
        self.assertEqual(failed["status"]["completed"], 0)
        self.assertEqual(failed["task_activity"]["nodes"]["A"]["active_task_id"], 1)
        self.assertEqual(failed["task_activity"]["nodes"]["A"]["completed"], 0)
        before = self.owned_state(runtime)
        runtime.observe()
        self.assertEqual(before, self.owned_state(runtime))
        runtime.retry_failed()
        runtime.run()
        self.assertEqual(runtime.observe()["outputs"]["items"][0]["value"], 1)

    def test_activity_counts_entire_task_table_beyond_queue_and_trace_windows(self):
        runtime = self.make(FRAMES_MODEL)
        for number in range(3):
            runtime.submit_frame([0], request_id=f"frame-{number}").wait(timeout=5)
        before = self.owned_state(runtime)
        view = runtime.observe(limit=1)
        activity = view["task_activity"]
        inputs = activity["controls"]["INPUT_BIT"]
        self.assertEqual((activity["total"], activity["pending"], activity["completed"]), (3, 3, 0))
        self.assertEqual((inputs["total"], inputs["pending"], inputs["completed"]), (3, 3, 0))
        self.assertEqual(inputs["queued_task_ids"], [1])
        self.assertTrue(inputs["queued_truncated"])
        self.assertEqual(inputs["last_task_id"], 3)
        self.assertEqual(inputs["last_task"]["payload"], {"frame_id": 3, "position": 0, "value": 0})
        self.assertEqual(inputs["last_task"]["frame_id"], 3)
        self.assertEqual(len(view["queues"][0]["tasks"]), 1)
        self.assertEqual(len(view["trace"]["items"]), 1)
        self.assertEqual(before, self.owned_state(runtime))
        self.assertFalse(activity["controls"]["PRE_ACCEPT"]["enabled"])
        runtime.step_work()
        active = runtime.observe(limit=1)["task_activity"]
        self.assertEqual((active["pending"], active["completed"], active["active_task_id"]), (2, 0, 1))
        self.assertEqual(active["controls"]["INPUT_BIT"]["active_task_id"], 1)
        self.assertEqual(active["controls"]["INPUT_BIT"]["last_phase"], "QUEUED")
        runtime.step()
        finished = runtime.observe(limit=1)["task_activity"]["controls"]
        self.assertEqual((finished["INPUT_BIT"]["pending"], finished["INPUT_BIT"]["completed"]), (2, 1))
        self.assertEqual(finished["STORE"]["pending"], 1)
        self.assertEqual(finished["STORE"]["completed"], 0)

    def test_activity_control_closed_loop_tracks_actual_fifo_facts(self):
        runtime = self.make(FRAMES_MODEL)
        runtime.submit_frame([0, 1], request_id="frame").wait(timeout=5)
        runtime.run()
        produced = runtime.observe()["task_activity"]
        self.assertEqual(produced["controls"]["INPUT_BIT"]["completed"], 2)
        self.assertEqual(produced["controls"]["STORE"]["completed"], 1)
        self.assertEqual(produced["nodes"]["frame_data"]["completed"], 2)
        self.assertEqual(produced["nodes"]["frame_marker"]["completed"], 1)
        self.assertEqual(produced["controls"]["FRAME_COMPLETE"]["total"], 0)
        self.assertEqual(produced["controls"]["ACK_ACT"]["total"], 0)
        runtime.read_frame_batches()
        received = runtime.observe()["task_activity"]["controls"]["FRAME_COMPLETE"]
        self.assertEqual((received["total"], received["pending"], received["completed"]), (1, 1, 0))
        self.assertEqual(received["last_task"]["payload"]["frame_id"], 1)
        self.assertFalse(runtime.observe()["frames"]["frames"][0]["qualified"])
        runtime.run()
        runtime.ack_frame(0, request_id="replay").wait(timeout=5)
        runtime.step()
        decoded = runtime.observe()["task_activity"]["controls"]
        self.assertEqual((decoded["ACK_DEC"]["completed"], decoded["ACK_ACT"]["pending"]), (1, 1))
        self.assertNotIn("frame_id", decoded["ACK_DEC"]["last_task"])
        self.assertEqual(decoded["ACK_ACT"]["last_task"]["frame_id"], 1)
        self.assertEqual(decoded["ACK_ACT"]["last_task"]["payload"]["ack"], 0)
        runtime.run()
        replayed = runtime.observe()["task_activity"]
        self.assertEqual(replayed["nodes"]["frame_data"]["total"], 4)
        self.assertEqual(replayed["nodes"]["frame_marker"]["total"], 2)
        self.assertEqual(replayed["nodes"]["frame_marker"]["last_task"]["payload"]["value"], 0)
        runtime.read_frame_batches()
        runtime.run()
        runtime.ack_frame(1, request_id="consume").wait(timeout=5)
        runtime.run()
        consumed = runtime.observe()
        self.assertEqual(consumed["task_activity"]["controls"]["ACK_ACT"]["completed"], 2)
        self.assertEqual(consumed["task_activity"]["controls"]["FRAME_COMPLETE"]["completed"], 2)
        self.assertTrue(consumed["frames"]["frames"][0]["consumed"])
        self.assertEqual(consumed["task_activity"]["total"], consumed["task_activity"]["completed"])
        control_traces = [item for item in consumed["trace"]["items"]
                          if item.get("task_info", {}).get("control") == "ACK_ACT"]
        self.assertTrue(control_traces)
        self.assertTrue(all(item["task_info"]["frame_id"] == 1 for item in control_traces))

    def test_ineligible_ack_does_not_invent_an_action_or_frame_binding(self):
        runtime = self.make(FRAMES_MODEL)
        runtime.submit_frame([0], request_id="frame").wait(timeout=5)
        runtime.run()
        runtime.ack_frame(1, request_id="too-early").wait(timeout=5)
        runtime.run()
        view = runtime.observe()
        controls = view["task_activity"]["controls"]
        self.assertEqual(controls["ACK_DEC"]["completed"], 1)
        self.assertEqual(controls["ACK_ACT"]["total"], 0)
        self.assertEqual(controls["FRAME_COMPLETE"]["total"], 0)
        self.assertNotIn("frame_id", controls["ACK_DEC"]["last_task"])
        self.assertFalse(view["frames"]["frames"][0]["qualified"])

    def test_business_node_activity_owns_frame_and_keeps_finish_a_normal_node(self):
        runtime = self.make(BUSINESS)
        runtime.submit_frame([1], request_id="frame").wait(timeout=5)
        runtime.run()
        before = self.owned_state(runtime)
        view = runtime.observe(limit=1)
        activity = view["task_activity"]
        for control in ("INPUT_BIT", "PRE_ACCEPT", "CLAIM", "STORE"):
            self.assertEqual(activity["controls"][control]["completed"], 1)
            self.assertEqual(activity["controls"][control]["last_task"]["frame_id"], 1)
        profile = next(profile for profile in runtime.current_model()["business_module"]["widths"]
                       if profile["input_width"] == 1)
        for node in profile["protected_nodes"]:
            summary = activity["nodes"][node]
            self.assertEqual((summary["total"], summary["completed"]), (1, 1), node)
            self.assertEqual(summary["last_task"]["frame_id"], 1, node)
            self.assertEqual(summary["last_task"]["kind"], "ex", node)
        self.assertNotIn("FINISH", activity["controls"])
        self.assertEqual(before, self.owned_state(runtime))
        # A similarly shaped key in a generic model is not evidence of ownership.
        generic = self.make()
        generic.send({"X0": 0, "X1": 1}, request_id="generic", key="jkcuda.frame:1").wait(timeout=5)
        generic.run()
        self.assertNotIn("frame_id", generic.observe()["task_activity"]["nodes"]["xor"]["last_task"])

    def test_transaction_internal_operations_are_not_counted_as_node_tasks(self):
        model = {"profile": "jkcuda.v6.1", "format_version": 1,
                 "queues": [{"name": "q", "priority": 1}],
                 "nodes": [{"id": "A", "queue": "q", "ex": "J0K1", "sources": {}},
                           {"id": "B", "queue": "q", "ex": "J0K(p)",
                            "sources": {"p": {"kind": "PARAM", "param": "p"}}}],
                 "transactions": [{"name": "twice", "queue": "q", "steps": [
                     {"node": "A"}, {"node": "B", "result_refs": {"p": 0}}]}]}
        runtime = self.make(model)
        runtime.submit_transaction("twice", request_id="tx").wait(timeout=5)
        runtime.run()
        view = runtime.observe()
        self.assertEqual(view["task_activity"]["total"], 1)
        self.assertEqual(view["task_activity"]["other"]["transaction"]["completed"], 1)
        self.assertEqual(view["task_activity"]["nodes"]["A"]["total"], 0)
        self.assertEqual(view["task_activity"]["nodes"]["B"]["total"], 0)
        internal = [item for item in view["trace"]["items"] if item["kind"] == "commit"]
        self.assertEqual([item["node"] for item in internal], ["A", "B"])
        self.assertTrue(all(item["task_info"]["kind"] == "transaction" for item in internal))

    def test_activity_identifies_cumulative_node_generations_explicitly(self):
        original = {"profile": "jkcuda.v6.1", "format_version": 1,
                    "queues": [{"name": "control", "priority": 0}, {"name": "work", "priority": 1}],
                    "nodes": [{"id": "A", "queue": "work", "ex": "J0K1", "sources": {}},
                              {"id": "keep", "queue": "work", "ex": "J0K0", "sources": {}}],
                    "entrypoints": ["A"]}
        runtime = self.make(original)
        runtime.submit("A", request_id="old").wait(timeout=5)
        retired = copy.deepcopy(original)
        retired["nodes"] = retired["nodes"][1:]
        retired["entrypoints"] = []
        runtime.modify(retired, queue="control", request_id="retire").wait(timeout=5)
        runtime.step()
        old = runtime.observe()["task_activity"]["nodes"]["A"]
        self.assertFalse(old["installed"])
        self.assertIsNone(old["current_generation"])
        self.assertEqual(old["pending"], 1)
        reused = copy.deepcopy(original)
        reused["nodes"][0]["generation"] = 2
        runtime.modify(reused, queue="control", request_id="reuse").wait(timeout=5)
        runtime.step()
        runtime.submit("A", request_id="new").wait(timeout=5)
        runtime.run()
        view = runtime.observe()
        node = view["task_activity"]["nodes"]["A"]
        self.assertEqual(node["scope"], "logical_id_all_generations")
        self.assertEqual((node["current_generation"], node["total"], node["completed"]), (2, 2, 2))
        self.assertEqual(node["last_task"]["generation"], 2)
        self.assertEqual(view["task_activity"]["other"]["structure"]["completed"], 2)


if __name__ == "__main__":
    unittest.main()
