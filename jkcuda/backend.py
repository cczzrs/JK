"""Bounded C++/CUDA interpreter and its explicit native CPU test adapter.

CUDA never falls back to CPU. The complete FIFO state machine, matching and
successor creation execute inside the native/device interpreter. Python owns
ingress linearization, storage growth, transfer synchronization and inspection.
"""
from __future__ import annotations

import array
import copy
import ctypes
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading

SECTIONS = ("queues", "nodes", "sources", "ops", "edges", "states", "tasks",
            "params", "events", "tokens", "traces", "outputs", "txops",
            "txparams", "budgets", "current", "mutations", "frames")
Q, N, S, OP, EDGE, STATE, TASK, PARAM, EVENT, TOKEN, TRACE, OUT, TX, TXP, BUDGET, CURRENT, MUTATION, FRAMES = range(18)
ABI, ACTIVE, STOP, REASON, NTASK, NEVENT, NTOKEN, NOUT, NTRACE, NTX, COMPLETE, ECOUNT, DCOUNT, RCOUNT, GCOUNT, EXCOUNT, EXTERNAL, RES_TASK, RES_TOKEN, RES_TRACE, FAULT_POINT, FAULT_AFTER, FAULT_SEEN, LAST_WORK, LAST_COMPLETE, NENQUEUE, NSELECT, ROOT_VERSION, MODEL_INDEX, NMUTATION = range(30)
DEFAULT_CAPACITIES = {"tasks": 4096, "events": 4096, "tokens": 8192,
                      "traces": 65536, "outputs": 4096, "txops": 4096, "mutations": 4096, "frames": 65536}
_CPU_LIB = None
_CUDA_MODULE = None
_BUILD_LOCK = threading.Lock()


class BackendError(RuntimeError):
    pass


class BackpressureError(BackendError):
    """Ingress rejected atomically; no part of the request was accepted."""


class CudaUnavailableError(BackendError):
    pass


def _positive(value, label):
    if type(value) is not int or not 0 < value < 2**63:
        raise ValueError(f"{label} must be a positive int64")
    return value


def _cpu_library():
    global _CPU_LIB
    with _BUILD_LOCK:
        if _CPU_LIB is not None:
            return _CPU_LIB
        native = Path(__file__).with_name("native")
        digest = hashlib.sha256(b"".join(path.read_bytes() for path in
                                [*sorted(native.glob("*.hpp")), native / "cpu.cpp"])).hexdigest()[:20]
        directory = Path(tempfile.gettempdir()) / f"jkcuda-native-{os.getuid()}-{digest}"
        directory.mkdir(mode=0o700, exist_ok=True)
        library = directory / "core.so"
        if not library.exists():
            compiler = shutil.which("clang++") or shutil.which("g++")
            if compiler is None:
                raise BackendError("native-cpu requires clang++ or g++")
            temporary = directory / f"core-{os.getpid()}.so"
            command = [compiler, "-std=c++17", "-O2", "-shared", "-fPIC",
                       str(native / "cpu.cpp"), "-o", str(temporary)]
            subprocess.run(command, check=True, capture_output=True, text=True)
            os.replace(temporary, library)
        _CPU_LIB = ctypes.CDLL(str(library))
        _CPU_LIB.jk_advance.argtypes = [ctypes.POINTER(ctypes.c_int64), ctypes.c_int64, ctypes.c_int64,
                                      ctypes.c_int64, ctypes.POINTER(ctypes.c_int64), ctypes.c_int64,
                                      ctypes.c_int64, ctypes.c_int64, ctypes.c_int64]
        _CPU_LIB.jk_advance.restype = ctypes.c_int
        return _CPU_LIB


def _cuda_module():
    global _CUDA_MODULE
    with _BUILD_LOCK:
        if _CUDA_MODULE is not None:
            return _CUDA_MODULE
        try:
            import torch
            from torch.utils.cpp_extension import load, CUDA_HOME
        except ImportError as exc:
            raise CudaUnavailableError("CUDA requires a CUDA-enabled PyTorch installation") from exc
        if not torch.cuda.is_available() or CUDA_HOME is None:
            raise CudaUnavailableError("CUDA requires an NVIDIA GPU and the CUDA toolkit (nvcc)")
        native = Path(__file__).with_name("native")
        digest = hashlib.sha256(b"".join(path.read_bytes() for path in
                                [*sorted(native.glob("*.hpp")), native / "bindings.cpp",
                                 native / "engine.cu"])).hexdigest()[:12]
        _CUDA_MODULE = load(name="jkcuda_" + digest,
                            sources=[str(native / "bindings.cpp"), str(native / "engine.cu")],
                            extra_cflags=["-O2", "-std=c++17"],
                            extra_cuda_cflags=["-O2", "-std=c++17", "-lineinfo"], verbose=False)
        return _CUDA_MODULE


class Core:
    """One instance, one active task, one serialized publication coordinator.

    ``advance`` may yield between any execution or propagation phase. It never
    selects another task while an earlier task owns unfinished work. The CUDA
    backend uses one bounded device coordinator kernel per advance call.
    """

    def __init__(self, model, device="native-cpu", capacities=None, *, propagation="parallel",
                 propagation_chunk=128, block_size=128):
        if device != "native-cpu" and not (device == "cuda" or device.startswith("cuda:")):
            raise ValueError("device must be native-cpu or cuda[:index]")
        if propagation not in ("serial", "parallel"):
            raise ValueError("propagation must be serial or parallel")
        if type(propagation_chunk) is not int or not 1 <= propagation_chunk <= 1024:
            raise ValueError("propagation_chunk must be an integer in [1, 1024]")
        if type(block_size) is not int or not 32 <= block_size <= 1024 or block_size % 32:
            raise ValueError("block_size must be a multiple of 32 in [32, 1024]")
        self._propagation = propagation
        self._propagation_chunk = propagation_chunk
        self._block_size = block_size
        self._scratch = None
        self._scratch_tensor = None
        self.model = copy.deepcopy(model)
        self._models = [copy.deepcopy(model)]
        self.device = device
        self._lock = threading.RLock()
        self._keys = []
        self._request_ids = {}
        self._transaction_contracts = {}
        self._fatal = None
        self._tensor = None
        self._physical = {"cuda_kernel_launches": 0, "native_advance_calls": 0,
                          "h2d_transfers": 0, "h2d_bytes": 0,
                          "d2h_transfers": 0, "d2h_bytes": 0,
                          "max_host_arena_bytes": 0,
                          "parallel_batches": 0, "parallel_edges": 0,
                          "parallel_target_groups": 0, "parallel_tasks_formed": 0,
                          "max_parallel_chunk": 0,
                          "cuda_device_peak_allocated_bytes": None,
                          "cuda_device_peak_reserved_bytes": None}
        self._capacities = dict(DEFAULT_CAPACITIES)
        if capacities:
            self._set_capacities(capacities)
        self._compile_model()
        self._allocate()
        self._m(ABI, 2)
        self._m(ACTIVE, -1)
        for section, rows in self._static.items():
            for index, row in enumerate(rows):
                self._write(section, index, row)
        if self.device == "native-cpu":
            self._native = _cpu_library()
        else:
            self._native = _cuda_module()
            import torch
            self._torch = torch
            self._stream = torch.cuda.Stream(device=self.device)
            self._upload()

    def _set_capacities(self, capacities):
        for name, value in capacities.items():
            if name not in DEFAULT_CAPACITIES:
                raise ValueError(f"unknown capacity {name!r}")
            self._capacities[name] = _positive(value, f"capacity {name}")

    def _compile_model(self):
        self._node_ids = []
        self._logical_ids = list(dict.fromkeys(n["id"] for model in self._models for n in model["nodes"]))
        logical_map = {name: i for i, name in enumerate(self._logical_ids)}
        self._state_ids = list(dict.fromkeys(s["id"] for model in self._models for s in model.get("states", [])))
        state_map = {name: i for i, name in enumerate(self._state_ids)}
        initial_states = {}
        for model in self._models:
            for state in model.get("states", []):
                initial_states.setdefault(state["id"], state["initial"])
        self._queue_names = [q["name"] for q in self.model["queues"]]
        self._queue_map = {name: i for i, name in enumerate(self._queue_names)}
        self._output_names = list(dict.fromkeys(n["output"] for model in self._models for n in model["nodes"] if n.get("output") is not None))
        output_map = {name: i for i, name in enumerate(self._output_names)}
        budgets = self.model.get("budgets", [])
        budget_map = {b["id"]: i for i, b in enumerate(budgets)}
        self._param_names, nodes, sources, ops, edges = [], [], [], [], []
        self._version_maps = []
        for model in self._models:
            node_map = {node["id"]: len(nodes) + i for i, node in enumerate(model["nodes"])}
            model_nodes = {node["id"]: node for node in model["nodes"]}
            outgoing_by_source = {identifier: [] for identifier in node_map}
            for edge in model.get("subscriptions", []):
                outgoing_by_source[edge["source"]].append(edge)
            for outgoing in outgoing_by_source.values():
                outgoing.sort(key=lambda edge: edge["order"])
            self._version_maps.append(node_map)
            for node in model["nodes"]:
                i = len(nodes)
                self._node_ids.append(node["id"])
                ports = list(node["trigger"]["ports"])
                params = list(ports)
                for _, source in sorted(node["sources"].items()):
                    if source["kind"] == "PARAM" and source["param"] not in params:
                        params.append(source["param"])
                self._param_names.append(params)
                source_start = len(sources)
                source_map = {}
                for name, source in sorted(node["sources"].items()):
                    source_map[name] = len(sources)
                    kind = source["kind"]
                    if kind == "CONST": row = [0, source["value"], 0]
                    elif kind == "STATE": row = [1, state_map[source["state"]], 0]
                    elif kind == "PARAM": row = [2, params.index(source["param"]), 0]
                    elif kind == "SELF": row = [3, 0, 0]
                    elif kind == "VALUE": row = [4, model["values"][source["value_id"]], 0]
                    else: raise ValueError(f"unknown source kind {kind!r}")
                    sources.append(row)
                op_start = len(ops)
                for operator, name in node["ops"]:
                    if operator not in ("J", "K"): raise ValueError("invalid operation")
                    ops.append([0 if operator == "J" else 1, source_map[name]])
                outgoing = outgoing_by_source[node["id"]]
                edge_start = len(edges)
                for edge in outgoing:
                    target = node_map[edge["target"]]
                    ports_target = model_nodes[edge["target"]]["trigger"]["ports"]
                    edges.append([i, target, ports_target.index(edge["port"]), edge["order"]])
                nodes.append([state_map[node["state"]] if node.get("state") is not None else -1,
                              node.get("seed", 0), op_start, len(node["ops"]), source_start,
                              len(node["sources"]), ("ANY", "ALL_LATEST", "ZIP", "KEYED").index(node["trigger"]["mode"]),
                              len(ports), self._queue_map[node["queue"]],
                              ("always", "zero", "one", "never", "changed").index(node["publish"]),
                              output_map[node["output"]] if node.get("output") is not None else -1,
                              edge_start, len(outgoing), node.get("generation", 1), node.get("version", 1),
                              budget_map[node["budget_group"]] if node.get("budget_group") is not None else -1,
                              logical_map[node["id"]]])
        self._max_params = max(1, *(len(p) for p in self._param_names))
        self._widths = [4, 17, 3, 2, 4, 2, 16, self._max_params, 9, 8, 10, 8, 8, self._max_params, 3, 1, 3, 1]
        self._static = {Q: [[q["priority"], -1, -1, 0] for q in self.model["queues"]],
                        N: nodes, S: sources, OP: ops, EDGE: edges,
                        STATE: [[initial_states[name], 0] for name in self._state_ids],
                        BUDGET: [[b["id"], b["limit"], 0] for b in budgets],
                        CURRENT: [[self._version_maps[0].get(name, -1)] for name in self._logical_ids]}
        self._node_map = dict(self._version_maps[0])

    def _refresh_current(self):
        self._node_map = {name: self._row(CURRENT, i)[0] for i, name in enumerate(self._logical_ids)
                          if self._row(CURRENT, i)[0] >= 0}

    def current_model(self):
        return copy.deepcopy(self._models[self._m(MODEL_INDEX)])

    def _allocate(self):
        self._sizes = [len(self._static.get(s, [])) for s in range(len(SECTIONS))]
        for name, size in self._capacities.items():
            self._sizes[SECTIONS.index(name)] = size
        self._sizes[PARAM] = self._sizes[TASK]
        self._sizes[TXP] = self._sizes[TX]
        total = 128 + sum(w * s for w, s in zip(self._widths, self._sizes))
        self._arena = array.array("q", [0]) * total
        self._physical["max_host_arena_bytes"] = max(self._physical["max_host_arena_bytes"], total * 8)
        if self._arena.itemsize != 8:
            raise BackendError("int64 array storage is required")
        offset = 128
        self._offsets = []
        for section, (width, size) in enumerate(zip(self._widths, self._sizes)):
            self._offsets.append(offset)
            self._arena[64 + section * 3:67 + section * 3] = array.array("q", [offset, size, width])
            offset += width * size

    def _m(self, key, value=None):
        if value is not None:
            self._arena[key] = value
        return self._arena[key]

    def _row(self, section, index):
        begin = self._offsets[section] + self._widths[section] * index
        return list(self._arena[begin:begin + self._widths[section]])

    def _write(self, section, index, values):
        if not 0 <= index < self._sizes[section] or len(values) != self._widths[section]:
            raise BackendError("invalid arena write")
        begin = self._offsets[section] + self._widths[section] * index
        self._arena[begin:begin + len(values)] = array.array("q", values)

    def _upload(self):
        if self.device == "native-cpu":
            return
        try:
            with self._torch.cuda.device(self.device), self._torch.cuda.stream(self._stream):
                # Keep the previous device root until a fully transferred new
                # root is available. OOM never publishes a partial ingress.
                host = self._torch.frombuffer(self._arena, dtype=self._torch.int64).clone()
                candidate = host.to(self.device)
            self._stream.synchronize()
            self._tensor = candidate
            self._physical["h2d_transfers"] += 1
            self._physical["h2d_bytes"] += len(self._arena) * 8
            self._cuda_memory_metrics()
        except self._torch.cuda.OutOfMemoryError as exc:
            raise BackpressureError("CUDA allocation failed; the previous device root is retained") from exc
        except Exception as exc:
            self._fatal = str(exc)
            raise BackendError("CUDA transfer failed; the execution domain must be rebuilt") from exc

    def _admission_checkpoint(self):
        return (self._arena[:], list(self._keys), dict(self._request_ids),
                dict(self._transaction_contracts))

    def _admission_rollback(self, checkpoint):
        self._arena, self._keys, self._request_ids, self._transaction_contracts = checkpoint

    def _sync_admission(self, checkpoint):
        try:
            self._upload()
        except BaseException:
            self._admission_rollback(checkpoint)
            raise

    def _download(self):
        if self.device == "native-cpu":
            return
        try:
            self._stream.synchronize()
            data = self._tensor.cpu().tolist()
            self._physical["d2h_transfers"] += 1
            self._physical["d2h_bytes"] += len(data) * 8
            self._arena = array.array("q", data)
            self._cuda_memory_metrics()
        except Exception as exc:
            self._fatal = str(exc)
            raise BackendError("CUDA execution domain failed; restore a trusted checkpoint in a new process") from exc

    def _cuda_memory_metrics(self):
        if self.device == "native-cpu" or self._fatal is not None:
            return
        # PyTorch's allocator peaks cover the entire process on this device.
        # Do not reset them and thereby disturb other instances/applications.
        self._physical["cuda_device_peak_allocated_bytes"] = self._torch.cuda.max_memory_allocated(self.device)
        self._physical["cuda_device_peak_reserved_bytes"] = self._torch.cuda.max_memory_reserved(self.device)

    def _frame_credit(self, field):
        if self._sizes[FRAMES] >= 32 and self._row(FRAMES, 0)[0] >= 32:
            return self._row(FRAMES, field)[0]
        return 0

    def _ensure_healthy(self):
        if self._fatal is not None:
            raise BackendError("CUDA execution domain is invalid; in-place retry is prohibited")

    def _key(self, key):
        if key is None:
            return -1
        if type(key) not in (str, int) or isinstance(key, int) and not -(2**63) <= key < 2**63:
            raise ValueError("key must be a string, int64, or None")
        for index, existing in enumerate(self._keys):
            if type(existing) is type(key) and existing == key:
                return index
        self._keys.append(key)
        return len(self._keys) - 1

    def _decode_key(self, key):
        return None if key == -1 else self._keys[key]

    def _pack_params(self, node, params, result_refs=None, before=0):
        if not isinstance(params, dict):
            raise ValueError("params must be a dictionary")
        names = self._param_names[node]
        values = [-1] * self._max_params
        for name, value in params.items():
            if name not in names:
                raise ValueError(f"unknown parameter {name!r}")
            if type(value) is not int or value not in (0, 1):
                raise ValueError("parameters must be integer 0 or 1")
            values[names.index(name)] = value
        for name, ref in (result_refs or {}).items():
            if name not in names or name in params or type(ref) is not int or not 0 <= ref < before:
                raise ValueError("result_refs must refer to an earlier internal EX and a distinct declared parameter")
            values[names.index(name)] = -ref - 2
        return values

    def enqueue(self, requests):
        """Atomically accept a list; assigning positions does not execute work."""
        with self._lock:
            self._ensure_healthy()
            if not isinstance(requests, list) or not requests:
                raise ValueError("enqueue requires a nonempty list")
            packed = []
            tx_needed = 0
            protected = set((self._models[self._m(MODEL_INDEX)].get("business_module") or {}).get("protected_nodes", []))
            for request in requests:
                if "transaction" in request:
                    steps = request["transaction"]
                    if not isinstance(steps, list) or not steps:
                        raise ValueError("transaction must contain declared internal EX steps")
                    queue = self._queue_map[request["queue"]]
                    operations = []
                    for index, step in enumerate(steps):
                        if step["node"] in protected:
                            raise ValueError("business nodes can only be scheduled by their declared frame pipeline")
                        node = self._node_map[step["node"]]
                        params = self._pack_params(node, step.get("params", {}), step.get("result_refs"), index)
                        operations.append((node, params))
                    packed.append((-1, queue, None, operations, request))
                    tx_needed += len(steps)
                else:
                    if request["node"] in protected:
                        raise ValueError("business nodes can only be scheduled by their declared frame pipeline")
                    node = self._node_map[request["node"]]
                    queue = self._row(N, node)[8]
                    params = self._pack_params(node, request.get("params", {}))
                    packed.append((node, queue, params, None, request))
                key = request.get("key")
                if key is not None and type(key) not in (str, int):
                    raise ValueError("key must be a string, int64, or None")
                if type(key) is int and not -(2**63) <= key < 2**63:
                    raise ValueError("integer key out of range")
            count = len(packed)
            if self._m(NTASK) + self._m(RES_TASK) + self._frame_credit(24) + count > self._sizes[TASK]:
                raise BackpressureError("task capacity exhausted; no request accepted")
            if self._m(NTRACE) + self._m(RES_TRACE) + self._frame_credit(25) + count > self._sizes[TRACE]:
                raise BackpressureError("trace capacity exhausted; no request accepted")
            if self._m(NTX) + tx_needed > self._sizes[TX]:
                raise BackpressureError("transaction capacity exhausted; no request accepted")
            checkpoint = self._admission_checkpoint()
            ids = []
            for node, queue, params, operations, request in packed:
                task = self._m(NTASK)
                key = self._key(request.get("key"))
                tx_start = self._m(NTX) if operations else -1
                tx_count = len(operations) if operations else 0
                row = [node, key, queue, -1, 0, -1, -1, -1, 0, 0, -1, -1, tx_start, tx_count, -1, -1]
                self._write(TASK, task, row)
                self._write(PARAM, task, params if params is not None else [-1] * self._max_params)
                if operations:
                    for internal_node, internal_params in operations:
                        index = self._m(NTX)
                        self._write(TX, index, [task, internal_node, -1, -1, 0, -1, -1, -1])
                        self._write(TXP, index, internal_params)
                        self._m(NTX, index + 1)
                    self._transaction_contracts[str(task + 1)] = request.get("contract")
                q = self._row(Q, queue)
                if q[2] >= 0:
                    last = self._row(TASK, q[2]); last[3] = task; self._write(TASK, q[2], last)
                else:
                    q[1] = task
                q[2] = task; q[3] += 1; self._write(Q, queue, q)
                trace = [1, task, node, -1, -1, -1, key, -1, -1, -1]
                self._write(TRACE, self._m(NTRACE), trace)
                self._m(NTRACE, self._m(NTRACE) + 1)
                self._m(NTASK, task + 1)
                self._m(NENQUEUE, self._m(NENQUEUE) + 1)
                self._m(EXTERNAL, self._m(EXTERNAL) + 1)
                self._request_ids[str(task + 1)] = request.get("request_id")
                ids.append(task + 1)
            self._sync_admission(checkpoint)
            return ids

    def _external_task_indices(self, task_ids):
        if not isinstance(task_ids, list) or not task_ids:
            raise ValueError("request must own a nonempty ordered task list")
        if any(type(t) is not int or not 1 <= t <= self._m(NTASK) for t in task_ids):
            raise ValueError("request owns an invalid task identity")
        if any(left >= right for left, right in zip(task_ids, task_ids[1:])):
            raise ValueError("request task identities must preserve admission order")
        indices = [t - 1 for t in task_ids]
        if any(self._row(TASK, t)[10] != -1 or self._row(TASK, t)[11] != -1 for t in indices):
            raise ValueError("an external request cannot own an internally generated task")
        return indices

    def bind_request(self, task_ids, request_id):
        """Bind accepted host identity to the actual owned task ledger.

        This records provenance only; it does not execute or alter a model task.
        Runtime calls it before publishing the accepted ticket and before WAL.
        """
        if not isinstance(request_id, str) or not request_id:
            raise ValueError("request_id must be a nonempty string")
        with self._lock:
            self._external_task_indices(task_ids)
            supplied = {str(t) for t in task_ids}
            existing = {t for t, owner in self._request_ids.items() if owner == request_id}
            if existing - supplied or any(self._request_ids.get(str(t)) not in (None, request_id) for t in task_ids):
                raise ValueError("request/task ownership cannot be reassigned")
            for task in task_ids:
                self._request_ids[str(task)] = request_id

    def validate_request(self, task_ids, requests, request_id, details=None):
        """Validate a recovered ticket against immutable native task payloads."""
        with self._lock:
            indices = self._external_task_indices(task_ids)
            if not isinstance(request_id, str) or not request_id:
                raise ValueError("invalid recovered request identity")
            actual_owned = {task for task, owner in self._request_ids.items() if owner == request_id}
            if actual_owned != {str(task) for task in task_ids}:
                raise ValueError("request/ticket task ownership differs from the native ledger")
            if not isinstance(requests, list) or not requests or any(not isinstance(r, dict) for r in requests):
                raise ValueError("invalid recovered request payload")

            def key_matches(task, request):
                expected = request.get("key")
                actual = self._decode_key(task[1])
                if type(expected) is not type(actual) or expected != actual:
                    raise ValueError("request key differs from its task's immutable key")

            def frame_words(at, count):
                used = self._used(FRAMES)
                if type(at) is not int or not 32 <= at <= used - count:
                    raise ValueError("request points outside owned frame payload")
                return [self._row(FRAMES, at + offset)[0] for offset in range(count)]

            special = requests[0] if len(requests) == 1 else {}
            if "_frame" in special:
                bits = special["_frame"]
                if not isinstance(bits, list) or not bits or len(bits) != len(indices) or any(type(v) is not int or v not in (0, 1) for v in bits):
                    raise ValueError("frame request width/payload differs from its ticket")
                frame_at = None
                for position, (task_index, value) in enumerate(zip(indices, bits)):
                    task = self._row(TASK, task_index)
                    if task[0] != -3 or task[15] != 1 or task[2] != self._row(FRAMES, 4)[0] or task[1] != -1:
                        raise ValueError("frame ticket owns a different control program")
                    frame, actual_position, actual_value = frame_words(task[14], 3)
                    if frame_at is None:
                        frame_at = frame
                    if frame != frame_at or actual_position != position or actual_value != value:
                        raise ValueError("frame request differs from immutable input-task payload")
                frame_record = frame_words(frame_at, 22)
                from .frames import frame_input_width
                if frame_input_width(self, frame_at) != len(bits):
                    raise ValueError("frame task ownership does not cover its complete width")
                if details is not None and details != {"frame_id": frame_record[2], "generation": frame_record[3]}:
                    raise ValueError("ticket frame identity differs from its native frame")
                return True

            if details is not None and details != {}:
                raise ValueError("unexpected request ticket details")

            if "_frame_ack" in special or "_frame_complete" in special:
                if len(indices) != 1:
                    raise ValueError("frame control must own exactly one task")
                task = self._row(TASK, indices[0])
                if task[0] != -3 or task[2] != self._row(FRAMES, 5)[0] or task[1] != -1:
                    raise ValueError("frame control ticket owns a different task")
                if "_frame_ack" in special:
                    value = special["_frame_ack"]
                    if type(value) is not int or value not in (0, 1) or task[15] != 3 or frame_words(task[14], 1) != [value]:
                        raise ValueError("ACK request differs from its immutable decoder payload")
                else:
                    batch_id = special["_frame_complete"]
                    if type(batch_id) is not int or batch_id < 1 or task[15] != 5:
                        raise ValueError("invalid frame completion request")
                    at, generation, slot_generation, output_id = frame_words(task[14], 4)
                    batch = frame_words(at, 16)
                    if batch[1] != batch_id or [generation, slot_generation, output_id] != [batch[3], batch[4], batch[11]] or batch[10] != task_ids[0]:
                        raise ValueError("completion request differs from its immutable batch identity")
                return True

            if "_structure" in special:
                from .model import load_model
                if len(indices) != 1:
                    raise ValueError("structure request must own exactly one task")
                task = self._row(TASK, indices[0])
                if task[0] != -2 or task[1] != -1 or self._queue_names[task[2]] != special.get("queue") or not 0 <= task[14] < len(self._models):
                    raise ValueError("structure request/task identity differs")
                if self._models[task[14]] != load_model(special["_structure"]):
                    raise ValueError("structure request differs from its prepared immutable model")
                return True

            if len(indices) != len(requests):
                raise ValueError("request task count differs from its native records")
            for task_index, request in zip(indices, requests):
                task = self._row(TASK, task_index)
                key_matches(task, request)
                if "transaction" in request:
                    steps = request["transaction"]
                    if task[0] != -1 or not isinstance(steps, list) or len(steps) != task[13] or self._queue_names[task[2]] != request.get("queue") or self._transaction_contracts.get(str(task_index + 1)) != request.get("contract"):
                        raise ValueError("transaction request differs from its native task contract")
                    for position, step in enumerate(steps):
                        operation = self._row(TX, task[12] + position)
                        node = operation[1]
                        if not isinstance(step, dict) or self._node_ids[node] != step.get("node"):
                            raise ValueError("transaction internal target differs from its request")
                        expected = self._pack_params(node, step.get("params", {}), step.get("result_refs"), position)
                        if self._row(TXP, task[12] + position) != expected:
                            raise ValueError("transaction parameters/result dependencies differ from its request")
                else:
                    node = task[0]
                    if node < 0 or self._node_ids[node] != request.get("node"):
                        raise ValueError("request target differs from its bound native task")
                    if self._row(PARAM, task_index) != self._pack_params(node, request.get("params", {})):
                        raise ValueError("request parameters differ from immutable task payload")
            return True

    def _enqueue_control(self, node, queue, *, key=None, field14=-1, field15=-1,
                         start=-1, count=0):
        """Module admission hook. Caller holds _lock and owns immutable payload."""
        queue = self._queue_map[queue]
        if self._m(NTASK) + self._m(RES_TASK) + self._frame_credit(24) >= self._sizes[TASK] or self._m(NTRACE) + self._m(RES_TRACE) + self._frame_credit(25) >= self._sizes[TRACE]:
            raise BackpressureError("control task capacity exhausted")
        checkpoint = self._admission_checkpoint()
        task = self._m(NTASK)
        encoded_key = self._key(key)
        self._write(TASK, task, [node, encoded_key, queue, -1, 0, -1, -1, -1, 0, 0,
                                 -1, -1, start, count, field14, field15])
        self._write(PARAM, task, [-1] * self._max_params)
        q = self._row(Q, queue)
        if q[2] >= 0:
            tail = self._row(TASK, q[2]); tail[3] = task; self._write(TASK, q[2], tail)
        else:
            q[1] = task
        q[2] = task; q[3] += 1; self._write(Q, queue, q)
        self._write(TRACE, self._m(NTRACE), [1, task, node, -1, -1, -1, encoded_key, -1, -1, -1])
        self._m(NTASK, task + 1); self._m(NTRACE, self._m(NTRACE) + 1)
        self._m(NENQUEUE, self._m(NENQUEUE) + 1); self._m(EXTERNAL, self._m(EXTERNAL) + 1)
        self._sync_admission(checkpoint)
        return task + 1

    def modify(self, candidate_model, *, queue):
        """Queue an atomic model-root switch; old program/task versions survive.

        Trigger changes with residual tokens are rejected when this task executes.
        Unchanged trigger state retains its tokens while switching program versions.
        Budget membership/limits cannot be changed by this operation.
        """
        from .model import load_model, strongly_connected
        candidate = load_model(candidate_model)
        with self._lock:
            self._ensure_healthy()
            current = self.current_model()
            if candidate["queues"] != current["queues"] or candidate.get("budgets", []) != current.get("budgets", []):
                raise ValueError("structure changes cannot redefine FIFO priorities or budgets")
            if queue not in self._queue_map:
                raise ValueError("unknown structure task queue")
            for i in range(self._m(NTASK)):
                task = self._row(TASK, i)
                if task[0] == -2 and task[4] != 4:
                    raise BackpressureError("finish the already queued structure task before preparing another version")
            old_nodes = {n["id"]: n for n in current["nodes"]}
            new_nodes = {n["id"]: n for n in candidate["nodes"]}
            if current.get("frame_module") != candidate.get("frame_module"):
                raise ValueError("frame module configuration is immutable for this execution domain")
            if current.get("business_module") != candidate.get("business_module"):
                raise ValueError("business module configuration is immutable for this execution domain")
            if current.get("business_module"):
                for identifier in current["business_module"]["protected_nodes"]:
                    if old_nodes.get(identifier) != new_nodes.get(identifier):
                        raise ValueError("registered business nodes retain immutable program bindings")
            if current.get("frame_module"):
                config = current["frame_module"]
                for identifier in (config["data_node"], config["marker_node"]):
                    if old_nodes.get(identifier) != new_nodes.get(identifier):
                        raise ValueError("registered frame adapters retain immutable node/program bindings")
            def cyclic_components(model):
                edges = [(edge["source"], edge["target"]) for edge in model.get("subscriptions", [])]
                self_edges = {source for source, target in edges if source == target}
                groups = strongly_connected([node["id"] for node in model["nodes"]], edges)
                return sorted(tuple(group) for group in groups if len(group) > 1 or group[0] in self_edges)
            if cyclic_components(current) != cyclic_components(candidate):
                raise ValueError("changing cyclic SCC membership requires an explicit budget inheritance contract")
            for budget in current.get("budgets", []):
                group = budget["id"]
                before = {n["id"] for n in old_nodes.values() if n.get("budget_group") == group}
                after = {n["id"] for n in new_nodes.values() if n.get("budget_group") == group}
                if before != after:
                    raise ValueError("SCC budget inheritance for merges/splits must be explicitly defined")
            all_history = {}
            for model in self._models:
                for node in model["nodes"]:
                    all_history.setdefault(node["id"], []).append(node)
            program_fields = ("state", "seed", "ex", "ops", "sources", "publish", "output", "queue")
            for identifier, node in new_nodes.items():
                previous = old_nodes.get(identifier)
                historic = all_history.get(identifier, [])
                if previous is not None:
                    if node["generation"] != previous["generation"]:
                        raise ValueError("a live logical node cannot change generation")
                    changed = any(node.get(k) != previous.get(k) for k in program_fields)
                    if changed and node["version"] <= previous["version"]:
                        raise ValueError("changed programs require an increasing explicit version")
                    if not changed and node["version"] < previous["version"]:
                        raise ValueError("program versions cannot decrease")
                elif historic and node["generation"] <= max(n["generation"] for n in historic):
                    raise ValueError("reused logical ID requires a newer generation")
                if previous is None and historic and node.get("state") is not None and any(node["state"] == n.get("state") for n in historic):
                    raise ValueError("a reused node generation requires a distinct state slot to isolate old holders")
            initial = {s["id"]: s["initial"] for model in self._models for s in model.get("states", [])}
            old_values = {identifier: value for model in self._models for identifier, value in model.get("values", {}).items()}
            for identifier, value in candidate.get("values", {}).items():
                if identifier in old_values and old_values[identifier] != value:
                    raise ValueError("an immutable VALUE identity cannot be rebound")
            for state in candidate.get("states", []):
                if state["id"] in initial and initial[state["id"]] != state["initial"]:
                    raise ValueError("changing an existing state's initial value requires a distinct state ID")
            changes = {}
            def incoming(model, identifier):
                return sorted((e["source"], e["port"], e["order"]) for e in model.get("subscriptions", []) if e["target"] == identifier)
            for identifier in set(old_nodes) | set(new_nodes):
                old, new = old_nodes.get(identifier), new_nodes.get(identifier)
                changes[identifier] = int(old is None or new is None or old["trigger"] != new["trigger"] or incoming(current, identifier) != incoming(candidate, identifier))
            mutation_count = len(set(self._logical_ids) | set(new_nodes))
            if self._m(NTASK) + self._m(RES_TASK) + self._frame_credit(24) >= self._sizes[TASK] or self._m(NTRACE) + self._m(RES_TRACE) + self._frame_credit(25) >= self._sizes[TRACE] or self._m(NMUTATION) + mutation_count > self._sizes[MUTATION]:
                raise BackpressureError("structure request capacity exhausted; nothing accepted")
            previous_attributes = dict(self.__dict__)
            try:
                snapshot = self.dump()
                self._models = self._models + [candidate]
                model_index = len(self._models) - 1
                self._compile_model()
                self._allocate()
                logical = snapshot["logical"]
                logical["model_history"] = copy.deepcopy(self._models)
                for section in (N, S, OP, EDGE):
                    logical["sections"][SECTIONS[section]] = copy.deepcopy(self._static[section])
                for section in (STATE, CURRENT):
                    rows = logical["sections"][SECTIONS[section]]
                    rows.extend(copy.deepcopy(self._static[section][len(rows):]))
                for section in (PARAM, TXP):
                    for row in logical["sections"][SECTIONS[section]]:
                        row.extend([-1] * (self._max_params - len(row)))
                self._restore(snapshot)
                start = self._m(NMUTATION)
                for i, identifier in enumerate(self._logical_ids):
                    new_slot = self._version_maps[model_index].get(identifier, -1)
                    self._write(MUTATION, start + i, [i, new_slot, changes.get(identifier, 0)])
                self._m(NMUTATION, start + len(self._logical_ids))
                return self._enqueue_control(-2, queue, start=start, count=len(self._logical_ids), field14=model_index)
            except BaseException:
                fatal = self._fatal
                self.__dict__.clear(); self.__dict__.update(previous_attributes)
                if fatal is not None: self._fatal = fatal
                raise

    def advance(self, max_work=10000, max_tasks=1):
        _positive(max_work, "max_work"); _positive(max_tasks, "max_tasks")
        with self._lock:
            self._ensure_healthy()
            scratch_words = 32 + self._propagation_chunk * (20 + self._max_params)
            if self._scratch is None or len(self._scratch) != scratch_words:
                self._scratch = array.array("q", [0]) * scratch_words
            if self.device == "native-cpu":
                buffer = (ctypes.c_int64 * len(self._arena)).from_buffer(self._arena)
                workspace = (ctypes.c_int64 * scratch_words).from_buffer(self._scratch)
                if self._native.jk_advance(buffer, len(self._arena), max_work, max_tasks,
                                           workspace, scratch_words, self._propagation_chunk,
                                           self._block_size, self._propagation == "parallel"):
                    raise BackendError("native arena ABI/layout mismatch")
                self._physical["native_advance_calls"] += 1
                counters = list(self._scratch[:5])
            else:
                if self._scratch_tensor is None or self._scratch_tensor.numel() != scratch_words:
                    try:
                        with self._torch.cuda.device(self.device), self._torch.cuda.stream(self._stream):
                            self._scratch_tensor = self._torch.empty(scratch_words, dtype=self._torch.int64,
                                                                     device=self.device)
                    except self._torch.cuda.OutOfMemoryError as exc:
                        raise BackpressureError("propagation workspace allocation failed; active task retained") from exc
                try:
                    with self._torch.cuda.device(self.device), self._torch.cuda.stream(self._stream):
                        self._native.advance(self._tensor, max_work, max_tasks, self._scratch_tensor,
                                             self._propagation_chunk, self._block_size,
                                             self._propagation == "parallel")
                        self._physical["cuda_kernel_launches"] += 1
                    self._download()
                    counters = self._scratch_tensor[:5].cpu().tolist()
                    self._physical["d2h_transfers"] += 1
                    self._physical["d2h_bytes"] += 5 * 8
                except Exception as exc:
                    self._fatal = str(exc)
                    raise BackendError("CUDA execution failed; in-place retry is prohibited") from exc
            for name, value in zip(("parallel_batches", "parallel_edges", "parallel_target_groups",
                                    "parallel_tasks_formed"), counters[:4]):
                self._physical[name] += value
            self._physical["max_parallel_chunk"] = max(self._physical["max_parallel_chunk"], counters[4])
            self._refresh_current()
            return self.status()

    def status(self):
        with self._lock:
            active = self._m(ACTIVE)
            stopped = self._m(STOP)
            phase = "IDLE" if active < 0 else ("QUEUED", "ACTIVE", "EXECUTED", "PROPAGATING", "COMPLETE", "MISSING")[self._row(TASK, active)[4]]
            reason = None
            if stopped == 1:
                reason = "capacity:" + SECTIONS[self._m(REASON)]
            elif stopped == 2:
                exhausted = "frame_identity_exhausted" if active >= 0 and self._row(TASK, active)[0] == -3 else "version_exhausted"
                reason = {5: "frame_protocol_error", 6: exhausted, 100: "invalid_device_layout"}.get(self._m(REASON), "injected_fault")
            elif stopped == 3:
                reason = "budget"
            installed_states = {state["id"] for state in self._models[self._m(MODEL_INDEX)].get("states", [])}
            all_states = {name: {"value": self._row(STATE, i)[0], "version": self._row(STATE, i)[1]}
                          for i, name in enumerate(self._state_ids)}
            return {"device": self.device, "active_task": None if active < 0 else active + 1,
                    "propagation": {"mode": self._propagation, "chunk": self._propagation_chunk,
                                    "block_size": self._block_size},
                    "phase": phase, "status": ("ready", "resource_wait", "failed", "budget_paused")[stopped],
                    "reason": reason, "completed": self._m(COMPLETE),
                    "pending": sum(self._row(Q, q)[3] for q in range(self._sizes[Q])),
                    "states": {name: value for name, value in all_states.items() if name in installed_states},
                    "retained_states": {name: value for name, value in all_states.items() if name not in installed_states},
                    "physical_metrics": {**self._physical, "host_arena_bytes": len(self._arena) * 8,
                                         "propagation_scratch_bytes": (32 + self._propagation_chunk * (20 + self._max_params)) * 8,
                                         "device_arena_bytes": 0 if self.device == "native-cpu" else len(self._arena) * 8},
                    "budgets": [{"id": self._row(BUDGET, i)[0], "limit": self._row(BUDGET, i)[1], "used": self._row(BUDGET, i)[2]} for i in range(self._sizes[BUDGET])],
                    "metrics": {"E": self._m(ECOUNT), "D": self._m(DCOUNT), "R": self._m(RCOUNT), "G": self._m(GCOUNT),
                                "ex_evaluations": self._m(EXCOUNT), "external_enqueued": self._m(EXTERNAL),
                                "completed_tasks": self._m(COMPLETE), "last_work": self._m(LAST_WORK),
                                "last_completed": self._m(LAST_COMPLETE)}}

    def _node_name(self, slot):
        return None if slot < 0 else self._node_ids[slot]

    def _task_params(self, task):
        node = self._row(TASK, task)[0]
        if node < 0:
            return {}
        params = self._row(PARAM, task)
        return {name: params[i] for i, name in enumerate(self._param_names[node]) if params[i] >= 0}

    def trace(self):
        with self._lock:
            result = []
            for index in range(self._m(NTRACE)):
                kind, task, node, value, event, port, key, x, y, z = self._row(TRACE, index)
                name = self._node_name(node)
                task_id = task + 1
                if kind == 1:
                    row = {"kind": "enqueue", "task": task_id, "node": name,
                           "queue": self._queue_names[self._row(TASK, task)[2]],
                           "key": self._decode_key(key), "params": self._task_params(task)}
                elif kind == 2:
                    row = {"kind": "select", "task": task_id, "node": name}
                elif kind == 3:
                    row = {"kind": "bind", "task": task_id, "node": name, "seed": value}
                elif kind == 4:
                    row = {"kind": "commit", "task": task_id, "node": name, "value": value,
                           "state_version": None if x < 0 else x}
                elif kind == 5:
                    row = {"kind": "event", "task": task_id, "node": name, "event": event + 1,
                           "value": value, "key": self._decode_key(key)}
                elif kind == 6:
                    row = {"kind": "delivery", "task": task_id, "event": event + 1,
                           "source": self._node_name(x), "target": name,
                           "port": self._param_names[node][port], "value": value,
                           "key": self._decode_key(key)}
                elif kind == 7:
                    row = {"kind": "match", "event": event + 1, "node": name,
                           "params": self._task_params(task), "key": self._decode_key(key)}
                elif kind == 8:
                    row = {"kind": "complete", "task": task_id, "node": name,
                           "outcome": "missing" if value else "computed"}
                elif kind == 9:
                    row = {"kind": "output", "output": x + 1, "task": task_id, "node": name,
                           "port": self._output_names[port], "value": value,
                           "key": self._decode_key(key), "event": event + 1}
                elif kind == 10:
                    row = {"kind": "structure", "task": task_id, "model_version": value,
                           "outcome": "applied" if x else "rejected_pending_tokens"}
                else:
                    raise BackendError("invalid trace kind")
                result.append(row)
            return result

    def outputs(self):
        with self._lock:
            result = []
            for index in range(self._m(NOUT)):
                task, node, value, key, event, port, _, internal = self._row(OUT, index)
                result.append({"output": index + 1, "task": task + 1, "node": self._node_ids[node],
                               "port": self._output_names[port], "value": value,
                               "key": self._decode_key(key), "event": event + 1})
            return result

    def set_fault(self, point, after=0):
        points = {"before_commit": 1, "after_commit": 2, "before_delivery": 3, "after_delivery": 4}
        if point not in points or type(after) is not int or not 0 <= after < 2**63:
            raise ValueError("invalid fault point or counter")
        with self._lock:
            self._m(FAULT_POINT, points[point]); self._m(FAULT_AFTER, after); self._m(FAULT_SEEN, 0)
            self._upload()

    def retry(self):
        with self._lock:
            self._ensure_healthy()
            if self._m(STOP) == 3:
                raise BackendError("budget pause requires resume_budget")
            if self._m(STOP) == 2 and self._m(REASON) in (5, 6, 100):
                raise BackendError("invalid program/layout or exhausted identity cannot be retried in place")
            self._m(STOP, 0); self._m(REASON, 0)
            self._upload()
            return self.status()

    def resume_budget(self, group, additional):
        _positive(additional, "additional budget")
        with self._lock:
            for index in range(self._sizes[BUDGET]):
                row = self._row(BUDGET, index)
                if row[0] == group:
                    if row[1] + additional >= 2**63:
                        raise ValueError("budget overflow")
                    row[1] += additional; self._write(BUDGET, index, row)
                    if self._m(STOP) == 3:
                        self._m(STOP, 0); self._m(REASON, 0)
                    self._upload()
                    return self.status()
            raise ValueError("unknown budget group")

    def _used(self, section):
        dynamic = {TASK: NTASK, PARAM: NTASK, EVENT: NEVENT, TOKEN: NTOKEN,
                   TRACE: NTRACE, OUT: NOUT, TX: NTX, TXP: NTX, MUTATION: NMUTATION}
        if section == FRAMES:
            return self._row(FRAMES, 0)[0] if self._sizes[FRAMES] else 0
        return self._m(dynamic[section]) if section in dynamic else self._sizes[section]

    def logical_state(self):
        """Capacity/offset-independent complete execution state and provenance."""
        with self._lock:
            meta = list(self._arena[:30])
            # Work chunk size and fault-injection instrumentation are physical
            # test controls, not model state or pending task semantics.
            for index in (FAULT_POINT, FAULT_AFTER, FAULT_SEEN, LAST_WORK, LAST_COMPLETE):
                meta[index] = 0
            return {"abi": 2, "meta": meta, "model_history": copy.deepcopy(self._models), "keys": copy.deepcopy(self._keys),
                    "request_ids": copy.deepcopy(self._request_ids),
                    "transaction_contracts": copy.deepcopy(self._transaction_contracts),
                    "sections": {name: [self._row(s, i) for i in range(self._used(s))]
                                 for s, name in enumerate(SECTIONS)}}

    def dump(self):
        with self._lock:
            self._ensure_healthy()
            result = self.logical_state()
            # Fault capsule preserves the armed one-shot test point separately;
            # it is deliberately excluded from logical fingerprints.
            return {"format": "jkcuda.core/1", "logical": result,
                    "capacities": dict(self._capacities),
                    "fault": list(self._arena[FAULT_POINT:FAULT_SEEN + 1])}

    @classmethod
    def from_dump(cls, model, snapshot, device="native-cpu", capacities=None, *, propagation="parallel",
                  propagation_chunk=128, block_size=128):
        if not isinstance(snapshot, dict) or snapshot.get("format") != "jkcuda.core/1":
            raise ValueError("unsupported core snapshot format")
        saved_caps = dict(snapshot.get("capacities", {}))
        if capacities:
            for name, value in capacities.items():
                saved_caps[name] = max(saved_caps.get(name, 0), value)
        core = cls(model, device=device, capacities=saved_caps, propagation=propagation,
                   propagation_chunk=propagation_chunk, block_size=block_size)
        history = snapshot.get("logical", {}).get("model_history", [model])
        if not isinstance(history, list) or not history or history[0] != model:
            raise ValueError("snapshot model history must start with the supplied model")
        if len(history) > 1:
            from .model import load_model
            core._models = [load_model(entry) for entry in history]
            core._compile_model(); core._allocate()
        core._restore(snapshot)
        return core

    def _restore(self, snapshot):
        logical = snapshot["logical"]
        if logical.get("abi") != 2 or set(logical.get("sections", {})) != set(SECTIONS):
            raise ValueError("invalid arena snapshot sections")
        meta = logical.get("meta")
        if not isinstance(meta, list) or len(meta) != 30 or any(type(v) is not int or not -(2**63) <= v < 2**63 for v in meta):
            raise ValueError("invalid arena metadata")
        if meta[ABI] != 2 or meta[STOP] not in range(4):
            raise ValueError("invalid arena ABI or stop state")
        if meta[STOP] == 1 and not 0 <= meta[REASON] < len(SECTIONS):
            raise ValueError("invalid resource reason")
        if not 0 <= meta[MODEL_INDEX] < len(self._models):
            raise ValueError("invalid installed model version")
        for s, name in enumerate(SECTIONS):
            rows = logical["sections"][name]
            if not isinstance(rows, list) or len(rows) > self._sizes[s]:
                raise ValueError("snapshot exceeds allocated capacity")
            for row in rows:
                if not isinstance(row, list) or len(row) != self._widths[s] or any(type(v) is not int or not -(2**63) <= v < 2**63 for v in row):
                    raise ValueError("invalid arena row")
            if s in (N, S, OP, EDGE) and rows != self._static[s]:
                raise ValueError("snapshot programs/graph do not match model")
        frame_rows = logical["sections"]["frames"]
        if frame_rows and frame_rows[0][0] != len(frame_rows):
            raise ValueError("frame blob used length mismatch")
        for s, key in ((TASK, NTASK), (PARAM, NTASK), (EVENT, NEVENT), (TOKEN, NTOKEN),
                       (TRACE, NTRACE), (OUT, NOUT), (TX, NTX), (TXP, NTX), (MUTATION, NMUTATION)):
            if meta[key] < 0 or len(logical["sections"][SECTIONS[s]]) != meta[key]:
                raise ValueError("snapshot count mismatch")
        for s in (Q, STATE, BUDGET, CURRENT):
            if len(logical["sections"][SECTIONS[s]]) != self._sizes[s]:
                raise ValueError("snapshot static shape mismatch")
        keys = logical.get("keys", [])
        if not isinstance(keys, list) or any(type(k) not in (str, int) for k in keys):
            raise ValueError("invalid key identities")
        tasks = logical["sections"]["tasks"]
        events = logical["sections"]["events"]
        txs = logical["sections"]["txops"]
        mutations = logical["sections"]["mutations"]
        queues = logical["sections"]["queues"]
        current_rows = logical["sections"]["current"]
        installed = self._version_maps[meta[MODEL_INDEX]]
        for index, row in enumerate(current_rows):
            if row != [installed.get(self._logical_ids[index], -1)]:
                raise ValueError("logical current-node mapping does not match installed root")
        for logical_id, node, changed in mutations:
            if not 0 <= logical_id < len(self._logical_ids) or not -1 <= node < len(self._node_ids) or changed not in (0, 1):
                raise ValueError("invalid structure patch")
            if node >= 0 and self._static[N][node][16] != logical_id:
                raise ValueError("structure patch changes logical identity")
        def valid_key(k):
            return -1 <= k < len(keys)
        seen = set()
        for q, row in enumerate(queues):
            if row[0] != self._static[Q][q][0] or row[3] < 0:
                raise ValueError("invalid queue priority/count")
            cursor, count, last = row[1], 0, -1
            while cursor >= 0:
                if cursor >= len(tasks) or cursor in seen:
                    raise ValueError("invalid/cyclic FIFO links")
                seen.add(cursor); task = tasks[cursor]
                if task[2] != q or task[4] != 0:
                    raise ValueError("FIFO ownership or phase mismatch")
                count += 1; last = cursor; cursor = task[3]
            if cursor != -1 or count != row[3] or last != row[2]:
                raise ValueError("FIFO head/tail/count mismatch")
        active = meta[ACTIVE]
        if active < -1 or active >= len(tasks) or active in seen:
            raise ValueError("invalid active task")
        for i, task in enumerate(tasks):
            node, key, queue, nxt, phase = task[:5]
            if not valid_key(key) or not 0 <= queue < len(queues) or not -1 <= nxt < len(tasks) or phase not in range(6):
                raise ValueError("invalid task identity/phase")
            if node == -2:
                if not 0 <= task[12] or not 0 < task[13] <= len(self._logical_ids) or task[12] + task[13] > len(mutations) or not 0 <= task[14] < len(self._models):
                    raise ValueError("invalid structure task")
            elif node == -3:
                if task[12] != -1 or task[13] != 0:
                    raise ValueError("invalid frame control task")
            elif task[12] < 0:
                if not 0 <= node < len(self._node_ids) or task[13] != 0 or queue != self._static[N][node][8]:
                    raise ValueError("invalid node task")
                if task[12] != -1:
                    raise ValueError("invalid transaction sentinel")
            elif node != -1 or task[13] <= 0 or task[12] + task[13] > len(txs):
                raise ValueError("invalid transaction task")
            if phase == 2 and node >= 0 and (task[5] not in (0, 1) or task[6] not in (0, 1)):
                raise ValueError("invalid bound candidate")
            if phase == 0 and i not in seen or phase in (1, 2, 3, 5) and i != active:
                raise ValueError("orphan active or queued task")
            if phase == 4 and i == active:
                raise ValueError("completed task cannot be active")
            if not 0 <= task[9] <= task[8]:
                raise ValueError("invalid task propagation cursor")
            if phase == 3 and (task[7] < 0 or task[7] + task[8] > len(events)):
                raise ValueError("invalid task event range")
            if phase in (3, 4) and task[8]:
                owned = events[task[7]:task[7] + task[8]]
                if len(owned) != task[8]:
                    raise ValueError("task event range exceeds event table")
                for position, event in enumerate(owned):
                    if event[0] != i:
                        raise ValueError("task event ownership mismatch")
                    if position < task[9] and (event[7] != 1 or event[4] != event[6]):
                        raise ValueError("task cursor skips unfinished propagation")
                    if position >= task[9] and event[7] != 0:
                        raise ValueError("event completion is ahead of its owner cursor")
                    if position > task[9] and event[4] != 0:
                        raise ValueError("later event propagated out of order")
                if phase == 4 and task[9] != task[8]:
                    raise ValueError("completed task retains unfinished events")
            params = logical["sections"]["params"][i]
            if any(v not in (-1, 0, 1) for v in params):
                raise ValueError("invalid task parameters")
        for i, event in enumerate(events):
            owner, node, value, key, cursor, start, count, done, graph_node = event
            if not 0 <= owner < len(tasks) or not 0 <= node < len(self._node_ids) or value not in (0, 1) or not valid_key(key):
                raise ValueError("invalid event identity/payload")
            if graph_node < -1 or graph_node >= len(self._node_ids):
                raise ValueError("invalid event graph version")
            n = self._static[N][graph_node if graph_node >= 0 else node]
            expected_count = n[12] if graph_node >= 0 else 0
            if (start, count) != (n[11], expected_count) or not 0 <= cursor <= count or done not in (0, 1) or done and cursor != count:
                raise ValueError("invalid event subscription version/cursor")
            if not tasks[owner][7] <= i < tasks[owner][7] + tasks[owner][8]:
                raise ValueError("event owner mismatch")
        for token in logical["sections"]["tokens"]:
            target, port, value, key, event, edge, live, owner = token
            if not 0 <= target < len(self._node_ids) or not 0 <= port < self._static[N][target][7] or value not in (0, 1) or not valid_key(key) or not 0 <= event < len(events) or not 0 <= edge < self._sizes[EDGE] or live not in (0, 1) or owner != events[event][0]:
                raise ValueError("invalid matching token")
            subscription = self._static[EDGE][edge]
            if self._static[N][subscription[1]][16] != self._static[N][target][16] or subscription[2] != port or value != events[event][2] or key != events[event][3]:
                raise ValueError("matching token does not correspond to its delivery")
        for i, operation in enumerate(txs):
            owner, node, seed, result, valid, *_ = operation
            if not 0 <= owner < len(tasks) or not 0 <= node < len(self._node_ids) or valid not in (0, 1):
                raise ValueError("invalid internal EX identity")
            start, count = tasks[owner][12:14]
            if not start <= i < start + count:
                raise ValueError("internal EX owner mismatch")
            if valid and (seed not in (0, 1) or result not in (0, 1)):
                raise ValueError("invalid internal EX candidate")
            for value in logical["sections"]["txparams"][i]:
                if value not in (-1, 0, 1) and not (value <= -2 and -value - 2 < i - start):
                    raise ValueError("invalid internal result reference")
        for state in logical["sections"]["states"]:
            if state[0] not in (0, 1) or state[1] < 0:
                raise ValueError("invalid state/version")
        for i, row in enumerate(logical["sections"]["budgets"]):
            if row[0] != self._static[BUDGET][i][0] or row[1] < 0 or not 0 <= row[2] <= row[1]:
                raise ValueError("invalid budget identity/history")
        for output in logical["sections"]["outputs"]:
            owner, node, value, key, event, port, delivered, internal = output
            if not 0 <= owner < len(tasks) or not 0 <= node < len(self._node_ids) or value not in (0, 1) or not valid_key(key) or not 0 <= event < len(events) or not 0 <= port < len(self._output_names) or delivered not in (0, 1):
                raise ValueError("invalid output identity/payload")
            if events[event][:4] != [owner, node, value, key] or self._static[N][node][10] != port:
                raise ValueError("output does not correspond to its committed event")
        for trace in logical["sections"]["traces"]:
            kind, owner, node, value, event, port, key, x, y, z = trace
            if kind not in range(1, 11) or not 0 <= owner < len(tasks) or not -3 <= node < len(self._node_ids) or not valid_key(key):
                raise ValueError("invalid trace identity")
            if kind in (4, 5, 6, 9) and node >= 0 and value not in (0, 1):
                raise ValueError("invalid trace value")
            if kind in (5, 6, 7, 9) and not 0 <= event < len(events):
                raise ValueError("invalid trace event identity")
            if kind == 6 and (node < 0 or not 0 <= port < self._static[N][node][7] or not 0 <= x < len(self._node_ids)):
                raise ValueError("invalid delivery trace target/source")
            if kind == 9 and (not 0 <= x < meta[NOUT] or not 0 <= port < len(self._output_names)):
                raise ValueError("invalid output trace")
            if kind == 10 and (node != -2 or not 0 <= value < len(self._models) or x not in (0, 1)):
                raise ValueError("invalid structural trace")
        if meta[COMPLETE] != sum(task[4] == 4 for task in tasks):
            raise ValueError("completed count mismatch")
        if any(meta[k] < 0 for k in (COMPLETE, ECOUNT, DCOUNT, RCOUNT, GCOUNT, EXCOUNT, EXTERNAL, RES_TASK, RES_TOKEN, RES_TRACE)):
            raise ValueError("negative progress or reservation")
        if meta[NTASK] + meta[RES_TASK] > self._sizes[TASK] or meta[NTOKEN] + meta[RES_TOKEN] > self._sizes[TOKEN] or meta[NTRACE] + meta[RES_TRACE] > self._sizes[TRACE]:
            raise ValueError("reservation capacity mismatch")
        if active < 0 and any(meta[k] for k in (RES_TASK, RES_TOKEN, RES_TRACE)):
            raise ValueError("orphan resource reservation")
        if active >= 0 and tasks[active][4] == 3 and tasks[active][0] >= -1:
            task = tasks[active]
            remaining = events[task[7] + task[9]:task[7] + task[8]]
            edges_left = sum(event[6] - event[4] for event in remaining)
            if meta[RES_TASK] < edges_left or meta[RES_TOKEN] < edges_left or meta[RES_TRACE] < 3 * edges_left + len(remaining) + 1:
                raise ValueError("active task is missing continuation resource reservations")
        request_ids = logical.get("request_ids", {})
        contracts = logical.get("transaction_contracts", {})
        if not isinstance(request_ids, dict) or not isinstance(contracts, dict):
            raise ValueError("invalid host task provenance ledger")
        for identifier, owner in request_ids.items():
            if (not isinstance(identifier, str) or not identifier.isascii() or not identifier.isdigit()
                    or str(int(identifier)) != identifier or not 1 <= int(identifier) <= len(tasks)
                    or owner is not None and (not isinstance(owner, str) or not owner)):
                raise ValueError("invalid request/task provenance entry")
            task = tasks[int(identifier) - 1]
            if task[10] != -1 or task[11] != -1:
                raise ValueError("external request ledger claims an internally generated task")
        for identifier, contract in contracts.items():
            if (not isinstance(identifier, str) or not identifier.isascii() or not identifier.isdigit()
                    or str(int(identifier)) != identifier or not 1 <= int(identifier) <= len(tasks)
                    or tasks[int(identifier) - 1][0] != -1
                    or contract is not None and not isinstance(contract, str)):
                raise ValueError("invalid transaction contract provenance")
        self._arena[:30] = array.array("q", meta)
        self._keys = copy.deepcopy(keys)
        self._request_ids = copy.deepcopy(logical.get("request_ids", {}))
        self._transaction_contracts = copy.deepcopy(logical.get("transaction_contracts", {}))
        for s, name in enumerate(SECTIONS):
            for i, row in enumerate(logical["sections"][name]):
                self._write(s, i, row)
        fault = snapshot.get("fault", [0, 0, 0])
        if not isinstance(fault, list) or len(fault) != 3 or fault[0] not in range(5) or any(type(x) is not int or x < 0 for x in fault):
            raise ValueError("invalid fault instrumentation")
        self._arena[FAULT_POINT:FAULT_SEEN + 1] = array.array("q", fault)
        self._refresh_current()
        from .frames import validate_blob
        validate_blob(self)
        if self._m(NTASK) + self._m(RES_TASK) + self._frame_credit(24) > self._sizes[TASK] or self._m(NTRACE) + self._m(RES_TRACE) + self._frame_credit(25) > self._sizes[TRACE] or self._used(FRAMES) + self._frame_credit(26) > self._sizes[FRAMES]:
            raise ValueError("frame completion reservations exceed capacity")
        self._upload()

    def grow(self, capacities):
        with self._lock:
            self._ensure_healthy()
            for name, value in capacities.items():
                if name not in self._capacities or _positive(value, name) < self._capacities[name]:
                    raise ValueError("grow only permits known nondecreasing capacities")
            previous_attributes = dict(self.__dict__)
            self._capacities = dict(self._capacities)
            try:
                snapshot = self.dump()
                self._set_capacities(capacities)
                self._allocate()
                self._restore(snapshot)
                if self._m(STOP) == 1:
                    self._m(STOP, 0); self._m(REASON, 0); self._upload()
                return self.status()
            except BaseException:
                fatal = self._fatal
                self.__dict__.clear(); self.__dict__.update(previous_attributes)
                if fatal is not None: self._fatal = fatal
                raise
