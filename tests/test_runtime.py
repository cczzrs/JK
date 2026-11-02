import copy
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest import mock

from jkcuda import Runtime
from jkcuda.model import load_model, digest
from jkcuda.persistence import Journal, RecoveryError, read_checkpoint, write_checkpoint

EXAMPLE = Path(__file__).parents[1] / "examples" / "cuda" / "xor.json"


class RuntimeTests(unittest.TestCase):
    def make(self, **options):
        runtime = Runtime(EXAMPLE, device="native-cpu", **options)
        self.addCleanup(runtime.close)
        return runtime

    def test_send_latches_declared_order_and_deduplicates_identity(self):
        runtime = self.make(work_slice=1)
        values = {"X1": 0, "X0": 1}
        ticket = runtime.send(values, request_id="a").wait("accepted", 5)
        values["X0"] = 0
        self.assertEqual(runtime.status()["completed"], 0)
        self.assertEqual(runtime.trace()[0]["node"], "A")
        self.assertEqual(runtime.trace()[1]["node"], "B")
        self.assertIs(runtime.send({"X0": 1, "X1": 0}, request_id="a"), ticket)
        with self.assertRaises(ValueError):
            runtime.send({"X0": 0, "X1": 0}, request_id="a")
        self.assertEqual(runtime.step()["completed"], 1)
        self.assertEqual(runtime.run()["completed"], 3)
        self.assertEqual([r["value"] for r in runtime.read_output()], [1])

    def test_repeated_values_are_distinct_and_output_callback_is_unlocked(self):
        runtime = self.make(work_slice=1)
        runtime.send({"X0": 0, "X1": 0}, request_id="first").wait(timeout=5)
        runtime.run()
        def callback(record):
            runtime.send({"X0": 0, "X1": 0}, request_id="second").wait(timeout=5)
            self.assertEqual(record["value"], 0)
        self.assertEqual(runtime.drain(callback), 1)
        runtime.run()
        records = runtime.read_output()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["value"], 0)
        original = records[0]["output_id"]
        def fails(_):
            raise ValueError("application failed")
        with self.assertRaises(ValueError):
            runtime.drain(fails)
        self.assertEqual(runtime.read_output()[0]["output_id"], original)

    def test_snapshot_owned_input_matcher_and_paused_restore(self):
        runtime = self.make()
        runtime.send({"X0": 0}, request_id="left", key="frame").wait(timeout=5)
        runtime.run()
        runtime.send({"X1": 1}, request_id="right", key="frame").wait(timeout=5)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.json"
            runtime.snapshot(path)
            restored = Runtime.restore_runtime(path, device="native-cpu")
            self.addCleanup(restored.close)
            self.assertTrue(restored.status()["paused"])
            self.assertEqual(restored.status()["completed"], 1)
            self.assertEqual(restored.fingerprint(), runtime.fingerprint())
            restored.run()
            runtime.run()
            self.assertEqual(restored.trace(), runtime.trace())
            self.assertEqual(restored.read_output(), runtime.read_output())

    def test_active_capsule_after_commit_resumes_without_recommit(self):
        runtime = self.make()
        runtime.send({"X0": 1, "X1": 0}, request_id="pair").wait(timeout=5)
        runtime._core.set_fault("after_commit")
        status = runtime.step()
        self.assertEqual(status["reason"], "injected_fault")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "active.json"
            with self.assertRaises(RuntimeError):
                runtime.snapshot(path)
            runtime.snapshot(path, active=True)
            restored = Runtime.restore_runtime(path, device="native-cpu")
            self.addCleanup(restored.close)
            self.assertEqual(restored.status()["active_task"], 1)
            restored.retry_failed()
            restored.run()
            self.assertEqual(len([r for r in restored.trace() if r["kind"] == "commit" and r["task"] == 1]), 1)
            self.assertEqual([r["value"] for r in restored.read_output()], [1])

    def test_growth_does_not_change_logical_fingerprint(self):
        runtime = self.make()
        runtime.send({"X0": 0}, request_id="left").wait(timeout=5)
        before = runtime.fingerprint()
        runtime.grow(tasks=8192, tokens=16384)
        self.assertEqual(runtime.fingerprint(), before)

    def test_wal_recovery_request_deduplication_and_outbox_redelivery(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "state.wal"
            runtime = self.make(durable_path=path)
            ticket = runtime.send({"X0": 1, "X1": 1}, request_id="stable").wait("durable", 5)
            self.assertTrue(ticket.accepted and ticket.device_visible and ticket.durable)
            runtime.run()
            original = runtime.read_output()
            restored = Runtime.restore_runtime(path, device="native-cpu", journal=True)
            self.addCleanup(restored.close)
            old_count = restored.status()["pending"]
            replay = restored.send({"X0": 1, "X1": 1}, request_id="stable")
            self.assertEqual(replay.task_ids, ticket.task_ids)
            self.assertEqual(restored.status()["pending"], old_count)
            self.assertEqual(restored.read_output(), original)
            restored.ack_output(original[0]["output_id"])
            self.assertEqual(restored.read_output(), [])

    def test_explicit_transaction_internal_results_and_state_alias(self):
        model = {"profile": "jkcuda.v6.1", "format_version": 1,
                 "queues": [{"name": "q", "priority": 1}], "states": [{"id": "s", "initial": 0}],
                 "nodes": [{"id": "A", "state": "s", "queue": "q", "ex": "K1", "sources": {}, "output": "Y"},
                           {"id": "B", "state": "s", "queue": "q", "ex": "K(p)",
                            "sources": {"p": {"kind": "PARAM", "param": "p"}}, "output": "Y"}],
                 "transactions": [{"name": "twice", "queue": "q", "steps": [
                     {"node": "A"}, {"node": "B", "result_refs": {"p": 0}}]}]}
        runtime = Runtime(model, device="native-cpu", work_slice=1)
        self.addCleanup(runtime.close)
        runtime.submit_transaction("twice", request_id="tx").wait(timeout=5)
        status = runtime.step()
        self.assertEqual(status["completed"], 1)
        self.assertEqual(status["states"]["s"], {"value": 0, "version": 2})
        self.assertEqual([r["value"] for r in runtime.read_output()], [1, 0])

    def test_durability_failure_never_reports_durable_or_allows_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            runtime = self.make(durable_path=Path(directory) / "events.wal")
            with mock.patch.object(runtime._journal, "append", side_effect=OSError("disk full")):
                ticket = runtime.send({"X0": 0}, request_id="accepted-only")
                with self.assertRaises(RuntimeError):
                    ticket.wait("durable", 5)
            self.assertTrue(ticket.accepted)
            self.assertFalse(ticket.durable)
            with self.assertRaises(RuntimeError):
                runtime.run()
            restored = Runtime.restore_runtime(Path(directory) / "events.wal", device="native-cpu", journal=True)
            self.addCleanup(restored.close)
            self.assertEqual(restored.status()["pending"], 0)

    def test_many_outputs_keep_logical_order_after_json_key_sorting(self):
        runtime = self.make()
        for i in range(12):
            runtime.send({"X0": i % 2, "X1": 0}, request_id=str(i), key=i).wait(timeout=5)
        runtime.run()
        original = runtime.read_output()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "ordered.json"
            runtime.snapshot(path)
            restored = Runtime.restore_runtime(path, device="native-cpu")
            self.addCleanup(restored.close)
            self.assertEqual(restored.read_output(), original)
            self.assertEqual([o["output"] for o in restored.read_output()], list(range(1, 13)))

    def test_checksum_is_not_a_substitute_for_owned_outbox_validation(self):
        runtime = self.make()
        runtime.send({"X0": 0, "X1": 1}).wait(timeout=5)
        runtime.run()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "forged.json"
            runtime.snapshot(path)
            payload = read_checkpoint(path)
            next(iter(payload["outbox"].values()))["value"] = 0
            write_checkpoint(path, payload)  # Deliberately recompute the envelope hash.
            with self.assertRaises(RecoveryError):
                Runtime.restore_runtime(path, device="native-cpu")

    def test_recovery_rejects_swapped_tickets_and_forged_request_payloads(self):
        runtime = self.make()
        runtime.send({"X0": 0}, request_id="zero").wait(timeout=5)
        runtime.send({"X0": 1}, request_id="one").wait(timeout=5)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "forged-tickets.json"
            runtime.snapshot(path)
            payload = read_checkpoint(path)
            altered = copy.deepcopy(payload)
            altered["tickets"]["zero"]["task_ids"], altered["tickets"]["one"]["task_ids"] = (
                altered["tickets"]["one"]["task_ids"], altered["tickets"]["zero"]["task_ids"])
            write_checkpoint(path, altered)
            with self.assertRaises(RecoveryError):
                Runtime.restore_runtime(path, device="native-cpu")
            altered = copy.deepcopy(payload)
            altered["requests"]["zero"]["requests"][0]["params"]["input"] = 1
            altered["requests"]["zero"]["fingerprint"] = digest(altered["requests"]["zero"]["requests"])
            write_checkpoint(path, altered)
            with self.assertRaises(RecoveryError):
                Runtime.restore_runtime(path, device="native-cpu")

    def test_structure_task_and_restored_program_history(self):
        runtime = self.make(work_slice=1)
        runtime.send({"X0": 1, "X1": 0}, request_id="before").wait(timeout=5)
        # Input tasks run first and produce an old-version xor task in compute.
        runtime.step()
        runtime.step()
        candidate = runtime.current_model()
        changed = next(n for n in candidate["nodes"] if n["id"] == "xor")
        changed["ex"] = "J0K1K(a)K(b)"
        changed.pop("ops")
        changed["version"] = 2
        ticket = runtime.modify(candidate, queue="input", request_id="change").wait(timeout=5)
        self.assertEqual(next(n for n in runtime.current_model()["nodes"] if n["id"] == "xor")["version"], 1)
        runtime.step()
        self.assertEqual(next(n for n in runtime.current_model()["nodes"] if n["id"] == "xor")["version"], 2)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "versions.json"
            runtime.snapshot(path)
            restored = Runtime.restore_runtime(path, device="native-cpu")
            self.addCleanup(restored.close)
            self.assertEqual(restored.fingerprint(), runtime.fingerprint())
            restored.send({"X0": 1, "X1": 0}, request_id="after").wait(timeout=5)
            restored.run()
            self.assertEqual([r["value"] for r in restored.read_output()], [1, 0])
            self.assertEqual(restored.query_request("change")["task_ids"], ticket.task_ids)

    def test_concurrent_ingress_and_bounded_run_preserve_complete_task_boundaries(self):
        runtime = self.make(work_slice=1)
        errors = []
        def produce():
            try:
                for i in range(24):
                    runtime.send({"X0": i % 2, "X1": (i // 2) % 2},
                                 request_id=f"parallel:{i}", key=i).wait(timeout=5)
            except Exception as exc:
                errors.append(exc)
        producer = threading.Thread(target=produce)
        producer.start()
        deadline = time.monotonic() + 10
        while producer.is_alive() and time.monotonic() < deadline:
            runtime.run(max_tasks=5)
            time.sleep(.001)  # Avoid an idle-driver busy loop starving the producer.
        producer.join(timeout=2)
        self.assertFalse(producer.is_alive())
        self.assertEqual(errors, [])
        runtime.run()
        outputs = runtime.read_output()
        self.assertEqual({o["key"]: o["value"] for o in outputs},
                         {i: (i % 2) ^ ((i // 2) % 2) for i in range(24)})
        self.assertEqual(len(outputs), 24)
        active = None
        for record in runtime.trace():
            if record["kind"] == "select":
                self.assertIsNone(active)
                active = record["task"]
            elif record["kind"] == "complete":
                self.assertEqual(active, record["task"])
                active = None
            elif record["kind"] in {"bind", "commit", "event", "delivery", "output"}:
                self.assertEqual(record["task"], active)
        self.assertIsNone(active)


class PersistenceTests(unittest.TestCase):
    def test_atomic_checkpoint_and_corruption_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "check.json"
            write_checkpoint(path, {"x": 0})
            self.assertEqual(read_checkpoint(path), {"x": 0})
            item = json.loads(path.read_text())
            item["payload"]["x"] = 1
            path.write_text(json.dumps(item))
            with self.assertRaises(RecoveryError):
                read_checkpoint(path)

    def test_torn_final_wal_record_and_complete_corruption(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "check.wal"
            journal = Journal(path)
            journal.append({"phase": 1})
            journal.append({"phase": 2})
            data = path.read_bytes()
            path.write_bytes(data + b'{"incomplete":')
            self.assertEqual(Journal.recover(path), {"phase": 2})
            path.write_bytes(data.replace(b'"phase":2', b'"phase":3'))
            with self.assertRaises(RecoveryError):
                Journal.recover(path)


if __name__ == "__main__":
    unittest.main()
