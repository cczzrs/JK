"""Frame ownership across dynamic model versions and recovery boundaries."""

from copy import deepcopy
from pathlib import Path
import unittest

from jkcuda.backend import Core
from jkcuda.frames import Frames, FrameError, validate_blob
from jkcuda.model import load_model


MODEL = Path(__file__).resolve().parents[1] / "examples/cuda/frames.json"


class FrameIntegrationTests(unittest.TestCase):
    def make(self):
        model = load_model(MODEL)
        model["nodes"].append({"id": "unrelated", "queue": model["frame_module"]["queue"],
                               "ex": "J0K(value)", "sources": {"value": {"kind": "PARAM", "param": "value"}},
                               "output": "other"})
        model["entrypoints"].append("unrelated")
        model = load_model(model)
        core = Core(model, device="native-cpu")
        return model, core, Frames(core)

    def test_unrelated_model_version_keeps_frame_adapter_binding_on_restore(self):
        model, core, frames = self.make()
        frames.submit_frame([0, 1, 0])
        core.advance(max_tasks=100)
        batch = frames.batches()[0]
        frames.received_batch(batch["batch_id"])
        core.advance(max_tasks=100)
        candidate = deepcopy(model)
        unrelated = next(n for n in candidate["nodes"] if n["id"] == "unrelated")
        unrelated["version"] = 2
        unrelated["ex"] += "K1"
        unrelated.pop("ops")
        candidate = load_model(candidate)
        core.modify(candidate, queue=model["frame_module"]["queue"])
        core.advance(max_tasks=100)
        self.assertNotEqual(core._node_map[model["frame_module"]["data_node"]],
                            core._version_maps[0][model["frame_module"]["data_node"]])
        restored = Core.from_dump(model, core.dump(), device="native-cpu")
        saved = Frames(restored)
        self.assertEqual(saved.batches(), frames.batches())
        saved.ack(0)
        restored.advance(max_tasks=100)
        self.assertEqual(saved.batches()[-1]["values"], [0, 1, 0])
        self.assertEqual(saved.batches()[-1]["marker"], 0)
        validate_blob(restored)

    def test_partial_input_and_committed_control_restore_without_reexecution(self):
        model, core, frames = self.make()
        submitted = frames.submit_frame([0, 1])
        # Select the first adapter, then execute its atomic bit copy while
        # leaving the task active before finish. Arrival is now a real fact.
        core.advance(max_work=2, max_tasks=1)
        self.assertEqual(frames.state()["frames"][0]["arrived"], 1)
        restored = Core.from_dump(model, core.dump(), device="native-cpu")
        recovered = Frames(restored)
        restored.advance(max_tasks=100)
        self.assertEqual(recovered.state()["frames"][0]["arrived"], 2)
        self.assertEqual(recovered.batches()[0]["frame_id"], submitted["frame_id"])
        self.assertEqual(recovered.batches()[0]["values"], [0, 1])
        self.assertEqual(len(recovered.batches()), 1)
        validate_blob(restored)

    def test_restore_rejects_frame_output_disagreeing_with_real_jk_result(self):
        model, core, frames = self.make()
        frames.submit_frame([0])
        core.advance(max_tasks=100)
        snapshot = core.dump()
        words = snapshot["logical"]["sections"]["frames"]
        batch = words[22][0]
        record = words[batch+12][0]
        words[record+3][0] = 1
        with self.assertRaisesRegex(FrameError, "committed JK output"):
            Core.from_dump(model, snapshot, device="native-cpu")


if __name__ == "__main__":
    unittest.main()
