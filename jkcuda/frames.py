"""Host ownership for the native FIFO frame module; no host business execution.

INPUT_BIT/STORE/ACK_DEC/ACK_ACT/COMPLETE execute in frames.hpp on the selected
task. Output data and markers execute the model's declared ordinary JK nodes.
This is the V6.1 frame storage/output protocol, not a V5 A03 model emulator.
"""
from __future__ import annotations

from .backend import (FRAMES, TASK, PARAM, TRACE, Q, OUT, EVENT, NTASK, NEVENT, NTRACE, RES_TASK,
                      RES_TRACE, NENQUEUE, EXTERNAL, NOUT, BackpressureError)

MAGIC = 0x4A4B4652414D45
HEADER = 32
F_SIZE, B_SIZE, O_SIZE, R_SIZE = 22, 6, 16, 6
INPUT_BIT, STORE, ACK_DEC, ACK_ACT, FRAME_COMPLETE = 1, 2, 3, 4, 5
PRE_ACCEPT, CLAIM = 6, 7
PROFILE_SIZE, CONTEXT_SIZE = 6, 10
OUTPUT_TAG = -101


def frame_input_width(core, frame_at):
    """Read the immutable accepted width; business POST width may differ."""
    start = core._offsets[FRAMES]
    used = core._arena[start]
    if type(frame_at) is not int or not HEADER <= frame_at <= used - F_SIZE:
        raise FrameError("frame pointer is outside owned storage")
    context = core._arena[start + frame_at + 20]
    if context < 0:
        return core._arena[start + frame_at + 7]
    if not HEADER <= context <= used - 10:
        raise FrameError("business frame context is outside owned storage")
    return core._arena[start + context + 2]


class FrameError(ValueError):
    pass


class Frames:
    """Attach to the immutable frame_module configuration in an existing Core.

    Public mutation methods enqueue requests only. The caller Runtime owns
    request deduplication, durable acceptance and application output delivery.
    All methods acquire the Core lock; callers may already hold that RLock.
    """

    def __init__(self, core):
        self.core = core
        config = core.model.get("frame_module")
        if config is None:
            raise FrameError("model has no declared frame_module")
        self.config = config
        with core._lock:
            core._ensure_healthy()
            if core._sizes[FRAMES] < HEADER:
                raise BackpressureError("frames capacity is smaller than the module header")
            expected = self._configuration()
            if self._word(0) == 0:
                profiles = (core.model.get("business_module") or {}).get("widths", [])
                required = HEADER + PROFILE_SIZE * len(profiles) + sum(p["input_width"] + p["output_width"] for p in profiles)
                if required > core._sizes[FRAMES]:
                    raise BackpressureError("frames capacity is smaller than the declared business profile table")
                checkpoint = core._admission_checkpoint()
                for index in range(HEADER):
                    self._put(index, -1)
                initial = {0: HEADER, 1: MAGIC, 2: 1, 3: config["block_capacity"],
                           4: expected[4], 5: expected[5], 6: -1, 7: -1,
                           8: 1, 9: 1, 10: 0, 11: -1, 12: -1,
                           13: expected[13], 14: expected[14], 15: expected[15], 16: expected[16],
                           17: 0, 18: -1, 19: -1, 20: config["max_width"],
                           22: -1, 23: -1, 24: 0, 25: 0, 26: 0}
                for index, value in initial.items():
                    self._put(index, value)
                if profiles:
                    table = self._allocate(PROFILE_SIZE * len(profiles))
                    self._put(30, table); self._put(31, len(profiles))
                    for position, profile in enumerate(profiles):
                        pre = self._allocate(profile["input_width"])
                        params = self._allocate(profile["output_width"])
                        finish = core._version_maps[0][profile["finish_node"]]
                        for i, name in enumerate(profile["pre_nodes"]):
                            self._put(pre + i, core._version_maps[0][name])
                        for i, name in enumerate(profile["finish_params"]):
                            self._put(params + i, core._param_names[finish].index(name))
                        for i, value in enumerate((profile["input_width"], profile["output_width"], pre, finish, params, 0)):
                            self._put(table + position * PROFILE_SIZE + i, value)
                self._upload(checkpoint)
            validate_blob(core)

    @classmethod
    def from_core(cls, core):
        return cls(core)

    def _configuration(self):
        c, cfg = self.core, self.config
        result = {3: cfg["block_capacity"], 4: c._queue_map[cfg["input_queue"]],
                  5: c._queue_map[cfg["queue"]], 20: cfg["max_width"]}
        for role, node_field, param_field in (("data", 13, 14), ("marker", 15, 16)):
            # Immutable adapter definitions cannot change. Unrelated dynamic
            # model versions append slots; this module retains its original
            # protected adapter version rather than rebinding an old batch.
            node = c._version_maps[0][cfg[role + "_node"]]
            result[node_field] = node
            result[param_field] = c._param_names[node].index(cfg[role + "_param"])
        return result

    def _word(self, index):
        return self.core._arena[self.core._offsets[FRAMES] + index]

    def _put(self, index, value):
        self.core._arena[self.core._offsets[FRAMES] + index] = value

    def _allocate(self, count):
        at = self._word(0)
        self._put(0, at + count)
        for index in range(at, at + count):
            self._put(index, -1)
        return at

    def _reserve(self, words, tasks, traces, *, consume_credit=False):
        c = self.core
        credit = 1 if consume_credit else 0
        word_credit = 4 if consume_credit else 0
        if (self._word(0) + self._word(26) - word_credit + words > c._sizes[FRAMES]
                or c._m(NTASK) + c._m(RES_TASK) + self._word(24) - credit + tasks > c._sizes[TASK]
                or c._m(NTRACE) + c._m(RES_TRACE) + self._word(25) - credit + traces > c._sizes[TRACE]):
            raise BackpressureError("frame admission capacity exhausted; no request accepted")

    def _append(self, opcode, payload, queue):
        c = self.core
        task = c._m(NTASK)
        row = [-3, -1, queue, -1, 0, -1, -1, -1, 0, 0, -1, -1, -1, 0, payload, opcode]
        c._write(TASK, task, row)
        c._write(PARAM, task, [-1] * c._max_params)
        fifo = c._row(Q, queue)
        if fifo[2] >= 0:
            previous = c._row(TASK, fifo[2]); previous[3] = task
            c._write(TASK, fifo[2], previous)
        else:
            fifo[1] = task
        fifo[2] = task; fifo[3] += 1
        c._write(Q, queue, fifo)
        c._write(TRACE, c._m(NTRACE), [1, task, -3, -1, -1, -1, -1, -1, -1, -1])
        c._m(NTASK, task + 1); c._m(NTRACE, c._m(NTRACE) + 1)
        c._m(NENQUEUE, c._m(NENQUEUE) + 1); c._m(EXTERNAL, c._m(EXTERNAL) + 1)
        c._request_ids[str(task + 1)] = None
        return task + 1

    def _upload(self, checkpoint):
        self.core._sync_admission(checkpoint)

    def submit_frame(self, bits):
        if not isinstance(bits, (list, tuple)) or not bits:
            raise FrameError("frame must contain a nonempty ordered bit sequence")
        values = list(bits)
        if any(type(value) is not int or value not in (0, 1) for value in values):
            raise FrameError("frame values must be integer 0 or 1")
        if len(values) > self.config["max_width"]:
            raise FrameError("frame exceeds the declared max_width")
        c = self.core
        with c._lock:
            c._ensure_healthy()
            width = len(values)
            profile_at, output_width = -1, width
            if c.model.get("business_module"):
                for i in range(self._word(31)):
                    candidate = self._word(30) + i * PROFILE_SIZE
                    if self._word(candidate) == width:
                        profile_at, output_width = candidate, self._word(candidate + 1)
                        break
                if profile_at < 0:
                    raise FrameError("input width has no declared business DAG")
            words = F_SIZE + 3 * output_width + 3 * width
            if profile_at >= 0:
                words += CONTEXT_SIZE + 2 * width
            self._reserve(words, width, width)
            identifier = self._word(8)
            if identifier >= 2**63 - 1:
                raise FrameError("frame identity exhausted; no wraparound")
            checkpoint = c._admission_checkpoint()
            frame_at = self._allocate(F_SIZE + 3 * output_width)
            data = frame_at + F_SIZE
            context = -1
            if profile_at >= 0:
                context = self._allocate(CONTEXT_SIZE + 2 * width)
                raw = context + CONTEXT_SIZE
                for index, value in enumerate((-1, profile_at, width, raw, raw + width, 0, frame_at, -1, -1, -1)):
                    self._put(context + index, value)
                for index in range(width): self._put(raw + width + index, 0)
            record = [-1, -1, identifier, 1, -1, -1, -1, output_width, 0, 0, 0, 0, 0, 1,
                      -1, data, data + output_width, data + 2 * output_width, 0,
                      c._key(f"jkcuda.frame:{identifier}"), context, -1]
            for offset, value in enumerate(record):
                self._put(frame_at + offset, value)
            for position in range(output_width):
                self._put(data + 2 * output_width + position, 0)
            last = self._word(12)
            if last >= 0:
                self._put(last, frame_at)
            else:
                self._put(11, frame_at)
            self._put(12, frame_at); self._put(8, identifier + 1)
            self._put(10, self._word(10) + 1)
            task_ids = []
            for position, value in enumerate(values):
                request = self._allocate(3)
                for index, item in enumerate((frame_at, position, value)):
                    self._put(request + index, item)
                task_ids.append(self._append(INPUT_BIT, request, self._word(4)))
            self._upload(checkpoint)
            return {"frame_id": identifier, "generation": 1, "task_ids": task_ids}

    def ack(self, value):
        if type(value) is not int or value not in (0, 1):
            raise FrameError("business ACK must be integer 0 (replay) or 1 (consume)")
        with self.core._lock:
            self.core._ensure_healthy()
            self._reserve(1, 1, 1)
            checkpoint = self.core._admission_checkpoint()
            request = self._allocate(1); self._put(request, value)
            task = self._append(ACK_DEC, request, self._word(5))
            self._upload(checkpoint)
            return [task]

    def _chain(self, head, next_field=0):
        result, seen = [], set()
        current = self._word(head)
        while current >= 0:
            if current in seen or not HEADER <= current < self._word(0):
                raise FrameError("invalid/cyclic frame-module list")
            seen.add(current); result.append(current)
            current = self._word(current + next_field)
        return result

    def received_batch(self, batch_id):
        """Enqueue the host-receipt fact; qualification remains unchanged here."""
        with self.core._lock:
            self.core._ensure_healthy()
            matches = [at for at in self._chain(22) if self._word(at + 1) == batch_id]
            if not matches:
                raise FrameError("unknown batch identity")
            at = matches[0]
            prior = self._word(at + 10)
            if prior:
                return [prior]
            width = self._word(at + 7)
            if self._word(at + 8) != width + 1 or self._word(at + 11) < 0:
                raise FrameError("all W data and the marker must be received first")
            self._reserve(4, 1, 1, consume_credit=True)
            checkpoint = self.core._admission_checkpoint()
            self._put(24, self._word(24) - 1); self._put(25, self._word(25) - 1)
            self._put(26, self._word(26) - 4)
            request = self._allocate(4)
            for index, value in enumerate((at, self._word(at + 3), self._word(at + 4), self._word(at + 11))):
                self._put(request + index, value)
            task = self._append(FRAME_COMPLETE, request, self._word(5))
            self._put(at + 10, task)
            self._upload(checkpoint)
            return [task]

    def batches(self):
        with self.core._lock:
            result = []
            for at in self._chain(22):
                width = self._word(at + 7)
                if self._word(at + 8) != width + 1:
                    continue
                records = self._word(at + 12)
                frame = self._word(at + 2)
                result.append({"batch_id": self._word(at + 1), "frame_id": self._word(frame + 2),
                               "generation": self._word(at + 3), "slot_generation": self._word(at + 4),
                               "width": width, "values": [self._word(records + p * R_SIZE + 3) for p in range(width)],
                               "marker": self._word(records + width * R_SIZE + 3),
                               "replay": bool(self._word(at + 6)), "token": self._word(at + 5),
                               "data_output_ids": [self._word(records + p * R_SIZE + 4) + 1 for p in range(width)],
                               "marker_output_id": self._word(at + 11) + 1,
                               "completion_task_id": self._word(at + 10) or None,
                               "received": bool(self._word(at + 9))})
            return result

    def output_annotations(self):
        with self.core._lock:
            result = {}
            for at in self._chain(22):
                width, records, frame = self._word(at + 7), self._word(at + 12), self._word(at + 2)
                for position in range(width + 1):
                    record = records + position * R_SIZE
                    if self._word(record + 5):
                        result[self._word(record + 4) + 1] = {"batch_id": self._word(at + 1),
                            "frame_id": self._word(frame + 2), "generation": self._word(at + 3),
                            "position": position, "marker": position == width}
            return result

    def state(self):
        with self.core._lock:
            frames, blocks = [], []
            for at in self._chain(11):
                block = self._word(at + 4)
                frames.append({"frame_id": self._word(at + 2), "generation": self._word(at + 3),
                    "width": self._word(at + 7), "arrived": self._word(at + 8),
                    "stored": bool(self._word(at + 9)), "consumed": bool(self._word(at + 10)),
                    "qualified": bool(self._word(at + 11)), "token": self._word(at + 12),
                    "block_id": None if block < 0 else self._word(block + 1),
                    "slot": self._word(at + 5), "slot_generation": self._word(at + 6),
                    "held_batches": self._word(at + 18)})
                context = self._word(at + 20)
                if context >= 0:
                    width, raw, valid = self._word(context + 2), self._word(context + 3), self._word(context + 4)
                    frames[-1].update({"input_width": width, "pre_stage": self._word(context + 5),
                        "pre_values": [self._word(raw+i) if self._word(valid+i) else None for i in range(width)],
                        "post_values": [self._word(self._word(at+15)+i) for i in range(self._word(at+7))] if self._word(context+5) == 4 else None,
                        "claim_task_id": self._word(context+8)+1 if self._word(context+8) >= 0 else None,
                        "finish_task_id": self._word(context+7)+1 if self._word(context+7) >= 0 else None})
            for at in self._chain(18):
                blocks.append({"block_id": self._word(at + 1), "generation": self._word(at + 2),
                    "used": self._word(at + 3), "live": self._word(at + 4), "held_batches": self._word(at + 5)})
            head = self._word(6)
            result = {"head": None if head < 0 else self._word(head + 2), "frames": frames,
                      "blocks": blocks, "completion_reserved": self._word(24)}
            if self.core.model.get("business_module"):
                active, pending, at = self._word(29), [], self._word(27)
                while at >= 0:
                    pending.append(self._word(at+2)); at = self._word(self._word(at+20))
                result["business"] = {"active_frame": None if active < 0 else self._word(active+2), "pre_queue": pending}
            return result

    status = state


def validate_blob(core):
    """Validate every device-dereferenced frame pointer before recovered execution."""
    used = core._row(FRAMES, 0)[0]
    if used == 0:
        if any(core._row(TASK, i)[0] == -3 or core._row(TASK, i)[15] == OUTPUT_TAG for i in range(core._m(NTASK))):
            raise FrameError("frame tasks require a configured frame blob")
        return
    if not HEADER <= used <= core._sizes[FRAMES] or core.model.get("frame_module") is None:
        raise FrameError("invalid frame blob size/configuration")
    b = list(core._arena[core._offsets[FRAMES]:core._offsets[FRAMES] + used])
    if b[1] != MAGIC or b[2] != 1 or any(b[i] < 0 for i in (8, 9, 10, 17, 24, 25, 26)):
        raise FrameError("invalid frame header")
    probe = Frames.__new__(Frames); probe.core = core; probe.config = core.model["frame_module"]
    if any(b[index] != value for index, value in probe._configuration().items()):
        raise FrameError("frame module configuration differs from its model")

    def pointer(at, count):
        if type(at) is not int or not HEADER <= at <= used - count:
            raise FrameError("out-of-range frame blob pointer")

    def chain(head, width):
        current, result = b[head], []
        while current >= 0:
            pointer(current, width)
            if current in result:
                raise FrameError("cyclic frame blob list")
            result.append(current); current = b[current]
        if current != -1:
            raise FrameError("invalid frame list sentinel")
        return result

    profiles, business = {}, core.model.get("business_module")
    if business:
        expected_profiles = business["widths"]
        if b[30] != HEADER or b[31] != len(expected_profiles):
            raise FrameError("business profile count differs from its declaration")
        pointer(b[30], PROFILE_SIZE * b[31])
        array_at = HEADER + PROFILE_SIZE * len(expected_profiles)
        for i, declared in enumerate(expected_profiles):
            at = b[30] + i * PROFILE_SIZE
            p = b[at:at+PROFILE_SIZE]
            pointer(p[2], declared["input_width"]); pointer(p[4], declared["output_width"])
            finish = core._version_maps[0][declared["finish_node"]]
            if (p[:2] != [declared["input_width"], declared["output_width"]] or p[3] != finish or p[5] != 0
                    or p[2] != array_at or p[4] != array_at + p[0]
                    or b[p[2]:p[2]+p[0]] != [core._version_maps[0][name] for name in declared["pre_nodes"]]
                    or b[p[4]:p[4]+p[1]] != [core._param_names[finish].index(name) for name in declared["finish_params"]]):
                raise FrameError("business profile node/parameter identity differs")
            profiles[at] = declared
            array_at += p[0] + p[1]
    elif b[27:32] != [-1] * 5:
        raise FrameError("undeclared business control configuration")

    frames, blocks, batches = chain(11, F_SIZE), chain(18, B_SIZE), chain(22, O_SIZE)
    if len(frames) != b[10] or len(blocks) != b[17]:
        raise FrameError("frame/block count mismatch")
    if (frames[-1] if frames else -1) != b[12] or (blocks[-1] if blocks else -1) != b[19] or (batches[-1] if batches else -1) != b[23]:
        raise FrameError("frame-module list tail mismatch")
    frame_ids, batch_ids, contexts = set(), set(), {}
    for at in frames:
        f = b[at:at+F_SIZE]; width = f[7]
        if not 1 <= width <= b[20] or f[2] < 1 or f[2] in frame_ids or f[3] != 1:
            raise FrameError("invalid frame identity/width")
        frame_ids.add(f[2])
        if any(f[i] not in (0, 1) for i in (9, 10, 11)) or f[18] < 0 or f[13] < 1:
            raise FrameError("invalid frame state")
        for offset in (15, 16, 17): pointer(f[offset], width)
        if [f[15], f[16], f[17]] != [at+F_SIZE, at+F_SIZE+width, at+F_SIZE+2*width]:
            raise FrameError("frame payload buffers do not have independent owned storage")
        valid = b[f[17]:f[17]+width]
        input_width, input_data, input_valid = width, f[15], f[17]
        if business:
            pointer(f[20], CONTEXT_SIZE)
            context = b[f[20]:f[20]+CONTEXT_SIZE]
            if (f[20] != at + F_SIZE + 3*width or context[1] not in profiles or context[6] != at
                    or context[5] not in range(5) or context[9] != -1):
                raise FrameError("invalid business PRE context ownership")
            profile = profiles[context[1]]
            if context[2] != profile["input_width"] or width != profile["output_width"]:
                raise FrameError("business input/POST widths differ from profile")
            input_width, input_data, input_valid = context[2:5]
            pointer(input_data, input_width); pointer(input_valid, input_width)
            if input_data != f[20]+CONTEXT_SIZE or input_valid != input_data+input_width:
                raise FrameError("business PRE and POST storage must be independent")
            if valid != [int(context[5] == 4)] * width:
                raise FrameError("business POST publication precedes/loses FINISH")
            if context[5] > 0 and f[8] != input_width or f[9] and context[5] != 4:
                raise FrameError("business claim/POST store precedes readiness")
            if context[5] < 3 and context[8] != -1 or context[5] < 4 and context[7] != -1:
                raise FrameError("business context names an uncommitted task")
            contexts[at] = context
        elif f[20] != -1:
            raise FrameError("ordinary frame has a business context")
        arrived = b[input_valid:input_valid+input_width]
        if any(value not in (0, 1) for value in arrived) or sum(arrived) != f[8]:
            raise FrameError("frame arrival count mismatch")
        if any(b[input_data+i] not in (0, 1) for i in range(input_width) if arrived[i]):
            raise FrameError("invalid arrived PRE bit")
        if any(b[f[15]+i] not in (0, 1) for i in range(width) if valid[i]):
            raise FrameError("invalid arrived frame bit")
        if f[9] and (f[8] != input_width or f[4] not in blocks or not 0 <= f[5] < b[3] or f[6] < 1):
            raise FrameError("stored frame has invalid block/arrival ownership")
        if f[11] and (at != b[6] or f[10] or not f[9] or f[12] < 1 or any(v not in (0, 1) for v in b[f[16]:f[16]+width])):
            raise FrameError("invalid ACK qualification/retained bits")
        if not 0 <= f[19] < len(core._keys) or core._keys[f[19]] != f"jkcuda.frame:{f[2]}":
            raise FrameError("invalid frame key")
    if business:
        pre_queue, at = [], b[27]
        while at >= 0:
            if at not in contexts or at in pre_queue or contexts[at][5] not in (1, 2):
                raise FrameError("invalid business PRE FIFO")
            pre_queue.append(at); at = contexts[at][0]
        if at != -1 or (pre_queue[-1] if pre_queue else -1) != b[28] or set(pre_queue) != {f for f,c in contexts.items() if c[5] in (1,2)}:
            raise FrameError("orphan/misordered PRE owner")
        claimed = [f for f,c in contexts.items() if c[5] == 3]
        if claimed != ([] if b[29] == -1 else [b[29]]):
            raise FrameError("business active claim ownership differs")
        for frame_at, context in contexts.items():
            if context[5] == 2 and (not pre_queue or frame_at != pre_queue[0] or b[29] != -1):
                raise FrameError("queued CLAIM is not the available PRE head")
            if context[5] not in (1,2) and context[0] != -1:
                raise FrameError("business frame has a stale PRE successor")
    if b[8] <= max(frame_ids, default=0):
        raise FrameError("frame allocator high water moved backwards")
    queue, at = [], b[6]
    while at >= 0:
        if at not in frames or at in queue or not b[at+9] or b[at+10]:
            raise FrameError("invalid live frame FIFO")
        queue.append(at); at = b[at+1]
    if at != -1 or (queue[-1] if queue else -1) != b[7]:
        raise FrameError("frame FIFO tail mismatch")
    if set(queue) != {at for at in frames if b[at+9] and not b[at+10]}:
        raise FrameError("orphan live frame")
    records = set(); outstanding = 0
    for at in batches:
        o = b[at:at+O_SIZE]; width = o[7]
        if o[1] < 1 or o[1] in batch_ids or o[2] not in frames or width != b[o[2]+7]:
            raise FrameError("invalid batch identity/frame")
        batch_ids.add(o[1]); pointer(o[12], (width+1)*R_SIZE)
        if o[3] != b[o[2]+3] or o[4] != b[o[2]+6] or o[5] < 1 or o[6] not in (0, 1) or o[9] not in (0, 1):
            raise FrameError("invalid batch generation/qualification token")
        committed = 0
        for position in range(width+1):
            record = o[12] + position*R_SIZE; records.add(record)
            r = b[record:record+R_SIZE]
            if r[0] != at or r[1] != position or r[2] not in (0, 1) or r[5] not in (0, 1):
                raise FrameError("invalid output record ownership")
            if r[5]:
                committed += 1
                if r[3] not in (0, 1) or not 0 <= r[4] < core._m(NOUT):
                    raise FrameError("invalid committed frame output")
                output = core._row(OUT, r[4])
                owner = core._row(TASK, output[0])
                if output[2] != r[3] or owner[14:16] != [record, OUTPUT_TAG]:
                    raise FrameError("frame payload differs from its committed JK output")
        if committed != o[8] or o[9] and (committed != width+1 or o[10] <= 0):
            raise FrameError("batch completion count mismatch")
        if committed == width + 1 and o[11] != b[o[12] + width*R_SIZE + 4]:
            raise FrameError("marker identity differs from its output record")
        if not o[10]: outstanding += 1
        elif not 1 <= o[10] <= core._m(NTASK):
            raise FrameError("invalid completion task identity")
    if b[9] <= max(batch_ids, default=0) or (b[24], b[25], b[26]) != (outstanding, outstanding, 4*outstanding):
        raise FrameError("batch allocator/completion credit mismatch")
    for at in blocks:
        block = b[at:at+B_SIZE]
        live = sum(b[f+9] and not b[f+10] and b[f+4] == at and b[f+6] == block[2] for f in frames)
        holds = sum(not b[o+9] and b[b[o+2]+4] == at for o in batches)
        if not 1 <= block[2] or not 0 <= block[3] <= b[3] or block[4] != live or block[5] != holds:
            raise FrameError("block generation/lifecycle count mismatch")
        slots = [b[f+5] for f in frames if b[f+9] and b[f+4] == at and b[f+6] == block[2]]
        if sorted(slots) != list(range(block[3])):
            raise FrameError("block generation slots are incomplete or duplicated")
    for at in frames:
        if b[at+18] != sum(b[o+2] == at and not b[o+9] for o in batches):
            raise FrameError("frame output-holder count mismatch")
    input_positions = {at: {} for at in frames}
    stored_tasks = {}
    accepted_tasks, claimed_tasks, pre_copies = {}, {}, {}
    output_owners = {}
    business_node_profiles = {name: at for at,p in profiles.items() for name in p["protected_nodes"]}
    frame_by_key = {b[at+19]: at for at in frames}
    business_events, business_tasks, enqueue_at, delivery_at = {}, set(), {}, {}
    incoming = {}
    if business:
        for edge in core.model["subscriptions"]:
            if edge["target"] in business_node_profiles:
                incoming.setdefault(edge["target"], {})[edge["port"]] = edge["source"]
        for i in range(core._m(NEVENT)):
            event = core._row(EVENT, i)
            name = core._node_ids[event[1]]
            if name not in business_node_profiles:
                continue
            identity = (event[3], name)
            if identity in business_events:
                raise FrameError("business node published more than once for a frame")
            owner = core._row(TASK, event[0])
            if owner[0] != event[1] or owner[1] != event[3] or owner[6] != event[2] or owner[4] not in (3,4):
                raise FrameError("business event differs from its committed ordinary EX task")
            business_events[identity] = (i, event[2])
        for i in range(core._m(NTRACE)):
            row = core._row(TRACE, i)
            if row[0] == 1:
                if row[1] in enqueue_at:
                    raise FrameError("task has duplicate enqueue records")
                enqueue_at[row[1]] = i
            elif row[0] == 6 and row[2] >= 0 and core._node_ids[row[2]] in business_node_profiles:
                identity = (row[4], core._node_ids[row[2]], core._param_names[row[2]][row[5]])
                if identity in delivery_at:
                    raise FrameError("business dependency was delivered more than once")
                delivery_at[identity] = i
    for i in range(core._m(NTASK)):
        task = core._row(TASK, i)
        if task[15] == OUTPUT_TAG:
            if task[14] not in records or task[0] not in (b[13], b[15]):
                raise FrameError("output task has no owned frame record")
            record = task[14]; batch = b[record]; position = b[record+1]
            is_marker = position == b[batch+7]
            if record in output_owners or task[0] != b[15 if is_marker else 13]:
                raise FrameError("frame output record has duplicate/wrong adapter ownership")
            output_owners[record] = i
            parameter = b[16 if is_marker else 14]
            if core._row(PARAM, i)[parameter] != b[record+2] or task[2] != b[5]:
                raise FrameError("frame output adapter lost its immutable parameter/FIFO")
        if task[0] != -3:
            if task[0] >= 0 and core._node_ids[task[0]] in business_node_profiles:
                name = core._node_ids[task[0]]
                identity = (task[1], name)
                if identity in business_tasks:
                    raise FrameError("business node executed more than once for a frame")
                business_tasks.add(identity)
                frame_at = frame_by_key.get(task[1])
                if frame_at not in contexts or contexts[frame_at][1] != business_node_profiles[name] or contexts[frame_at][5] < 3:
                    raise FrameError("business task lost its immutable claimed frame identity")
                profile = profiles[contexts[frame_at][1]]
                if i not in enqueue_at:
                    raise FrameError("business task lacks its real FIFO admission record")
                for port, source in incoming.get(name, {}).items():
                    event_value = business_events.get((task[1], source))
                    if event_value is None:
                        raise FrameError("business task dependency has not committed")
                    event, value = event_value
                    delivered = delivery_at.get((event, name, port))
                    if (event > task[11] or delivered is None or delivered >= enqueue_at[i]
                            or core._row(PARAM, i)[core._param_names[task[0]].index(port)] != value):
                        raise FrameError("business task parameter differs from its completed source event")
                if incoming.get(name):
                    if not 0 <= task[11] < core._m(NEVENT) or core._row(EVENT, task[11])[0] != task[10]:
                        raise FrameError("business task lost its causal event owner")
                if name in profile["pre_nodes"]:
                    position = profile["pre_nodes"].index(name)
                    identity = (frame_at, position)
                    if (identity in pre_copies or task[10] != contexts[frame_at][8]
                            or core._row(PARAM, i)[0] != b[contexts[frame_at][3]+position]):
                        raise FrameError("PRE copy does not belong to its immutable CLAIM/input")
                    pre_copies[identity] = i
            continue
        opcode, at = task[15], task[14]
        if task[4] not in (0, 1, 3, 4) or task[2] != b[4 if opcode == INPUT_BIT else 5]:
            raise FrameError("invalid frame task phase/FIFO")
        if opcode == INPUT_BIT:
            pointer(at, 3)
            frame_at = b[at]
            width = contexts[frame_at][2] if frame_at in contexts else b[frame_at+7] if frame_at in frames else 0
            if frame_at not in frames or not 0 <= b[at+1] < width or b[at+2] not in (0, 1):
                raise FrameError("invalid frame input task")
            frame_at, position = b[at], b[at+1]
            if position in input_positions[frame_at]:
                raise FrameError("duplicate frame input position")
            done = task[4] in (3, 4)
            input_positions[frame_at][position] = done
            data, valid = (contexts[frame_at][3:5] if frame_at in contexts else (b[frame_at+15], b[frame_at+17]))
            if bool(b[valid+position]) != done or done and b[data+position] != b[at+2]:
                raise FrameError("frame input execution/arrival record mismatch")
        elif opcode == STORE:
            if at not in frames: raise FrameError("invalid frame store target")
            ready = contexts[at][5] == 4 if at in contexts else b[at+8] == b[at+7]
            if at in stored_tasks or not ready or bool(b[at+9]) != (task[4] in (3, 4)):
                raise FrameError("frame store readiness/commit mismatch")
            stored_tasks[at] = i
        elif opcode in (PRE_ACCEPT, CLAIM):
            if at not in contexts or b[at+8] != contexts[at][2]:
                raise FrameError("business control targets an incomplete PRE frame")
            seen = accepted_tasks if opcode == PRE_ACCEPT else claimed_tasks
            stage = contexts[at][5]
            if at in seen:
                raise FrameError("duplicate business PRE control task")
            seen[at] = i
            done = task[4] in (3,4)
            if opcode == PRE_ACCEPT and done != (stage >= 1):
                raise FrameError("PRE acceptance task and ownership disagree")
            if opcode == CLAIM and (stage < 2 or done != (stage >= 3) or done and contexts[at][8] != i):
                raise FrameError("CLAIM task and ownership disagree")
        elif opcode == ACK_DEC:
            pointer(at, 1)
            if b[at] not in (0, 1): raise FrameError("invalid ACK decoder input")
        elif opcode == ACK_ACT:
            pointer(at, 5)
            if b[at] not in frames or b[at+4] not in (0, 1) or min(b[at+1:at+4]) < 1:
                raise FrameError("invalid bound ACK action")
            frame_at = b[at]
            if b[at+1] != b[frame_at+3] or b[at+2] != b[frame_at+6] or not b[at+3] < b[frame_at+13]:
                raise FrameError("ACK action is bound to an unknown frame generation/token")
        elif opcode == FRAME_COMPLETE:
            pointer(at, 4)
            if b[at] not in batches or min(b[at+1:at+3]) < 1 or b[at+3] < 0:
                raise FrameError("invalid batch completion fact")
            batch_at = b[at]
            if b[batch_at+10] != i+1 or b[at+1:at+4] != [b[batch_at+3], b[batch_at+4], b[batch_at+11]] or bool(b[batch_at+9]) != (task[4] in (3, 4)):
                raise FrameError("completion task does not own its batch receipt")
        else:
            raise FrameError("unknown frame task opcode")
    if set(output_owners) != records:
        raise FrameError("frame output record lacks its real JK task")
    for at in frames:
        width = contexts[at][2] if at in contexts else b[at+7]
        if set(input_positions[at]) != set(range(width)):
            raise FrameError("frame does not own exactly W input tasks")
        store_ready = contexts[at][5] == 4 if at in contexts else b[at+8] == width
        if (at in stored_tasks) != store_ready:
            raise FrameError("completed input frame lacks its FIFO store task")
        if at in contexts:
            context = contexts[at]; profile = profiles[context[1]]
            if (at in accepted_tasks) != (b[at+8] == width) or (at in claimed_tasks) != (context[5] >= 2):
                raise FrameError("PRE/CLAIM task identity is missing")
            if sum(frame == at for frame,position in pre_copies) != (width if context[5] >= 3 else 0):
                raise FrameError("CLAIM lacks exactly W independent PRE copy tasks")
            if context[5] == 4:
                finish = context[7]
                if not 0 <= finish < core._m(NTASK):
                    raise FrameError("FINISH task identity is invalid")
                task = core._row(TASK, finish)
                if task[0] < 0 or core._node_ids[task[0]] != profile["finish_node"] or task[1] != b[at+19] or task[4] not in (3,4):
                    raise FrameError("published POST lacks its completed real FINISH task")
                params = core._row(PARAM, finish)
                expected = [params[core._param_names[task[0]].index(name)] for name in profile["finish_params"]]
                if expected != b[b[at+15]:b[at+15]+b[at+7]]:
                    raise FrameError("POST payload differs from the latched real result")
