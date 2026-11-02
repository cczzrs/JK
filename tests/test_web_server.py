import copy
import http.client
import json
from pathlib import Path
import threading
import time
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from jkcuda import Runtime
from jkcuda.webserver import CommandConflict, WebController, create_server, json_safe

EXAMPLES = Path(__file__).resolve().parents[1] / "examples" / "cuda"


class WebControllerTests(unittest.TestCase):
    def make(self, name="xor"):
        runtime = Runtime(EXAMPLES / (name + ".json"), device="native-cpu", work_slice=1)
        controller = WebController(runtime, sample_interval=0.05)
        self.addCleanup(runtime.close)
        self.addCleanup(controller.close)
        return runtime, controller

    def wait(self, controller, identifier):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            command = controller.get_command(identifier)
            if command["state"] in ("completed", "failed"):
                self.assertEqual(command["state"], "completed", command)
                return command
            time.sleep(0.005)
        self.fail("web command did not finish")

    def test_input_command_identity_and_real_xor_result(self):
        runtime, controller = self.make()
        payload = {"values": {"X0": 0, "X1": 1}, "key": "pair"}
        controller.command("send", payload, "input")
        self.wait(controller, "input")
        self.assertEqual(controller.command("send", payload, "input")["state"], "completed")
        with self.assertRaises(CommandConflict):
            controller.command("send", {"values": {"X0": 1}}, "input")
        self.assertEqual(runtime.status()["pending"], 2)
        for index in range(3):
            controller.command("step", {}, "step-" + str(index))
            self.wait(controller, "step-" + str(index))
            self.assertEqual(runtime.status()["completed"], index + 1)
        self.assertEqual([o["value"] for o in runtime.observe()["outputs"]["items"]], [1])

    def test_pause_from_slow_work_mode_completes_active_task_and_keeps_fifo(self):
        runtime, controller = self.make()
        runtime.send({"X0": 0, "X1": 1}, request_id="input").wait()
        controller.command("run", {"granularity": "work", "interval_ms": 1000}, "run")
        deadline = time.monotonic() + 5
        while not runtime.status()["active_task"] and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertEqual(runtime.status()["active_task"], 1)
        with self.assertRaises(CommandConflict):
            controller.command("step", {}, "overlap")
        controller.command("pause", {}, "pause")
        self.wait(controller, "run")
        status = runtime.status()
        self.assertIsNone(status["active_task"])
        self.assertEqual(status["completed"], 1)
        self.assertEqual(status["pending"], 1)
        self.assertEqual([r["task"] for r in runtime.trace() if r["kind"] == "select"], [1])

    def test_observation_does_not_receive_frame_output(self):
        runtime, controller = self.make("frames")
        before = runtime._core.dump()
        controller.observation()
        self.assertIsNone(runtime._frames)
        self.assertEqual(runtime._core.dump(), before)
        runtime.submit_frame([0, 1], request_id="frame").wait()
        runtime.run()
        before = runtime._core.dump()
        for _ in range(3):
            state = controller.observation()
        self.assertEqual(runtime._core.dump(), before)
        self.assertEqual(state["status"]["pending"], 0)
        controller.command("receive_outputs", {}, "receive")
        receipt = self.wait(controller, "receive")["result"]
        self.assertEqual(receipt["batches"][0]["values"], [0, 1])
        self.assertEqual(runtime.status()["pending"], 1)
        runtime.step()
        controller.command("ack_frame", {"value": 0}, "ack0")
        self.wait(controller, "ack0")
        runtime.run()
        controller.command("receive_outputs", {}, "replay")
        batches = self.wait(controller, "replay")["result"]["batches"]
        self.assertTrue(any(batch["replay"] and batch["values"] == [0, 1] for batch in batches))

    def test_pause_after_manual_work_step_finishes_retained_task(self):
        runtime, controller = self.make()
        runtime.send({"X0": 0, "X1": 1}, request_id="input").wait()
        controller.command("step_work", {}, "work")
        self.wait(controller, "work")
        self.assertEqual(runtime.status()["active_task"], 1)
        controller.command("pause", {}, "pause")
        result = self.wait(controller, "pause")["result"]
        self.assertTrue(result["boundary_reached"])
        self.assertEqual(runtime.status()["completed"], 1)
        self.assertEqual(runtime.status()["pending"], 1)

    def test_invalid_input_is_failed_command_with_unchanged_model(self):
        runtime, controller = self.make()
        before = runtime._core.dump()
        controller.command("send", {"values": {"X0": 2}}, "bad")
        deadline = time.monotonic() + 5
        while controller.get_command("bad")["state"] not in ("failed", "completed") and time.monotonic() < deadline:
            time.sleep(0.005)
        self.assertEqual(controller.get_command("bad")["state"], "failed")
        self.assertEqual(runtime._core.dump(), before)

    def test_int64_transport_preserves_identity_and_boolean(self):
        self.assertEqual(json_safe({"id": 2**63 - 1, "value": 0, "ok": True}),
                         {"id": str(2**63 - 1), "value": 0, "ok": True})


class WebHTTPTests(unittest.TestCase):
    def setUp(self):
        self.runtime = Runtime(EXAMPLES / "xor.json", device="native-cpu")
        self.server = create_server(self.runtime, port=0)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
        self.server.server_close()
        self.runtime.close()

    def get(self, path, headers=None):
        with urlopen(Request(self.url + path, headers=headers or {}), timeout=5) as response:
            return json.load(response)

    def test_get_routes_are_read_only_and_trace_is_pageable(self):
        self.runtime.send({"X0": 0}, request_id="first").wait()
        self.runtime.run()
        before = copy.deepcopy(self.runtime._core.dump())
        model_response = self.get("/api/model")
        self.assertEqual(model_response["model"]["profile"], "jkcuda.v6.1")
        self.assertEqual(json.loads(model_response["model_json"]), self.runtime.current_model())
        self.get("/api/state")
        self.get("/api/inspection")
        first = self.get("/api/trace?after=0&limit=1")
        second = self.get("/api/trace?after=1&limit=1")
        self.assertEqual(first["items"][0]["kind"], "enqueue")
        self.assertEqual(second["items"][0]["kind"], "select")
        self.assertEqual(self.runtime._core.dump(), before)

    def test_commands_require_token_and_cross_origin_cannot_read_token(self):
        body = json.dumps({"action": "send", "request_id": "web:http-input", "payload": {"values": {"X0": 1}}}).encode()
        with self.assertRaises(HTTPError) as error:
            urlopen(Request(self.url + "/api/command", data=body, headers={"Content-Type": "application/json"}), timeout=5)
        self.assertEqual(error.exception.code, 403)
        with self.assertRaises(HTTPError) as error:
            self.get("/api/session", {"Origin": "https://example.com"})
        self.assertEqual(error.exception.code, 403)
        token = self.get("/api/session")["token"]
        with urlopen(Request(self.url + "/api/command", data=body,
                             headers={"Content-Type": "application/json", "X-JK-Token": token}), timeout=5) as response:
            self.assertEqual(json.load(response)["command_id"], "web:http-input")
        self.assertEqual(self.get("/api/commands/web%3Ahttp-input")["command_id"], "web:http-input")

    def test_model_json_text_preserves_integer_literals_for_export(self):
        model = self.runtime.current_model()
        model["metadata"] = {"integer_identity": 9223372036854775807}
        with mock.patch.object(self.runtime._core, "current_model", return_value=model):
            result = self.get("/api/model")
        self.assertEqual(result["model"]["metadata"]["integer_identity"], "9223372036854775807")
        self.assertEqual(json.loads(result["model_json"])["metadata"]["integer_identity"],
                         9223372036854775807)

    def test_factory_design_is_canonical_and_does_not_install_or_execute(self):
        before = copy.deepcopy(self.runtime._core.dump())
        model = self.runtime.current_model()
        result = self.get("/api/factory-design")
        self.assertEqual(result["version"], "7.0.0")
        self.assertEqual(result["execution_status"], "definition-only")
        docs = result["documents"]
        self.assertEqual(docs["RAM.FACTORY.json"]["members"], ["F1", "RAM1"])
        self.assertEqual(docs["JKI.FACTORY.json"]["pro"]["name"], "JKI.FACTORY")
        for name, text in result["document_json"].items():
            self.assertEqual(json.loads(text), docs[name])
            source = EXAMPLES.parents[1] / "assets" / "jks-factory-v7-design" / name
            self.assertEqual(text, source.read_text(encoding="utf-8"))
        self.assertEqual(self.runtime._core.dump(), before)
        self.assertEqual(self.runtime.current_model(), model)
        self.assertIsNone(self.runtime._frames)

    def test_factory_design_obeys_same_origin_and_has_no_write_command(self):
        with self.assertRaises(HTTPError) as error:
            self.get("/api/factory-design", {"Origin": "https://example.com"})
        self.assertEqual(error.exception.code, 403)
        self.assertNotIn("factory_create", self.server.controller.ACTIONS)

    def test_sse_snapshot_and_reconnect_are_observations(self):
        before = self.runtime._core.dump()
        for _ in range(2):
            connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
            connection.request("GET", "/api/stream")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            self.assertTrue(response.readline().startswith(b"id:"))
            self.assertEqual(response.readline().strip(), b"event: state")
            state = json.loads(response.readline()[6:])
            self.assertEqual(state["status"]["completed"], 0)
            response.close()
            connection.close()
        self.assertEqual(self.runtime._core.dump(), before)

    def test_invalid_page_and_static_traversal_are_rejected(self):
        for path, expected in (("/api/trace?after=-1", 400), ("/api/state?limit=1001", 400), ("/../../pyproject.toml", 404)):
            with self.assertRaises(HTTPError) as error:
                self.get(path)
            self.assertEqual(error.exception.code, expected)

    def test_packaged_frontend_assets_have_browser_mime_types(self):
        for path, mime in (("/", "text/html"), ("/app.js", "text/javascript"),
                           ("/state.mjs", "text/javascript"), ("/graph.mjs", "text/javascript"),
                           ("/factory.mjs", "text/javascript"),
                           ("/styles.css", "text/css")):
            with self.subTest(path=path), urlopen(self.url + path, timeout=5) as response:
                self.assertEqual(response.headers.get_content_type(), mime)
                self.assertGreater(len(response.read()), 100)


if __name__ == "__main__":
    unittest.main()
