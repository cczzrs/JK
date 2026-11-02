from pathlib import Path
import tempfile
import unittest
from unittest import mock

from jkcuda import Runtime
from jkcuda.persistence import RecoveryError, read_checkpoint, write_checkpoint

MODEL = Path(__file__).parents[1] / "examples/cuda/frames.json"


class FrameRuntimeTests(unittest.TestCase):
    def make(self, **kwargs):
        runtime = Runtime(MODEL, device="native-cpu", work_slice=1, **kwargs)
        self.addCleanup(runtime.close)
        return runtime

    def test_host_receipt_only_enqueues_control_then_ack_replays_and_consumes(self):
        runtime = self.make()
        ticket = runtime.submit_frame([0, 1, 0], request_id="frame").wait(timeout=5)
        self.assertEqual(len(ticket.task_ids), 3)
        self.assertEqual(runtime.status()["completed"], 0)
        runtime.run()
        before = runtime.status()["completed"]
        batches = runtime.read_frame_batches()
        self.assertEqual(len(batches), 1)
        self.assertEqual(batches[0]["values"], [0, 1, 0])
        self.assertEqual(batches[0]["marker"], 1)
        self.assertIsNotNone(batches[0]["completion_task_id"])
        self.assertEqual(runtime.status()["completed"], before)
        self.assertEqual(runtime.status()["pending"], 1)
        runtime.run()  # FRAME_COMPLETE establishes qualification.
        runtime.ack_frame(0, request_id="replay").wait(timeout=5)
        runtime.run()
        replay = runtime.read_frame_batches()[-1]
        self.assertEqual(replay["frame_id"], ticket.details["frame_id"])
        self.assertEqual(replay["values"], [0, 1, 0])
        self.assertEqual(replay["marker"], 0)
        self.assertTrue(replay["replay"])
        self.assertNotEqual(replay["batch_id"], batches[0]["batch_id"])
        runtime.run()
        runtime.ack_frame(1, request_id="consume").wait(timeout=5)
        runtime.run()
        completed = runtime.status()["completed"]
        runtime.ack_frame(1, request_id="stale").wait(timeout=5)
        runtime.run()
        # No qualified frame: DEC alone completes, without another ACT/output.
        self.assertEqual(runtime.status()["completed"], completed + 1)
        self.assertEqual(len(runtime.read_frame_batches()), 2)

    def test_frame_wal_snapshot_preserves_queued_completion_and_output_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self.make(durable_path=Path(directory) / "frame.wal")
            values = [0, 1] * 5
            runtime.submit_frame(values, request_id="wide").wait("durable", 5)
            runtime.run()
            original = runtime.read_frame_batches()
            self.assertEqual(runtime.status()["pending"], 1)
            path = Path(directory) / "frame.json"
            runtime.snapshot(path)
            restored = Runtime.restore_runtime(path, device="native-cpu")
            self.addCleanup(restored.close)
            self.assertTrue(restored.status()["paused"])
            self.assertEqual(restored.read_frame_batches(), original)
            self.assertEqual(restored.status()["pending"], 1)  # no duplicated completion
            self.assertEqual(restored.read_output(), runtime.read_output())
            restored.run()
            restored.ack_frame(1, request_id="consume").wait(timeout=5)
            restored.run()
            for output_id in original[0]["output_ids"]:
                restored.ack_output(output_id)
            self.assertEqual(restored.read_frame_batches(), [])

    def test_marker_completing_between_handoff_capture_and_read_is_not_exposed(self):
        for method in ("read_output", "read_frame_batches"):
            with self.subTest(method=method):
                runtime = self.make()
                runtime.submit_frame([0], request_id="race").wait(timeout=5)
                prepare = runtime._prepare_frame_handoffs
                def concurrent_completion():
                    frontier = prepare()  # No complete batch at this cut.
                    runtime.run()         # A producer completes a marker before the read lock.
                    return frontier
                with mock.patch.object(runtime, "_prepare_frame_handoffs", side_effect=concurrent_completion):
                    self.assertEqual(getattr(runtime, method)(), [])
                self.assertIsNone(runtime._frame_module().batches()[0]["completion_task_id"])
                self.assertTrue(getattr(runtime, method)())
                self.assertIsNotNone(runtime._frame_module().batches()[0]["completion_task_id"])

    def test_restored_ticket_frame_identity_must_match_its_actual_input_tasks(self):
        runtime = self.make()
        runtime.submit_frame([0, 1], request_id="frame").wait(timeout=5)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wrong-frame.json"
            runtime.snapshot(path)
            payload = read_checkpoint(path)
            payload["tickets"]["frame"]["details"]["frame_id"] += 1
            write_checkpoint(path, payload)
            with self.assertRaises(RecoveryError):
                Runtime.restore_runtime(path, device="native-cpu")


if __name__ == "__main__":
    unittest.main()
