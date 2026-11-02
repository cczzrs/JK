"""Loopback web console for one real Runtime; no browser-side model execution.

Observation uses the last synchronized host image. A single sampler serves all
browsers; slow clients never hold the runtime lock or backpressure the device.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import parse_qs, unquote, urlsplit


class CommandConflict(ValueError):
    pass


def _integer(value, name, lower=0, upper=1000000):
    if type(value) is not int or not lower <= value <= upper:
        raise ValueError(f"{name} must be an integer in [{lower}, {upper}]")
    return value


def json_safe(value):
    """Preserve int64 identities in JavaScript; key_type disambiguates keys."""
    if type(value) is int and abs(value) > 9007199254740991:
        return str(value)
    if isinstance(value, dict):
        return {key: json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return value


def _json(value):
    return json.dumps(json_safe(value), ensure_ascii=False, allow_nan=False,
                      separators=(",", ":")).encode("utf-8")


class WebController:
    """Owns web command scheduling, but does not own the supplied Runtime."""

    EXECUTION = {"run", "step", "step_work", "retry_failed"}
    ACTIONS = EXECUTION | {"pause", "send", "submit_frame", "receive_outputs",
                           "ack_frame", "ack_output", "grow", "resume_budget"}

    def __init__(self, runtime, *, sample_interval=0.2):
        self.runtime = runtime
        self.token = secrets.token_urlsafe(32)
        self._lock = threading.RLock()
        self._condition = threading.Condition(self._lock)
        self._commands = {}
        self._running = False
        self._mode = None
        self._last_error = None
        self._stop = threading.Event()
        self._closed = threading.Event()
        self._execution = ThreadPoolExecutor(max_workers=1, thread_name_prefix="jk-web-execution")
        self._ingress = ThreadPoolExecutor(max_workers=1, thread_name_prefix="jk-web-actions")
        self._sample_interval = max(0.05, sample_interval)
        self._sample_id = 0
        self._sample = None
        self._sample_error = None
        self._sampler = threading.Thread(target=self._sample_loop, name="jk-web-observer", daemon=True)
        self._sampler.start()

    def control(self):
        with self._lock:
            return {"running": self._running, "mode": self._mode,
                    "pause_requested": self._running and self._stop.is_set(),
                    "last_error": self._last_error}

    def observation(self, after=None, limit=200, include_model=False):
        state = self.runtime.observe(since_trace=after, limit=limit, include_model=include_model)
        state["control"] = self.control()
        state["sampled_at"] = time.time_ns() // 1000000
        return state

    def _sample_loop(self):
        while not self._closed.is_set():
            try:
                sample = self.observation()
                error = None
            except Exception as exc:
                sample, error = None, str(exc)
            with self._condition:
                if sample is not None:
                    self._sample = sample
                self._sample_error = error
                self._sample_id += 1
                self._condition.notify_all()
            self._closed.wait(self._sample_interval)

    def wait_sample(self, after=0, timeout=1):
        with self._condition:
            self._condition.wait_for(lambda: self._sample_id > after or self._closed.is_set(), timeout)
            return self._sample_id, self._sample, self._sample_error

    def get_command(self, command_id):
        with self._lock:
            if command_id not in self._commands:
                raise KeyError("unknown command")
            return copy.deepcopy(self._commands[command_id][1])

    def command(self, action, payload=None, request_id=None):
        if action not in self.ACTIONS:
            raise ValueError("unknown action")
        if not isinstance(payload, dict):
            if payload is not None:
                raise ValueError("payload must be an object")
            payload = {}
        if not isinstance(request_id, str) or not 1 <= len(request_id) <= 160:
            raise ValueError("request_id must be a nonempty string of at most 160 characters")
        signature = json.dumps([action, payload], sort_keys=True, allow_nan=False)
        with self._lock:
            if self._closed.is_set():
                raise CommandConflict("console is closed")
            previous = self._commands.get(request_id)
            if previous:
                if signature != previous[0]:
                    raise CommandConflict("request_id already has a different command")
                return copy.deepcopy(previous[1])
            if len(self._commands) >= 10000 and action != "pause":
                raise CommandConflict("console command history is full; restart the console session")
            if action in self.EXECUTION and self._running:
                raise CommandConflict("execution is in progress; pause and wait for its boundary first")
            if action == "run":
                _integer(payload.get("max_tasks", 100000), "max_tasks", 1)
                _integer(payload.get("interval_ms", 0), "interval_ms", 0, 2000)
                if payload.get("granularity", "task") not in ("task", "work"):
                    raise ValueError("granularity must be task or work")
            result = {"command_id": request_id, "action": action, "state": "queued"}
            self._commands[request_id] = (signature, result)
            if action == "pause":
                self._stop.set()
                self.runtime.pause()
                status = self.runtime.status()
                if not self._running and status["active_task"] and not status.get("reason"):
                    self._running, self._mode = True, "pause"
                    self._execution.submit(self._execute, request_id, action, {})
                else:
                    result.update(state="completed", result={"pause_requested": True,
                                  "boundary_reached": not self._running and status["active_task"] is None,
                                  "reason": status.get("reason")})
            else:
                if action in self.EXECUTION:
                    self._running, self._mode, self._last_error = True, action, None
                    self._stop.clear()
                executor = self._execution if action in self.EXECUTION else self._ingress
                executor.submit(self._execute, request_id, action, copy.deepcopy(payload))
            return copy.deepcopy(result)

    def _execute(self, command_id, action, payload):
        with self._lock:
            self._commands[command_id][1]["state"] = "running"
        try:
            runtime = self.runtime
            if action == "run":
                result = self._run(payload)
            elif action == "pause":
                status = runtime.step()
                result = {"pause_requested": True, "boundary_reached": status["active_task"] is None,
                          "reason": status.get("reason")}
            elif action == "step":
                result = runtime.step()
            elif action == "step_work":
                result = runtime.step_work()
            elif action == "retry_failed":
                result = runtime.retry_failed()
            elif action == "send":
                result = runtime.send(payload.get("values", {}), key=payload.get("key"),
                                      request_id="web:" + command_id).wait("device_visible").as_dict()
            elif action == "submit_frame":
                result = runtime.submit_frame(payload.get("values"),
                                              request_id="web:" + command_id).wait("device_visible").as_dict()
            elif action == "receive_outputs":
                # This is an explicit application receive, never a GET or sample.
                if runtime.current_model().get("frame_module"):
                    result = {"batches": runtime.read_frame_batches()}
                else:
                    result = {"outputs": runtime.read_output()}
            elif action == "ack_frame":
                result = runtime.ack_frame(payload.get("value"),
                                           request_id="web:" + command_id).wait("device_visible").as_dict()
            elif action == "ack_output":
                runtime.ack_output(payload.get("output_id"))
                result = {"acknowledged": payload.get("output_id")}
            elif action == "grow":
                capacities = payload.get("capacities")
                if not isinstance(capacities, dict) or not capacities:
                    raise ValueError("capacities must be a nonempty object")
                result = runtime.grow(**capacities)
            elif action == "resume_budget":
                runtime.resume_budget(payload.get("group"), payload.get("additional"))
                result = runtime.status()
            with self._lock:
                self._commands[command_id][1].update(state="completed", result=result)
        except Exception as exc:
            with self._lock:
                self._commands[command_id][1].update(state="failed", error=str(exc))
                self._last_error = str(exc)
        finally:
            if action in self.EXECUTION or action == "pause":
                with self._lock:
                    self._running, self._mode = False, None

    def _run(self, payload):
        maximum = payload.get("max_tasks", 100000)
        interval = payload.get("interval_ms", 0) / 1000
        work = payload.get("granularity", "task") == "work"
        start = self.runtime.status()["completed"]
        status = self.runtime.status()
        while status["completed"] - start < maximum:
            # A normal pause always completes the active task, including when
            # slow demonstration previously yielded inside it.
            if self._stop.is_set():
                if status["active_task"] and not status.get("reason"):
                    status = self.runtime.step()
                break
            status = self.runtime.step_work() if work else self.runtime.step()
            if status.get("reason") or (not status["active_task"] and not status["pending"]):
                break
            # Let independent ingress and observation run between task steps.
            time.sleep(0)
            if interval:
                self._stop.wait(interval)
        self.runtime.pause()
        return status

    def close(self):
        self._closed.set()
        self._stop.set()
        self.runtime.pause()
        with self._condition:
            self._condition.notify_all()
        self._sampler.join(timeout=5)
        self._execution.shutdown(wait=True)
        self._ingress.shutdown(wait=True)


class ConsoleServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def server_close(self):
        super().server_close()
        self.controller.close()


def create_server(runtime, host="127.0.0.1", port=8765):
    if host not in ("127.0.0.1", "localhost"):
        raise ValueError("console binds to loopback; use SSH port forwarding for a remote CUDA host")
    server = ConsoleServer((host, port), ConsoleHandler)
    server.controller = WebController(runtime)
    return server


class ConsoleHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def _allowed_origin(self):
        # Prevent another web origin from acquiring the local command token.
        expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        return host in expected and (origin is None or origin in {"http://" + h for h in expected})

    def _reply(self, status, value, mime="application/json; charset=utf-8"):
        body = value if isinstance(value, bytes) else _json(value)
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; object-src 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def _query(self):
        url = urlsplit(self.path)
        values = parse_qs(url.query)
        after = int(values["after"][0]) if "after" in values else None
        limit = int(values.get("limit", ["200"])[0])
        if after is not None:
            _integer(after, "after", 0, 2**63-1)
        _integer(limit, "limit", 1, 1000)
        return url.path, after, limit

    def do_GET(self):
        if not self._allowed_origin():
            return self._reply(403, {"error": "same-origin loopback access required"})
        try:
            path, after, limit = self._query()
            controller = self.server.controller
            if path == "/api/session":
                return self._reply(200, {"token": controller.token})
            if path == "/api/factory-design":
                # Canonical design documents; never inspect or install a model.
                root = Path(__file__).resolve().parents[1] / "assets" / "jks-factory-v7-design"
                names = ("JKI.FACTORY.json", "RAM.FACTORY.json", "design-contract.json",
                         "generation-example.json")
                texts = {name: (root / name).read_text(encoding="utf-8") for name in names}
                return self._reply(200, {"format": "jkcuda.factory-design/1", "version": "7.0.0",
                                        "execution_status": "definition-only",
                                        "documents": {name: json.loads(raw) for name, raw in texts.items()},
                                        "document_json": texts})
            if path == "/api/model":
                state = controller.observation(limit=1, include_model=True)
                result = {key: state[key] for key in ("model", "model_version", "instance_id")}
                # Preserve integer literals for the read-only JSON/export pane.
                # The parsed object still uses json_safe for browser identities.
                result["model_json"] = json.dumps(state["model"], ensure_ascii=False, indent=2)
                return self._reply(200, result)
            if path in ("/api/state", "/api/inspection"):
                return self._reply(200, controller.observation(after, limit, path == "/api/inspection"))
            if path == "/api/trace":
                return self._reply(200, controller.observation(0 if after is None else after, limit)["trace"])
            if path.startswith("/api/commands/"):
                return self._reply(200, controller.get_command(unquote(path.rsplit("/", 1)[1])))
            if path == "/api/stream":
                return self._stream()
            static = {"/": "index.html", "/index.html": "index.html", "/app.js": "app.js",
                      "/state.mjs": "state.mjs", "/graph.mjs": "graph.mjs",
                      "/factory.mjs": "factory.mjs", "/styles.css": "styles.css"}
            if path not in static:
                return self._reply(404, {"error": "not found"})
            filename = static[path]
            mime = {"html": "text/html", "js": "text/javascript", "mjs": "text/javascript", "css": "text/css"}[filename.rsplit(".", 1)[1]]
            return self._reply(200, (Path(__file__).with_name("web") / filename).read_bytes(), mime + "; charset=utf-8")
        except (ValueError, TypeError) as exc:
            self._reply(400, {"error": str(exc)})
        except (KeyError, FileNotFoundError) as exc:
            self._reply(404, {"error": str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as exc:
            self._reply(500, {"error": str(exc)})

    def _stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        self.connection.settimeout(5)
        controller = self.server.controller
        revision = 0
        try:
            while not controller._closed.is_set():
                next_revision, sample, error = controller.wait_sample(revision)
                if next_revision == revision:
                    self.wfile.write(b": heartbeat\n\n")
                elif error:
                    self.wfile.write(b"event: observation_error\ndata: " + _json({"error": error}) + b"\n\n")
                elif sample is not None:
                    self.wfile.write(f"id: {next_revision}\nevent: state\ndata: ".encode() + _json(sample) + b"\n\n")
                revision = next_revision
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            pass

    def do_POST(self):
        if not self._allowed_origin() or not secrets.compare_digest(
                self.headers.get("X-JK-Token", ""), self.server.controller.token):
            return self._reply(403, {"error": "same-origin command token required"})
        try:
            if urlsplit(self.path).path != "/api/command":
                return self._reply(404, {"error": "not found"})
            if self.headers.get_content_type() != "application/json":
                raise ValueError("application/json required")
            length = int(self.headers.get("Content-Length", "0"))
            _integer(length, "Content-Length", 1, 1024 * 1024)
            self.connection.settimeout(10)
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError("incomplete request")
            request = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite number")))
            if not isinstance(request, dict):
                raise ValueError("command must be an object")
            result = self.server.controller.command(request.get("action"), request.get("payload"), request.get("request_id"))
            self._reply(202, result)
        except CommandConflict as exc:
            self._reply(409, {"error": str(exc)})
        except (ValueError, TypeError, UnicodeError) as exc:
            self._reply(400, {"error": str(exc)})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
