"""Admission/maintenance failures must not publish partial model requests."""
import copy
import unittest
from unittest import mock

from jkcuda.backend import BackpressureError, Core
from jkcuda.model import load_model


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.model = load_model({"profile": "jkcuda.v6.1", "format_version": 1,
                                 "queues": [{"name": "q", "priority": 1}],
                                 "nodes": [{"id": "n", "queue": "q", "ex": "J0K(p)",
                                            "sources": {"p": {"kind": "PARAM", "param": "p"}},
                                            "output": "Y"}]})

    def test_failed_transfer_rolls_back_entire_admission(self):
        core = Core(self.model)
        before = core.logical_state()
        with mock.patch.object(core, "_upload", side_effect=BackpressureError("injected allocation failure")):
            with self.assertRaises(BackpressureError):
                core.enqueue([{"node": "n", "params": {"p": 0}, "key": "new"},
                              {"node": "n", "params": {"p": 1}}])
        self.assertEqual(core.logical_state(), before)
        self.assertEqual(core.enqueue([{"node": "n", "params": {"p": 1}}]), [1])
        core.advance(max_tasks=100)
        self.assertEqual([record["value"] for record in core.outputs()], [1])

    def test_failed_growth_keeps_original_runtime_usable(self):
        core = Core(self.model)
        core.enqueue([{"node": "n", "params": {"p": 0}}])
        before = core.logical_state()
        with mock.patch.object(core, "_allocate", side_effect=MemoryError("injected")):
            with self.assertRaises(MemoryError):
                core.grow({"tasks": 8192})
        self.assertEqual(core.logical_state(), before)
        core.advance(max_tasks=100)
        self.assertEqual([record["value"] for record in core.outputs()], [0])

    def test_failed_structure_preparation_is_not_installed_or_queued(self):
        core = Core(self.model)
        candidate = copy.deepcopy(self.model)
        candidate["nodes"][0]["version"] = 2
        candidate["nodes"][0]["ex"] += "K1"
        candidate["nodes"][0].pop("ops")
        before = core.logical_state()
        with mock.patch.object(core, "_allocate", side_effect=MemoryError("injected")):
            with self.assertRaises(MemoryError):
                core.modify(candidate, queue="q")
        self.assertEqual(core.logical_state(), before)
        self.assertEqual(core.current_model(), self.model)

    def test_native_request_ownership_and_immutable_payload_must_agree(self):
        core = Core(self.model)
        zero = [{"node": "n", "params": {"p": 0}, "key": "frame"}]
        one = [{"node": "n", "params": {"p": 1}, "key": "frame"}]
        first = core.enqueue(zero); second = core.enqueue(one)
        core.bind_request(first, "zero"); core.bind_request(second, "one")
        self.assertTrue(core.validate_request(first, zero, "zero"))
        with self.assertRaises(ValueError):
            core.validate_request(second, zero, "zero")
        with self.assertRaises(ValueError):
            core.validate_request(first, one, "zero")
        with self.assertRaises(ValueError):
            core.bind_request(second, "zero")
        restored = Core.from_dump(self.model, core.dump())
        self.assertTrue(restored.validate_request(first, zero, "zero"))

    def test_transaction_request_checks_internal_dependencies_and_queue(self):
        core = Core(self.model)
        requests = [{"transaction": [{"node": "n", "params": {"p": 1}},
                                      {"node": "n", "result_refs": {"p": 0}}],
                     "queue": "q", "contract": "chain"}]
        ids = core.enqueue(requests); core.bind_request(ids, "tx")
        self.assertTrue(core.validate_request(ids, requests, "tx"))
        changed = copy.deepcopy(requests)
        changed[0]["transaction"][1] = {"node": "n", "params": {"p": 0}}
        with self.assertRaises(ValueError):
            core.validate_request(ids, changed, "tx")
        changed = copy.deepcopy(requests); changed[0]["contract"] = "different"
        with self.assertRaises(ValueError):
            core.validate_request(ids, changed, "tx")

    def test_structure_request_matches_the_prepared_candidate(self):
        core = Core(self.model)
        candidate = copy.deepcopy(self.model)
        candidate["nodes"][0]["version"] = 2
        candidate["nodes"][0]["ex"] += "K1"
        candidate["nodes"][0].pop("ops")
        ids = [core.modify(candidate, queue="q")]
        core.bind_request(ids, "change")
        self.assertTrue(core.validate_request(ids, [{"_structure": candidate, "queue": "q"}], "change"))
        with self.assertRaises(ValueError):
            core.validate_request(ids, [{"_structure": self.model, "queue": "q"}], "change")

    def test_frame_request_checks_bits_ack_and_completion_batch_identity(self):
        from tests.test_frames_semantics import frame_model
        from jkcuda.frames import Frames
        core = Core(frame_model())
        frames = Frames(core)
        response = frames.submit_frame([0, 1]); ids = response["task_ids"]
        core.bind_request(ids, "frame")
        self.assertTrue(core.validate_request(ids, [{"_frame": [0, 1]}], "frame"))
        with self.assertRaises(ValueError):
            core.validate_request(ids, [{"_frame": [1, 0]}], "frame")
        core.advance(max_work=10000, max_tasks=100)
        batch = frames.batches()[0]
        complete = frames.received_batch(batch["batch_id"])
        core.bind_request(complete, "complete")
        self.assertTrue(core.validate_request(complete, [{"_frame_complete": batch["batch_id"]}], "complete"))
        with self.assertRaises(ValueError):
            core.validate_request(complete, [{"_frame_complete": batch["batch_id"] + 1}], "complete")
        ack = frames.ack(0); core.bind_request(ack, "ack")
        self.assertTrue(core.validate_request(ack, [{"_frame_ack": 0}], "ack"))
        with self.assertRaises(ValueError):
            core.validate_request(ack, [{"_frame_ack": 1}], "ack")

    def test_state_version_exhaustion_does_not_wrap_or_commit(self):
        model = copy.deepcopy(self.model)
        model["states"] = [{"id": "s", "initial": 0}]
        model["nodes"][0]["state"] = "s"
        model = load_model(model)
        core = Core(model)
        core.enqueue([{"node": "n", "params": {"p": 1}}])
        snapshot = core.dump()
        snapshot["logical"]["sections"]["states"][0][1] = 2**63 - 1
        restored = Core.from_dump(model, snapshot)
        status = restored.advance(max_tasks=100)
        self.assertEqual(status["reason"], "version_exhausted")
        self.assertEqual(status["states"]["s"], {"value": 0, "version": 2**63 - 1})
        self.assertEqual(restored.outputs(), [])


if __name__ == "__main__":
    unittest.main()
