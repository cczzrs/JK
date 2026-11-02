"""Host I/O, bounded execution, tickets and recovery for the device runtime."""
from __future__ import annotations

import copy
import re
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

from .model import load_model, bit, digest, structure_fingerprint, ModelError
from .persistence import Journal, RecoveryError, read_checkpoint, write_checkpoint


@dataclass
class Ticket:
    request_id: str
    accepted: bool = False
    device_visible: bool = False
    durable: bool = False
    task_ids: list = field(default_factory=list)
    details: dict = field(default_factory=dict)
    error: str | None = None
    _condition: threading.Condition = field(default_factory=threading.Condition, repr=False)

    def wait(self, milestone="accepted", timeout=None):
        if milestone not in {"accepted", "device_visible", "durable"}:
            raise ValueError("unknown ticket milestone")
        with self._condition:
            ready = self._condition.wait_for(lambda: getattr(self, milestone) or self.error is not None, timeout)
            if not ready:
                raise TimeoutError(f"{self.request_id}: waiting for {milestone}")
            if not getattr(self, milestone):
                raise RuntimeError(self.error)
        return self

    def as_dict(self):
        with self._condition:
            return {key: copy.deepcopy(getattr(self, key)) for key in
                    ("request_id", "accepted", "device_visible", "durable", "task_ids", "details", "error")}

    def _set(self, **values):
        with self._condition:
            for key, value in values.items():
                setattr(self, key, value)
            self._condition.notify_all()


class Runtime:
    """One instance owns one execution domain and one active logical task.

    Explicit ``native-cpu`` is a production-core test backend. CUDA failures do
    not trigger an automatic CPU fallback. Host calls serialize bounded device
    commands; a separate short request lock never surrounds CUDA or file I/O.
    """

    def __init__(self, model, *, device="cuda", capacities=None, durable_path=None, work_slice=1024,
                 propagation="parallel", propagation_chunk=128, block_size=128):
        from .backend import Core
        self.model = load_model(model)
        self._initialize(device, work_slice)
        self._core = Core(self.model, device=device, capacities=capacities, propagation=propagation,
                          propagation_chunk=propagation_chunk, block_size=block_size)
        self._journal = Journal(durable_path) if durable_path else None
        if self._journal:
            self._persist()

    def _initialize(self, device, work_slice):
        if type(work_slice) is not int or work_slice < 1:
            raise ValueError("work_slice must be positive")
        self.device = device
        self.work_slice = work_slice
        self.instance_id = uuid.uuid4().hex
        self._core_lock = threading.RLock()
        self._run_lock = threading.Lock()
        self._request_lock = threading.Lock()
        self._pause = threading.Event()
        self._pause.set()
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="jkcuda-ingress")
        self._tickets, self._requests = {}, {}
        self._accepted_frontier = 0
        self._outbox, self._acknowledged = {}, set()
        self._journal = None
        self._frames = None
        self._persistence_error = None
        self._closed = False

    @classmethod
    def from_structure(cls, model, **options):
        return cls(model, **options)

    def _check_open(self):
        if self._closed:
            raise RuntimeError("runtime is closed")
        if self._persistence_error:
            raise RuntimeError("durability failure; recover the last synchronized journal prefix: " + self._persistence_error)

    def send(self, values, *, request_id=None, key=None):
        """Latch one atomic submission in declared input-port order.

        The returned ticket may be pending. No model event exists until the
        queued input task actually runs. Different request IDs preserve repeats.
        """
        self._check_open()
        if not isinstance(values, dict) or not values:
            raise ValueError("send requires a nonempty mapping of input ports to bits")
        current = self.current_model()
        inputs = {p["name"]: p for p in current["inputs"]}
        if values.keys() - inputs.keys():
            raise ValueError("unknown input port")
        latched = {name: bit(value, name) for name, value in values.items()}
        if key is not None and type(key) not in (str, int):
            raise ValueError("key must be an integer, string, or null")
        requests = [{"node": p["node"], "params": {p["param"]: latched[p["name"]]}, "key": key}
                    for p in current["inputs"] if p["name"] in latched]
        return self._submit(requests, request_id)

    def submit(self, node, params=None, *, request_id=None, key=None):
        """Execute an explicitly declared entrypoint through its normal FIFO."""
        if node not in self.current_model()["entrypoints"]:
            raise ModelError("manual submission requires a declared entrypoint")
        return self._submit([{"node": node, "params": dict(params or {}), "key": key}], request_id)

    def submit_transaction(self, name, params=None, *, request_id=None, key=None):
        contracts = {t["name"]: t for t in self.current_model()["transactions"]}
        if name not in contracts:
            raise ModelError("transaction must be declared by the model")
        external, contract = params or {}, contracts[name]
        steps = []
        for step in contract["steps"]:
            bound = {}
            for parameter, value in step["params"].items():
                bound[parameter] = bit(external[value["param"]] if isinstance(value, dict) else value)
            steps.append({"node": step["node"], "params": bound, "result_refs": step["result_refs"]})
        return self._submit([{"transaction": steps, "queue": contract["queue"], "contract": name, "key": key}], request_id)

    def modify(self, candidate_model, *, queue, request_id=None):
        """Prepare an immutable version and enqueue its explicit structural task."""
        candidate = load_model(candidate_model)
        return self._submit([{"_structure": candidate, "queue": queue}], request_id)

    def current_model(self):
        with self._core_lock:
            return self._core.current_model()

    def query_request(self, request_id):
        with self._request_lock:
            return self._tickets[request_id].as_dict()

    def _frame_module(self):
        if self._frames is None:
            from .frames import Frames
            self._frames = Frames(self._core)
        return self._frames

    def submit_frame(self, values, *, request_id=None):
        """Own an ordered frame, whose bits each execute a FIFO input task."""
        if not isinstance(values, (list, tuple)) or not values:
            raise ValueError("frame must be a nonempty ordered bit array")
        owned = [bit(value, "frame bit") for value in values]
        return self._submit([{"_frame": owned}], request_id)

    def ack_frame(self, value, *, request_id=None):
        """Business ACK0 replays; ACK1 consumes. DEC and ACT remain FIFO tasks."""
        return self._submit([{"_frame_ack": bit(value, "ACK")}], request_id)

    def _submit(self, requests, request_id):
        self._check_open()
        request_id = request_id or uuid.uuid4().hex
        if not isinstance(request_id, str) or not request_id:
            raise ValueError("request_id must be a nonempty string")
        owned = copy.deepcopy(requests)
        fingerprint = digest(owned)
        # This lock only manages host identities. CUDA and fsync happen later.
        with self._request_lock:
            if request_id in self._tickets:
                if self._requests[request_id]["fingerprint"] != fingerprint:
                    raise ValueError("request_id was already used for a different payload")
                return self._tickets[request_id]
            ticket = Ticket(request_id)
            self._tickets[request_id] = ticket
            self._requests[request_id] = {"fingerprint": fingerprint, "requests": owned, "accepted": False}
            self._executor.submit(self._accept, ticket, owned)
        return ticket

    def _accept(self, ticket, requests):
        try:
            with self._core_lock:
                self._check_open()
                details = {}
                if len(requests) == 1 and "_frame" in requests[0]:
                    response = self._frame_module().submit_frame(requests[0]["_frame"])
                    ids = response["task_ids"]
                    details = {k: v for k, v in response.items() if k != "task_ids"}
                elif len(requests) == 1 and "_frame_ack" in requests[0]:
                    ids = self._frame_module().ack(requests[0]["_frame_ack"])
                elif len(requests) == 1 and "_frame_complete" in requests[0]:
                    ids = self._frame_module().received_batch(requests[0]["_frame_complete"])
                elif len(requests) == 1 and "_structure" in requests[0]:
                    ids = [self._core.modify(requests[0]["_structure"], queue=requests[0]["queue"])]
                else:
                    ids = self._core.enqueue(requests)
                self._core.bind_request(ids, ticket.request_id)
                with self._request_lock:
                    self._accepted_frontier += 1
                    self._requests[ticket.request_id]["accepted"] = True
                    self._requests[ticket.request_id]["sequence"] = self._accepted_frontier
                # Core.enqueue has completed ownership transfer and synchronized
                # device publication. These two milestones legitimately coincide.
                ticket._set(accepted=True, device_visible=True, task_ids=ids, details=details)
                if self._journal:
                    # Keep durable private until fsync has actually succeeded.
                    self._persist(durable_request=ticket.request_id)
                    ticket._set(durable=True)
        except Exception as exc:
            ticket._set(error=f"{type(exc).__name__}: {exc}")

    def send_tensor(self, tensor, *, ports=None, request_id=None, key=None):
        """Own a snapshot on the producer's current stream before returning.

        Validation and host staging currently synchronize. This is explicit,
        safe ingress, not a zero-copy or asynchronous-transfer performance claim.
        """
        import torch
        if not isinstance(tensor, torch.Tensor) or tensor.ndim != 1:
            raise ValueError("send_tensor requires a one-dimensional Torch tensor")
        if tensor.dtype not in (torch.uint8, torch.int8, torch.int16, torch.int32, torch.int64, torch.bool):
            raise ValueError("tensor must contain integer bits")
        owned = tensor.detach().clone()
        selected = ports or [p["name"] for p in self.current_model()["inputs"]]
        if len(selected) != tensor.numel() or len(set(selected)) != len(selected):
            raise ValueError("port order and tensor length must match")
        values = owned.to(device="cpu", dtype=torch.int64).tolist()
        return self.send(dict(zip(selected, values)), request_id=request_id, key=key)

    def _device_output_records(self):
        annotations = (self._frame_module().output_annotations()
                       if self._core.current_model().get("frame_module") else {})
        return [{**record, **annotations.get(record["output"], {})} for record in self._core.outputs()]

    def _collect_outputs(self):
        for record in self._device_output_records():
            identifier = f"{self.instance_id}:{record['output']}"
            if identifier not in self._outbox:
                self._outbox[identifier] = {"output_id": identifier, **copy.deepcopy(record)}

    def _payload(self, mode="active", durable_request=None):
        self._collect_outputs()
        with self._request_lock:
            requests = {identifier: copy.deepcopy(record) for identifier, record in self._requests.items()
                        if record["accepted"]}
            tickets = {identifier: self._tickets[identifier].as_dict() for identifier in requests}
        if durable_request:
            tickets[durable_request]["durable"] = True
        core = self._core.dump()
        return {"format": "jkcuda.runtime.v1", "mode": mode, "model": copy.deepcopy(self.model),
                "base_model_fingerprint": structure_fingerprint(self.model),
                "structure_fingerprint": structure_fingerprint(self._core.current_model()), "core": core,
                "instance_id": self.instance_id, "requests": requests, "tickets": tickets,
                "accepted_frontier": self._accepted_frontier,
                "outbox": copy.deepcopy(self._outbox), "acknowledged": sorted(self._acknowledged),
                "work_slice": self.work_slice}

    def _persist(self, durable_request=None):
        if self._journal:
            try:
                self._journal.append(self._payload(durable_request=durable_request))
            except OSError as exc:
                self._persistence_error = str(exc)
                raise

    def _advance_one(self):
        with self._core_lock:
            self._check_open()
            status = self._core.advance(max_work=self.work_slice, max_tasks=1)
            self._collect_outputs()
            self._persist()
            return status

    def step(self):
        """Return only a complete task or an explicit retained wait/fault."""
        with self._run_lock:
            self._check_open()
            with self._core_lock:
                initial = self._core.status()["completed"]
            while True:
                status = self._advance_one()
                if status["completed"] > initial or not status.get("active_task"):
                    return status
                if status.get("reason") not in (None, "", "running", "budget_yield", "yield", "work_limit"):
                    return status
                # Yield the host interpreter between bounded device commands so
                # an ingress thread can acquire the publication lock. This does
                # not change model FIFO priorities or execute another task.
                time.sleep(0)

    def step_work(self, max_work=1):
        """Advance bounded native work, retaining an unfinished active task.

        A work unit is a state-machine phase or propagation chunk, not one EX
        instruction. At most one logical task completes. Concurrent execution
        commands are rejected instead of silently queuing a later button press.
        """
        if type(max_work) is not int or not 0 < max_work < 2**63:
            raise ValueError("max_work must be a positive int64")
        if not self._run_lock.acquire(blocking=False):
            raise RuntimeError("another execution command is running")
        try:
            with self._core_lock:
                self._check_open()
                self._pause.set()
                status = self._core.advance(max_work=max_work, max_tasks=1)
                self._collect_outputs()
                self._persist()
                return status
        finally:
            self._run_lock.release()

    def run(self, max_tasks=100000):
        if type(max_tasks) is not int or max_tasks < 0:
            raise ValueError("max_tasks must be a nonnegative integer")
        with self._run_lock:
            self._check_open()
            self._pause.clear()
            with self._core_lock:
                status = self._core.status()
                start = status["completed"]
            while status["completed"] - start < max_tasks:
                if self._pause.is_set() and not status.get("active_task"):
                    break
                status = self._advance_one()
                if status.get("reason") not in (None, "", "running", "budget_yield", "yield", "work_limit", "idle"):
                    break
                pending = status.get("pending", 0)
                if not status.get("active_task") and not pending:
                    break
                time.sleep(0)
            self._pause.set()
            return status

    def pause(self):
        self._pause.set()

    def retry_failed(self):
        with self._core_lock:
            self._check_open()
            self._core.retry()
            self._persist()
        return self.step()

    def grow(self, **capacities):
        with self._core_lock:
            self._check_open()
            self._core.grow(capacities)
            self._persist()
            return self._core.status()

    def resume_budget(self, group, additional):
        with self._core_lock:
            self._check_open()
            self._core.resume_budget(group, additional)
            self._persist()

    def read_output(self, limit=None):
        """Receive a durable private outbox copy; IDs remain until ack_output."""
        handed_batches = self._prepare_frame_handoffs()
        with self._core_lock:
            self._check_open()
            self._collect_outputs()
            self._persist()
            records = [copy.deepcopy(value) for identifier, value in self._outbox.items()
                       if identifier not in self._acknowledged
                       and ("batch_id" not in value or value["batch_id"] in handed_batches)]
            records.sort(key=lambda record: record["output"])
        return records if limit is None else records[:limit]

    def _prepare_frame_handoffs(self):
        if not self.current_model().get("frame_module"):
            return set()
        with self._core_lock:
            batches = self._frame_module().batches()
        handed = set()
        for batch in batches:
            ticket = self._submit([{"_frame_complete": batch["batch_id"]}],
                                  f"{self.instance_id}:frame-host:{batch['batch_id']}")
            ticket.wait("durable" if self._journal else "device_visible")
            handed.add(batch["batch_id"])
        return handed

    def read_frame_batches(self):
        """Host receives a complete immutable batch after queuing its control fact.

        Receipt does not make ACK eligibility visible; the control task must run.
        This conservative interface waits for the whole batch before exposure.
        """
        handed_batches = self._prepare_frame_handoffs()
        with self._core_lock:
            self._collect_outputs()
            self._persist()
            batches = copy.deepcopy(self._frame_module().batches())
            for batch in batches:
                batch["output_ids"] = [f"{self.instance_id}:{identifier}" for identifier in
                                       batch["data_output_ids"] + [batch["marker_output_id"]]]
            return [batch for batch in batches if batch["batch_id"] in handed_batches
                    and any(identifier not in self._acknowledged for identifier in batch["output_ids"])]

    def frame_status(self):
        with self._core_lock:
            return self._frame_module().status()

    def ack_output(self, output_id):
        """Application delivery acknowledgement, not the frame business ACK."""
        with self._core_lock:
            self._check_open()
            if output_id not in self._outbox:
                raise KeyError(output_id)
            self._acknowledged.add(output_id)
            self._persist()

    def drain(self, callback, limit=None):
        records = self.read_output(limit)
        for record in records:
            callback(copy.deepcopy(record))  # No runtime lock around application code.
            self.ack_output(record["output_id"])
        return len(records)

    def snapshot(self, path, *, active=False):
        # Copy a consistent complete state under the core lock. The owned host
        # image can then be synchronized while later device work continues.
        self._pause.set()
        with self._run_lock:
            with self._core_lock:
                status = self._core.status()
            while status.get("active_task") and not active and not status.get("reason"):
                status = self._advance_one()
            with self._core_lock:
                if status.get("active_task") and not active:
                    raise RuntimeError("ordinary snapshot requires a complete task boundary; use active=True for retained work")
                payload = self._payload("active" if active else "boundary")
        write_checkpoint(path, payload)
        return {"path": str(path), "mode": payload["mode"], "sha256": digest(payload)}

    @classmethod
    def restore_runtime(cls, path, *, device="cuda", capacities=None, journal=False, durable_path=None,
                        propagation="parallel", propagation_chunk=128, block_size=128):
        from .backend import Core
        payload = Journal.recover(path) if journal else read_checkpoint(path)
        if payload.get("format") != "jkcuda.runtime.v1" or payload.get("mode") not in {"active", "boundary"}:
            raise RecoveryError("unsupported runtime checkpoint format")
        model = load_model(payload["model"])
        if structure_fingerprint(model) != payload.get("base_model_fingerprint"):
            raise RecoveryError("base structure fingerprint mismatch")
        restored = cls.__new__(cls)
        restored.model = model
        restored._initialize(device, payload["work_slice"])
        try:
            restored._core = Core.from_dump(model, payload["core"], device=device, capacities=capacities,
                                           propagation=propagation, propagation_chunk=propagation_chunk,
                                           block_size=block_size)
            if structure_fingerprint(restored._core.current_model()) != payload.get("structure_fingerprint"):
                raise RecoveryError("installed structure fingerprint mismatch")
            if payload["mode"] == "boundary" and restored._core.status().get("active_task"):
                raise RecoveryError("boundary snapshot contains an unfinished task")
            restored.instance_id = payload["instance_id"]
            if not isinstance(restored.instance_id, str) or not re.fullmatch(r"[0-9a-f]{32}", restored.instance_id):
                raise RecoveryError("invalid instance identity")
            restored._requests = copy.deepcopy(payload["requests"])
            frontier = payload["accepted_frontier"]
            if (type(frontier) is not int or frontier < 0
                    or sorted(r.get("sequence", -1) for r in restored._requests.values()) != list(range(1, frontier + 1))):
                raise RecoveryError("accepted input frontier is inconsistent")
            restored._accepted_frontier = frontier
            enqueued = {row["task"] for row in restored._core.trace() if row["kind"] == "enqueue"}
            owned_tasks = set()
            last_admitted = 0
            for identifier, record in sorted(restored._requests.items(), key=lambda item: item[1]["sequence"]):
                identity = payload["tickets"].get(identifier)
                ids = identity.get("task_ids", []) if isinstance(identity, dict) else []
                if (not ids or any(type(t) is not int for t in ids)
                        or ids != sorted(set(ids)) or ids[0] <= last_admitted):
                    raise RecoveryError("accepted request order disagrees with FIFO admission identities")
                last_admitted = ids[-1]
            for identifier, state in payload["tickets"].items():
                if identifier != state["request_id"] or identifier not in restored._requests:
                    raise RecoveryError("request/ticket identity mismatch")
                record = restored._requests[identifier]
                if not record["accepted"] or digest(record["requests"]) != record["fingerprint"]:
                    raise RecoveryError("invalid accepted request record")
                request = record["requests"][0] if len(record["requests"]) == 1 else {}
                expected_count = len(request["_frame"]) if "_frame" in request else len(record["requests"])
                if (not state["accepted"] or not state["device_visible"]
                        or len(state["task_ids"]) != expected_count
                        or any(type(t) is not int or t not in enqueued or t in owned_tasks for t in state["task_ids"])):
                    raise RecoveryError("invalid accepted task ownership")
                owned_tasks.update(state["task_ids"])
                try:
                    restored._core.validate_request(state["task_ids"], record["requests"], identifier, state.get("details", {}))
                except (ValueError, KeyError, TypeError) as exc:
                    raise RecoveryError(f"request does not own its recorded task payload: {exc}") from exc
                restored._tickets[identifier] = Ticket(**state)
            if restored._requests.keys() != restored._tickets.keys():
                raise RecoveryError("missing accepted ticket")
            restored._outbox = copy.deepcopy(payload["outbox"])
            expected_outbox = {f"{restored.instance_id}:{record['output']}":
                               {"output_id": f"{restored.instance_id}:{record['output']}", **record}
                               for record in restored._device_output_records()}
            if expected_outbox != restored._outbox:
                raise RecoveryError("outbox does not match committed device output identities and payloads")
            restored._acknowledged = set(payload["acknowledged"])
            if not restored._acknowledged <= restored._outbox.keys():
                raise RecoveryError("acknowledged output has no owned payload")
            restored._journal = Journal(durable_path) if durable_path else None
            restored._persist()
            return restored  # Paused; no enqueue, evaluation or event generation.
        except Exception:
            restored._executor.shutdown(wait=True)
            raise

    def status(self):
        with self._core_lock:
            return {**self._core.status(), "paused": self._pause.is_set(), "device": self.device,
                    "instance_id": self.instance_id, "durability_error": self._persistence_error}

    def trace(self):
        with self._core_lock:
            return self._core.trace()

    def observe(self, *, since_trace=0, limit=200, include_model=False):
        """Return a consistent read-only view of the last synchronized mirror.

        Unlike output reception, observation never queues FRAME_COMPLETE,
        initializes a frame module, acknowledges delivery, or advances work.
        ``since_trace`` is the last consumed one-based sequence (zero initially);
        None selects the most recent ``limit`` trace rows.
        """
        from .inspection import observe
        return observe(self, since_trace=since_trace, limit=limit, include_model=include_model)

    def fingerprint(self):
        with self._core_lock:
            payload = self._payload()
            if hasattr(self._core, "logical_state"):
                payload["core"] = self._core.logical_state()
            payload.pop("work_slice", None)
            return digest({"canonicalization": "jkcuda.sha256.v1", "runtime": payload})

    def close(self):
        self.pause()
        self._executor.shutdown(wait=True)
        with self._run_lock:
            self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
