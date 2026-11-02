"""Independent frame/ACK expectations from V6.1 S01–S03.

ACK0 replay/ACK1 consume and stale-action rules are retained from the module's
§13.4 and qualification table. Expected payloads, queue ordering and ownership
are stated directly; no production matching/qualification helper is reused.
"""

from copy import deepcopy
import os
import unittest

from jkcuda.backend import Core, BackpressureError
from jkcuda.frames import Frames, FrameError
from jkcuda.model import load_model


TEST_DEVICE = os.environ.get("JKCUDA_TEST_DEVICE", "native-cpu")

def frame_model(*, capacity=2, max_width=128):
    return load_model({
        "profile": "jkcuda.v6.1", "format_version": 1,
        "queues": [{"name": "input", "priority": 1}, {"name": "ram", "priority": 2}],
        "nodes": [
            {"id": "data", "queue": "ram", "ex": "J0K(bit)",
             "sources": {"bit": {"kind": "PARAM", "param": "bit"}},
             "output": "DATA"},
            {"id": "marker", "queue": "ram", "ex": "J0K(flag)",
             "sources": {"flag": {"kind": "PARAM", "param": "flag"}},
             "output": "FRAME_OUT"}],
        "frame_module": {"input_queue": "input", "queue": "ram",
                         "data_node": "data", "data_param": "bit",
                         "marker_node": "marker", "marker_param": "flag",
                         "block_capacity": capacity, "max_width": max_width}})


def make_frames(**options):
    model = frame_model(**options)
    core = Core(model, device=TEST_DEVICE)
    return model, core, Frames(core)


def run(core, tasks=10000):
    status = core.advance(max_work=100000, max_tasks=tasks)
    if status["status"] != "ready":
        raise AssertionError("unexpected stopped frame runtime: " + repr(status))
    return status


def frame_state(frames, frame_id):
    return next(item for item in frames.state()["frames"] if item["frame_id"] == frame_id)


def receive_and_qualify(core, frames, batch):
    frames.received_batch(batch["batch_id"])
    run(core)


class FrameSemanticsTests(unittest.TestCase):
    def restore(self, model, core):
        frozen = deepcopy(core.dump())
        restored = Core.from_dump(model, frozen, device=TEST_DEVICE)
        frames = Frames(restored)
        self.assertEqual(restored.trace(), core.trace())
        self.assertEqual(restored.outputs(), core.outputs())
        return restored, frames

    def test_input_acceptance_latches_payload_without_frame_business_effects(self):
        _, core, frames = make_frames()
        payload = [0, 1, 0]
        accepted = frames.submit_frame(payload)
        payload[:] = [1, 0, 1]
        before = frame_state(frames, accepted["frame_id"])
        self.assertEqual(before["arrived"], 0)
        self.assertFalse(before["stored"])
        self.assertFalse(before["qualified"])
        self.assertIsNone(before["block_id"])
        self.assertIsNone(frames.state()["head"])
        self.assertEqual(frames.batches(), [])
        self.assertEqual(core.outputs(), [])
        self.assertEqual([row["kind"] for row in core.trace()], ["enqueue"] * 3)
        run(core, 1)
        first = frame_state(frames, accepted["frame_id"])
        self.assertEqual(first["arrived"], 1)
        self.assertFalse(first["stored"])
        self.assertEqual(frames.batches(), [])
        run(core)
        self.assertEqual(frames.batches()[0]["values"], [0, 1, 0])
        self.assertEqual(frames.batches()[0]["marker"], 1)

    def test_widths_and_zero_payload_keep_exact_data_before_marker(self):
        for width in (1, 8, 9, 65):
            with self.subTest(width=width):
                _, core, frames = make_frames(max_width=128)
                bits = [0] * width
                accepted = frames.submit_frame(bits)
                self.assertEqual(len(accepted["task_ids"]), width)
                run(core)
                batch = frames.batches()[0]
                self.assertEqual(batch["width"], width)
                self.assertEqual(batch["values"], bits)
                self.assertEqual(batch["marker"], 1)
                self.assertFalse(batch["replay"])
                self.assertEqual([(item["port"], item["value"]) for item in core.outputs()],
                                 [("DATA", 0)] * width + [("FRAME_OUT", 1)])
                self.assertLess(max(batch["data_output_ids"]), batch["marker_output_id"])

    def test_receipt_only_enqueues_completion_and_is_idempotent(self):
        _, core, frames = make_frames()
        frame_id = frames.submit_frame([0, 1])["frame_id"]
        run(core)
        batch = frames.batches()[0]
        before = deepcopy(frame_state(frames, frame_id))
        trace = core.trace()
        control = frames.received_batch(batch["batch_id"])
        self.assertEqual(frame_state(frames, frame_id), before)
        self.assertFalse(frame_state(frames, frame_id)["qualified"])
        self.assertEqual(core.trace()[:-1], trace)
        self.assertEqual(core.trace()[-1]["kind"], "enqueue")
        pending_trace = core.trace()
        self.assertEqual(frames.received_batch(batch["batch_id"]), control)
        self.assertEqual(core.trace(), pending_trace)
        run(core, 1)
        self.assertTrue(frame_state(frames, frame_id)["qualified"])
        self.assertEqual(frame_state(frames, frame_id)["token"], batch["token"])
        self.assertTrue(frames.batches()[0]["received"])

    def test_reserved_control_credit_survives_ordinary_input_backpressure(self):
        model = frame_model()
        core = Core(model, device=TEST_DEVICE, capacities={"tasks": 5})
        frames = Frames(core)
        identity = frames.submit_frame([0])["frame_id"]
        run(core)  # INPUT_BIT, STORE, DATA, MARKER; one task slot reserved for COMPLETE.
        self.assertEqual(core.status()["completed"], 4)
        self.assertEqual(frames.state()["completion_reserved"], 1)
        frozen = core.logical_state()
        with self.assertRaises(BackpressureError):
            frames.submit_frame([1])
        self.assertEqual(core.logical_state(), frozen)
        batch = frames.batches()[0]
        frames.received_batch(batch["batch_id"])
        self.assertEqual(frames.state()["completion_reserved"], 0)
        self.assertFalse(frame_state(frames, identity)["qualified"])
        run(core)
        self.assertTrue(frame_state(frames, identity)["qualified"])

    def test_partial_output_cannot_be_acknowledged_as_received(self):
        _, core, frames = make_frames()
        frames.submit_frame([0, 1])
        run(core, 4)  # two input tasks, STORE, first DATA; second DATA/marker pending.
        self.assertEqual(len(core.outputs()), 1)
        self.assertEqual(frames.batches(), [])
        before = core.logical_state()
        with self.assertRaises(FrameError):
            frames.received_batch(1)  # The module's first allocated batch identity.
        self.assertEqual(core.logical_state(), before)

    def test_early_ack_zero_and_one_finish_without_waiting_for_future_qualification(self):
        for ack in (0, 1):
            with self.subTest(ack=ack):
                _, core, frames = make_frames()
                frame_id = frames.submit_frame([0])["frame_id"]
                frames.ack(ack)
                run(core)
                self.assertIsNone(core.status()["active_task"])
                self.assertEqual(core.status()["pending"], 0)
                self.assertFalse(frame_state(frames, frame_id)["consumed"])
                self.assertFalse(frame_state(frames, frame_id)["qualified"])
                self.assertEqual(len(frames.batches()), 1)
                receive_and_qualify(core, frames, frames.batches()[0])
                self.assertTrue(frame_state(frames, frame_id)["qualified"])
                self.assertFalse(frame_state(frames, frame_id)["consumed"])
                self.assertEqual(len(frames.batches()), 1)

    def test_decision_uses_fifo_decode_time_qualification(self):
        for completion_first in (False, True):
            with self.subTest(completion_first=completion_first):
                _, core, frames = make_frames()
                frame_id = frames.submit_frame([1])["frame_id"]
                run(core)
                batch = frames.batches()[0]
                if completion_first:
                    frames.received_batch(batch["batch_id"])
                    frames.ack(1)
                else:
                    frames.ack(1)
                    frames.received_batch(batch["batch_id"])
                run(core)
                observed = frame_state(frames, frame_id)
                self.assertEqual(observed["consumed"], completion_first)
                self.assertEqual(observed["qualified"], not completion_first)

    def test_two_actions_bound_to_one_frame_cannot_consume_successor(self):
        _, core, frames = make_frames()
        first = frames.submit_frame([0])["frame_id"]
        second = frames.submit_frame([1])["frame_id"]
        run(core)
        receive_and_qualify(core, frames, frames.batches()[0])
        frames.ack(1)
        frames.ack(1)
        run(core, 1)  # DEC1 binds the qualified first frame and appends ACT1.
        run(core, 1)  # DEC2 precedes ACT1, so it binds the same first frame.
        self.assertFalse(frame_state(frames, first)["consumed"])
        self.assertFalse(frame_state(frames, second)["consumed"])
        run(core, 1)  # ACT1 consumes its exact bound identity.
        self.assertTrue(frame_state(frames, first)["consumed"])
        self.assertEqual(frames.state()["head"], second)
        run(core, 1)  # ACT2 must be a stale no-op, even with a new head present.
        self.assertFalse(frame_state(frames, second)["consumed"])
        self.assertEqual(frames.state()["head"], second)
        run(core)
        self.assertEqual([(batch["frame_id"], batch["values"], batch["marker"])
                          for batch in frames.batches()], [(first, [0], 1), (second, [1], 1)])

    def test_replay_owns_payload_and_late_completion_cannot_revive_consumed_frame(self):
        _, core, frames = make_frames()
        first = frames.submit_frame([0, 0])["frame_id"]
        second = frames.submit_frame([1, 1])["frame_id"]
        run(core)
        original = frames.batches()[0]
        receive_and_qualify(core, frames, original)
        token = frame_state(frames, first)["token"]
        frames.ack(0)
        frames.ack(1)
        run(core)
        batches = frames.batches()
        self.assertEqual([(batch["frame_id"], batch["values"], batch["marker"])
                          for batch in batches], [(first, [0, 0], 1), (first, [0, 0], 0), (second, [1, 1], 1)])
        replay, following = batches[1:]
        self.assertNotEqual(original["batch_id"], replay["batch_id"])
        self.assertEqual(original["generation"], replay["generation"])
        self.assertEqual(replay["token"], token)
        self.assertTrue(replay["replay"])
        self.assertTrue(frame_state(frames, first)["consumed"])
        self.assertFalse(frame_state(frames, first)["qualified"])
        receive_and_qualify(core, frames, following)
        second_before = deepcopy(frame_state(frames, second))
        frames.received_batch(replay["batch_id"])
        run(core)
        self.assertTrue(frame_state(frames, first)["consumed"])
        self.assertFalse(frame_state(frames, first)["qualified"])
        self.assertEqual(frame_state(frames, second), second_before)
        self.assertEqual(frames.batches()[1]["values"], [0, 0])

    def test_repeated_identical_frames_keep_distinct_identities(self):
        _, core, frames = make_frames()
        first = frames.submit_frame([0, 0])["frame_id"]
        second = frames.submit_frame([0, 0])["frame_id"]
        self.assertNotEqual(first, second)
        run(core)
        receive_and_qualify(core, frames, frames.batches()[0])
        frames.ack(1)
        run(core)
        self.assertEqual([(batch["frame_id"], batch["values"]) for batch in frames.batches()],
                         [(first, [0, 0]), (second, [0, 0])])
        self.assertNotEqual(frames.batches()[0]["data_output_ids"], frames.batches()[1]["data_output_ids"])

    def test_repeated_ack_zero_keeps_qualification_and_distinct_replay_batches(self):
        _, core, frames = make_frames()
        identity = frames.submit_frame([0, 1])["frame_id"]
        run(core)
        receive_and_qualify(core, frames, frames.batches()[0])
        token = frame_state(frames, identity)["token"]
        frames.ack(0)
        frames.ack(0)
        run(core)
        self.assertTrue(frame_state(frames, identity)["qualified"])
        self.assertFalse(frame_state(frames, identity)["consumed"])
        self.assertEqual(frame_state(frames, identity)["token"], token)
        batches = frames.batches()
        self.assertEqual([batch["values"] for batch in batches], [[0, 1], [0, 1], [0, 1]])
        self.assertEqual([batch["marker"] for batch in batches], [1, 0, 0])
        self.assertEqual(len({batch["batch_id"] for batch in batches}), 3)

    def test_alternating_widths_keep_each_frames_own_payload(self):
        _, core, frames = make_frames()
        payloads = [[0], [1, 0] * 4, [0, 1, 1] * 3]
        identities = [frames.submit_frame(payload)["frame_id"] for payload in payloads]
        run(core)
        for index in range(2):
            receive_and_qualify(core, frames, frames.batches()[index])
            frames.ack(1)
            run(core)
        self.assertEqual([(batch["frame_id"], batch["width"], batch["values"])
                          for batch in frames.batches()],
                         [(identity, len(payload), payload) for identity, payload in zip(identities, payloads)])

    def test_resource_wait_keeps_store_active_and_admitted_input_waiting(self):
        model = frame_model()
        core = Core(model, device=TEST_DEVICE, capacities={"tasks": 4})
        frames = Frames(core)
        first = frames.submit_frame([0])["frame_id"]
        core.advance(max_work=100000, max_tasks=10000)
        stopped = core.status()
        self.assertEqual(stopped["status"], "resource_wait")
        self.assertIsNotNone(stopped["active_task"])
        self.assertFalse(frame_state(frames, first)["stored"])
        second = frames.submit_frame([1])["frame_id"]
        core.advance(max_work=100000, max_tasks=10000)
        self.assertEqual(core.status()["active_task"], stopped["active_task"])
        self.assertEqual(frame_state(frames, second)["arrived"], 0)
        self.assertEqual(core.outputs(), [])
        core.grow({"tasks": 32})
        run(core)
        self.assertTrue(frame_state(frames, first)["stored"])
        self.assertTrue(frame_state(frames, second)["stored"])
        self.assertEqual([(batch["frame_id"], batch["values"]) for batch in frames.batches()], [(first, [0])])

    def test_full_block_reuse_requires_consumption_and_no_batch_holders(self):
        _, core, frames = make_frames(capacity=1)
        first = frames.submit_frame([0])["frame_id"]
        run(core)
        receive_and_qualify(core, frames, frames.batches()[0])
        frames.ack(0)
        run(core)
        replay = frames.batches()[1]
        frames.ack(1)
        run(core)
        old = deepcopy(frame_state(frames, first))
        self.assertTrue(old["consumed"])
        self.assertEqual(old["held_batches"], 1)
        second = frames.submit_frame([1])["frame_id"]
        run(core)
        self.assertNotEqual(frame_state(frames, second)["block_id"], old["block_id"])
        frames.received_batch(replay["batch_id"])
        run(core)
        third = frames.submit_frame([0])["frame_id"]
        run(core)
        recycled = frame_state(frames, third)
        self.assertEqual(recycled["block_id"], old["block_id"])
        self.assertEqual(recycled["slot"], 0)
        self.assertEqual(recycled["slot_generation"], old["slot_generation"] + 1)
        self.assertNotEqual(recycled["frame_id"], first)

    def test_partial_block_uses_remaining_slots_before_generation_reuse(self):
        _, core, frames = make_frames(capacity=2)
        first = frames.submit_frame([0])["frame_id"]
        run(core)
        receive_and_qualify(core, frames, frames.batches()[0])
        frames.ack(1)
        run(core)
        before = frame_state(frames, first)
        second = frames.submit_frame([1])["frame_id"]
        run(core)
        after = frame_state(frames, second)
        self.assertEqual(after["block_id"], before["block_id"])
        self.assertEqual(after["slot"], 1)
        self.assertEqual(after["slot_generation"], before["slot_generation"])

    def test_invalid_frame_and_ack_reject_atomically(self):
        _, core, frames = make_frames(max_width=8)
        for payload in ([], [0, 2], [True], [0] * 9):
            before = core.logical_state()
            with self.assertRaises(FrameError):
                frames.submit_frame(payload)
            self.assertEqual(core.logical_state(), before)
        for value in (-1, 2, True):
            before = core.logical_state()
            with self.assertRaises(FrameError):
                frames.ack(value)
            self.assertEqual(core.logical_state(), before)

    def test_restore_preserves_two_decoded_actions_and_multiple_frame_ids(self):
        model, core, frames = make_frames()
        first = frames.submit_frame([0, 1])["frame_id"]
        second = frames.submit_frame([1, 0])["frame_id"]
        run(core)
        receive_and_qualify(core, frames, frames.batches()[0])
        frames.ack(1)
        frames.ack(1)
        run(core, 2)
        self.assertFalse(frame_state(frames, first)["consumed"])
        before = frames.state()
        core, frames = self.restore(model, core)
        self.assertEqual(frames.state(), before)
        run(core, 1)
        self.assertTrue(frame_state(frames, first)["consumed"])
        self.assertEqual(frames.state()["head"], second)
        core, frames = self.restore(model, core)
        run(core)
        self.assertFalse(frame_state(frames, second)["consumed"])
        self.assertEqual([(batch["frame_id"], batch["values"]) for batch in frames.batches()],
                         [(first, [0, 1]), (second, [1, 0])])
        second_batch = frames.batches()[1]
        receive_and_qualify(core, frames, second_batch)
        core, frames = self.restore(model, core)
        self.assertTrue(frame_state(frames, second)["qualified"])

    def test_restore_after_k_one_reuse_preserves_old_frame_and_batch_identities(self):
        model, core, frames = make_frames(capacity=1)
        first = frames.submit_frame([0])["frame_id"]
        run(core)
        old_batch = frames.batches()[0]
        receive_and_qualify(core, frames, old_batch)
        frames.ack(1)
        run(core)
        second = frames.submit_frame([1])["frame_id"]
        run(core)
        self.assertEqual(frame_state(frames, second)["slot_generation"], 2)
        before = frames.state()
        batches = frames.batches()
        core, frames = self.restore(model, core)
        self.assertEqual(frames.state(), before)
        self.assertEqual(frames.batches(), batches)
        self.assertTrue(frame_state(frames, first)["consumed"])
        self.assertFalse(frame_state(frames, second)["consumed"])
        frames.received_batch(old_batch["batch_id"])
        run(core)
        self.assertFalse(frame_state(frames, first)["qualified"])
        self.assertFalse(frame_state(frames, second)["qualified"])

    def test_input_and_store_fault_capsules_do_not_duplicate_arrival_or_batch(self):
        for stage in ("input", "store"):
            for point in ("before_commit", "after_commit"):
                with self.subTest(stage=stage, point=point):
                    model, core, frames = make_frames()
                    identity = frames.submit_frame([0])["frame_id"]
                    if stage == "store":
                        run(core, 1)
                    core.set_fault(point)
                    core.advance(max_work=100000, max_tasks=10000)
                    self.assertEqual(core.status()["status"], "failed")
                    self.assertEqual(frame_state(frames, identity)["arrived"],
                                     0 if stage == "input" and point == "before_commit" else 1)
                    if stage == "store":
                        self.assertEqual(frame_state(frames, identity)["stored"], point == "after_commit")
                    frozen = frames.state()
                    core, frames = self.restore(model, core)
                    self.assertEqual(frames.state(), frozen)
                    core.retry()
                    run(core)
                    self.assertEqual(frame_state(frames, identity)["arrived"], 1)
                    self.assertEqual(len(frames.batches()), 1)
                    self.assertEqual(frames.batches()[0]["values"], [0])

    def test_completion_fault_capsule_applies_qualification_and_releases_holder_once(self):
        for point in ("before_commit", "after_commit"):
            with self.subTest(point=point):
                model, core, frames = make_frames()
                identity = frames.submit_frame([1, 0])["frame_id"]
                run(core)
                batch = frames.batches()[0]
                frames.received_batch(batch["batch_id"])
                core.set_fault(point)
                core.advance(max_work=100000, max_tasks=10000)
                self.assertEqual(core.status()["status"], "failed")
                self.assertEqual(frame_state(frames, identity)["qualified"], point == "after_commit")
                core, frames = self.restore(model, core)
                core.retry()
                run(core)
                self.assertTrue(frame_state(frames, identity)["qualified"])
                self.assertEqual(frame_state(frames, identity)["held_batches"], 0)
                self.assertEqual(frames.state()["blocks"][0]["held_batches"], 0)
                self.assertEqual(len(frames.batches()), 1)

    def test_partial_output_commit_resume_preserves_exactly_one_record_per_position(self):
        model, core, frames = make_frames()
        identity = frames.submit_frame([0, 1])["frame_id"]
        run(core, 3)  # two input tasks, then the registered STORE task
        core.set_fault("after_commit")
        core.advance(max_work=100000, max_tasks=10000)
        self.assertEqual(core.status()["status"], "failed")
        self.assertEqual([(output["port"], output["value"]) for output in core.outputs()], [("DATA", 0)])
        self.assertEqual(frames.batches(), [])
        core, frames = self.restore(model, core)
        core.retry()
        run(core)
        batch = frames.batches()[0]
        self.assertEqual(batch["frame_id"], identity)
        self.assertEqual(batch["values"], [0, 1])
        self.assertEqual(batch["marker"], 1)
        self.assertEqual(len(set(batch["data_output_ids"] + [batch["marker_output_id"]])), 3)
        self.assertEqual([(output["port"], output["value"]) for output in core.outputs()],
                         [("DATA", 0), ("DATA", 1), ("FRAME_OUT", 1)])


if __name__ == "__main__":
    unittest.main()
