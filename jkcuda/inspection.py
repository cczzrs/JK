"""Read-only, bounded views of the synchronized runtime host mirror.

The view follows V6.1 Q01/Q02: task FIFOs contain pending tasks, while the
event queue belongs only to the active task. Historical arena rows are counted
separately. No observation receives outputs, initializes modules, or advances
the model. The caller holds Runtime._core_lock and Core._lock together.
"""
from __future__ import annotations

import copy
from collections import deque

from .backend import (Q, N, TASK, EVENT, TOKEN, TRACE, OUT, FRAMES, NTASK,
                      NEVENT, NTOKEN, NTRACE, NOUT, ACTIVE, MODEL_INDEX,
                      RES_TASK, RES_TOKEN, RES_TRACE, SECTIONS)

PHASES = ("QUEUED", "ACTIVE", "EXECUTED", "PROPAGATING", "COMPLETE", "MISSING")
TRIGGERS = ("ANY", "ALL_LATEST", "ZIP", "KEYED")
CONTROLS = {1: "INPUT_BIT", 2: "STORE", 3: "ACK_DEC", 4: "ACK_ACT",
            5: "FRAME_COMPLETE", 6: "PRE_ACCEPT", 7: "CLAIM"}


def _identity(index):
    return None if index < 0 else index + 1


def _key(core, index):
    value = core._decode_key(index)
    return {"key": value, "key_type": "null" if value is None else
            "integer" if type(value) is int else "string"}


def _task_kind(core, index, row):
    node = row[0]
    if node == -1:
        return "transaction"
    if node == -2:
        return "structure"
    if node == -3:
        return "control"
    if row[15] == -101:
        return "frame_output"
    if str(index + 1) in core._request_ids:
        return "input" if core._node_name(node) in {
            port["node"] for port in core.model["inputs"]} else "entrypoint"
    return "ex"


def _task(core, index, frame_id=None):
    row = core._row(TASK, index)
    node = row[0]
    descriptor = core._row(N, node) if node >= 0 else None
    result = {"task_id": index + 1, "node": core._node_name(node),
              "queue": core._queue_names[row[2]], "kind": _task_kind(core, index, row),
              "phase": PHASES[row[4]], "params": core._task_params(index),
              **_key(core, row[1]),
              "seed": row[5] if row[5] in (0, 1) else None,
              "result": row[6] if row[6] in (0, 1) else None,
              "generation": descriptor[13] if descriptor else None,
              "program_version": descriptor[14] if descriptor else None,
              "cause_task": _identity(row[10]), "cause_event": _identity(row[11]),
              "event_count": row[8], "event_done": row[9],
              "request_id": core._request_ids.get(str(index + 1))}
    if node == -3:
        result["control"] = CONTROLS.get(row[15], "UNKNOWN")
        base, at, opcode = core._offsets[FRAMES], row[14], row[15]
        def word(offset):
            return core._arena[base+offset]
        if opcode == 1:
            result["payload"] = {"frame_id": word(word(at)+2),
                                 "position": word(at+1), "value": word(at+2)}
        elif opcode in (2, 6, 7):
            result["payload"] = {"frame_id": word(at+2)}
        elif opcode == 3:
            result["payload"] = {"ack": word(at)}
        elif opcode == 4:
            result["payload"] = {"frame_id": word(word(at)+2), "generation": word(at+1),
                                 "slot_generation": word(at+2), "token": word(at+3),
                                 "ack": word(at+4)}
        elif opcode == 5:
            batch = word(at)
            result["payload"] = {"batch_id": word(batch+1), "frame_id": word(word(batch+2)+2),
                                 "generation": word(at+1), "slot_generation": word(at+2),
                                 "marker_output_id": word(at+3)+1}
    elif row[15] == -101:
        result["kind"] = "frame_output"
        base, record = core._offsets[FRAMES], row[14]
        batch = core._arena[base+record]
        frame = core._arena[base+batch+2]
        result["payload"] = {"frame_id": core._arena[base+frame+2],
                             "batch_id": core._arena[base+batch+1],
                             "position": core._arena[base+record+1],
                             "value": core._arena[base+record+2],
                             "marker": core._arena[base+record+1] == core._arena[base+batch+7]}
    if node == -1:
        result["transaction"] = core._transaction_contracts.get(str(index + 1))
        result["internal_steps"] = row[13]
    if frame_id is None:
        frame_id = result.get("payload", {}).get("frame_id")
    if frame_id is not None:
        result["frame_id"] = frame_id
    return result


def _direct_frame_id(core, row):
    """Decode actual frame references; never infer ownership from a string key."""
    node, at = row[0], row[14]
    if node != -3 and row[15] != -101:
        return None
    base = core._offsets[FRAMES]
    def word(offset):
        return core._arena[base+offset]
    if node == -3:
        opcode = row[15]
        if opcode in (1, 4):
            return word(word(at)+2)
        if opcode in (2, 6, 7):
            return word(at+2)
        if opcode == 5:
            return word(word(word(at)+2)+2)
        # ACK_DEC does not bind a frame until execution creates a distinct ACT.
        return None
    return word(word(word(at)+2)+2)  # output record → batch → frame → frame ID


def _task_activity(core, limit):
    """Aggregate the entire retained task table, independently of UI windows.

    Node summaries span the logical ID's generations/program versions. Declared
    transaction internal operations are not separately queued node tasks.
    Frame ownership follows explicit control/output references and the protected
    business graph's causal parents. Generic keyed tasks are not assigned a
    frame merely because their key resembles the frame adapter's key.
    """
    def summary(scope):
        return {"scope": scope, "total": 0, "pending": 0, "completed": 0,
                "active_task_id": None, "last_task_id": None, "last_phase": None,
                "last_task": None, "queued_task_ids": [], "queued_truncated": False}
    installed = {node["id"]: node for node in core._models[core._m(MODEL_INDEX)]["nodes"]}
    nodes = {name: {**summary("logical_id_all_generations"), "installed": name in installed,
                    "current_generation": installed[name]["generation"] if name in installed else None,
                    "current_program_version": installed[name]["version"] if name in installed else None}
             for name in core._logical_ids}
    enabled = bool(core.model.get("frame_module"))
    business = core.model.get("business_module") or {}
    controls = {name: {**summary("control_type_all_frames"),
                      "enabled": bool(business) if opcode in (6, 7) else True}
                for opcode, name in CONTROLS.items()} if enabled else {}
    other = {kind: summary("task_kind") for kind in ("transaction", "structure")}
    total, active = core._m(NTASK), core._m(ACTIVE)
    frame_ids = [None] * total
    protected = set(business.get("protected_nodes", []))
    queued_limit = min(limit, 16)
    pending = completed = 0
    for index in range(total):
        row = core._row(TASK, index)
        node = core._node_name(row[0])
        frame_id = _direct_frame_id(core, row)
        if frame_id is None and node in protected and 0 <= row[10] < index:
            frame_id = frame_ids[row[10]]
        frame_ids[index] = frame_id
        if row[0] >= 0:
            group = nodes[node]
        elif row[0] == -3:
            group = controls[CONTROLS[row[15]]]
        else:
            group = other["transaction" if row[0] == -1 else "structure"]
        group["total"] += 1
        group["last_task_id"], group["last_phase"] = index+1, PHASES[row[4]]
        if row[4] == 0:
            pending += 1; group["pending"] += 1
            if len(group["queued_task_ids"]) < queued_limit:
                group["queued_task_ids"].append(index+1)
            else:
                group["queued_truncated"] = True
        elif row[4] == 4:
            completed += 1; group["completed"] += 1
        if index == active:
            group["active_task_id"] = index+1
    for groups in (nodes, controls, other):
        for group in groups.values():
            if group["last_task_id"] is not None:
                index = group["last_task_id"]-1
                group["last_task"] = _task(core, index, frame_ids[index])
    return {"scope": "all_retained_tasks", "total": total, "pending": pending,
            "completed": completed, "active_task_id": _identity(active),
            "nodes": nodes, "controls": controls, "other": other}, frame_ids


def _task_info(core, index, frame_id):
    """Immutable task provenance for a trace record, not a second trace event."""
    row = core._row(TASK, index)
    result = {"task_id": index+1, "kind": _task_kind(core, index, row),
              "node": core._node_name(row[0]), "queue": core._queue_names[row[2]]}
    if row[0] == -3:
        result["control"] = CONTROLS.get(row[15], "UNKNOWN")
    elif row[0] >= 0:
        node = core._row(N, row[0])
        result.update(generation=node[13], program_version=node[14])
    if frame_id is not None:
        result["frame_id"] = frame_id
    return result


def _event(core, index):
    row = core._row(EVENT, index)
    source = core._row(N, row[1])
    graph = core._row(N, row[8]) if row[8] >= 0 else None
    subscription_version = next((version for version, slots in enumerate(core._version_maps)
                                 if slots.get(core._node_name(row[8])) == row[8]), None) if graph else None
    return {"event_id": index + 1, "owner_task_id": row[0] + 1,
            "source": core._node_name(row[1]), "value": row[2],
            **_key(core, row[3]), "delivered": row[4], "fanout": row[6],
            "complete": bool(row[7]), "source_generation": source[13],
            "subscription_version": subscription_version,
            "program_version": source[14]}


def _trace(core, index, frame_ids):
    """Decode just the requested trace row, preserving Core.trace's fields."""
    kind, task, node, value, event, port, key, x, _, _ = core._row(TRACE, index)
    name, task_id = core._node_name(node), task + 1
    if kind == 1:
        row = {"kind": "enqueue", "task": task_id, "node": name,
               "queue": core._queue_names[core._row(TASK, task)[2]],
               "key": core._decode_key(key), "params": core._task_params(task)}
    elif kind == 2:
        row = {"kind": "select", "task": task_id, "node": name}
    elif kind == 3:
        row = {"kind": "bind", "task": task_id, "node": name, "seed": value}
    elif kind == 4:
        row = {"kind": "commit", "task": task_id, "node": name, "value": value,
               "state_version": None if x < 0 else x}
    elif kind == 5:
        row = {"kind": "event", "task": task_id, "node": name, "event": event + 1,
               "value": value, "key": core._decode_key(key)}
    elif kind == 6:
        row = {"kind": "delivery", "task": task_id, "event": event + 1,
               "source": core._node_name(x), "target": name,
               "port": core._param_names[node][port], "value": value,
               "key": core._decode_key(key)}
    elif kind == 7:
        row = {"kind": "match", "event": event + 1, "node": name,
               "params": core._task_params(task), "key": core._decode_key(key)}
    elif kind == 8:
        row = {"kind": "complete", "task": task_id, "node": name,
               "outcome": "missing" if value else "computed"}
    elif kind == 9:
        row = {"kind": "output", "output": x + 1, "task": task_id, "node": name,
               "port": core._output_names[port], "value": value,
               "key": core._decode_key(key), "event": event + 1}
    elif kind == 10:
        row = {"kind": "structure", "task": task_id, "model_version": value,
               "outcome": "applied" if x else "rejected_pending_tokens"}
    else:
        raise ValueError("invalid trace kind")
    if "key" in row:
        row["key_type"] = "null" if row["key"] is None else "integer" if type(row["key"]) is int else "string"
    if 0 <= task < len(frame_ids):
        row["task_info"] = _task_info(core, task, frame_ids[task])
    return {"seq": index + 1, **row}


def _frames(core, limit):
    """Read initialized frame storage directly; never call Frames.__init__."""
    enabled = bool(core.model.get("frame_module"))
    initialized = enabled and core._sizes[FRAMES] > 0 and core._row(FRAMES, 0)[0] > 0
    result = {"enabled": enabled, "initialized": initialized}
    if not initialized:
        return result
    base = core._offsets[FRAMES]
    def word(index):
        return core._arena[base + index]
    def chain(head):
        at = word(head)
        while at >= 0:
            yield at
            at = word(at)
    def values(at, count):
        return [word(at + i) for i in range(min(count, limit))]
    def selected(head, live):
        # Prefer in-flight ownership over retained history. A long session must
        # not hide the current head behind the first N consumed frame records.
        current, recent, total = [], deque(maxlen=limit), 0
        for at in chain(head):
            total += 1
            recent.append(at)
            if live(at) and len(current) < limit:
                current.append(at)
        seen = set(current)
        remaining = [at for at in recent if at not in seen]
        if len(current) < limit:
            current.extend(remaining[-(limit-len(current)):])
        return current, total
    frames, blocks, batches = [], [], []
    frame_rows, frame_total = selected(11, lambda at: not word(at+10))
    block_rows, block_total = selected(18, lambda at: word(at+4) > 0 or word(at+5) > 0)
    batch_rows, batch_total = selected(22, lambda at: not word(at+9))
    for at in frame_rows:
        block, width = word(at + 4), word(at + 7)
        frame = {"frame_id": word(at + 2), "generation": word(at + 3),
                 "width": width, "arrived": word(at + 8),
                 "stored": bool(word(at + 9)), "consumed": bool(word(at + 10)),
                 "qualified": bool(word(at + 11)), "token": word(at + 12),
                 "block_id": None if block < 0 else word(block + 1),
                 "slot": word(at + 5), "slot_generation": word(at + 6),
                 "held_batches": word(at + 18),
                 "values": [word(word(at+15)+i) if word(word(at+17)+i) else None
                            for i in range(min(width, limit))],
                 "values_truncated": width > limit}
        context = word(at + 20)
        if context >= 0:
            input_width, raw, valid = word(context + 2), word(context + 3), word(context + 4)
            frame.update({"input_width": input_width, "pre_stage": word(context + 5),
                          "pre_values": [word(raw+i) if word(valid+i) else None
                                         for i in range(min(input_width, limit))],
                          "post_values": values(word(at+15), width) if word(context+5) == 4 else None,
                          "values_truncated": input_width > limit or width > limit,
                          "claim_task_id": _identity(word(context+8)),
                          "finish_task_id": _identity(word(context+7))})
        frames.append(frame)
    for at in block_rows:
        blocks.append({"block_id": word(at+1), "generation": word(at+2),
                       "used": word(at+3), "live": word(at+4), "held_batches": word(at+5)})
    for at in batch_rows:
        width, records, frame = word(at+7), word(at+12), word(at+2)
        batches.append({"batch_id": word(at+1), "frame_id": word(frame+2),
                        "generation": word(at+3), "slot_generation": word(at+4),
                        "width": width, "produced": word(at+8), "complete": word(at+8) == width+1,
                        "received": bool(word(at+9)), "replay": bool(word(at+6)),
                        "token": word(at+5), "completion_task_id": word(at+10) or None,
                        "marker_output_id": _identity(word(at+11)),
                        "marker": word(records+width*6+3) if word(records+width*6+5) else None,
                        "values": [word(records+i*6+3) if word(records+i*6+5) else None
                                   for i in range(min(width, limit))],
                        "values_truncated": width > limit})
    head = word(6)
    result.update({"head": None if head < 0 else word(head+2), "frames": frames,
                   "blocks": blocks, "batches": batches, "completion_reserved": word(24),
                   "frame_total": frame_total, "block_total": block_total, "batch_total": batch_total,
                   "items_policy": "live_first_then_recent",
                   "truncated": max(frame_total, block_total, batch_total) > limit})
    if core.model.get("business_module"):
        active, at, pending, total = word(29), word(27), [], 0
        while at >= 0:
            total += 1
            if len(pending) < limit:
                pending.append(word(at+2))
            at = word(word(at+20))
        result["business"] = {"active_frame": None if active < 0 else word(active+2),
                              "pre_queue": pending, "pending": total, "truncated": total > limit}
    return result


def observe(runtime, *, since_trace=0, limit=200, include_model=False):
    if since_trace is not None and (type(since_trace) is not int or since_trace < 0):
        raise ValueError("since_trace must be null or a nonnegative integer")
    if type(limit) is not int or not 1 <= limit <= 10000:
        raise ValueError("limit must be an integer in [1, 10000]")
    core = runtime._core
    with runtime._core_lock, core._lock:
        status = {**runtime.status(), "fatal_error": core._fatal,
                  "mirror_valid": core._fatal is None}
        active = core._m(ACTIVE)
        activity, frame_ids = _task_activity(core, limit)
        queues = []
        for index, name in enumerate(core._queue_names):
            priority, head, tail, pending = core._row(Q, index)
            tasks, at = [], head
            while at >= 0 and len(tasks) < limit:
                tasks.append(_task(core, at, frame_ids[at])); at = core._row(TASK, at)[3]
            queues.append({"name": name, "priority": priority, "pending": pending,
                           "head": _identity(head), "tail": _identity(tail),
                           "tasks": tasks, "truncated": at >= 0})
        event_count, events = 0, []
        if active >= 0:
            task = core._row(TASK, active)
            event_count = task[8] - task[9]
            events = [_event(core, i) for i in range(task[7]+task[9],
                      task[7]+task[9]+min(event_count, limit))]
        tokens, pending_tokens = [], 0
        for index in range(core._m(NTOKEN)):
            row = core._row(TOKEN, index)
            if not row[6]:
                continue
            pending_tokens += 1
            if len(tokens) < limit:
                tokens.append({"token_id": index+1, "target": core._node_name(row[0]),
                               "port": core._param_names[row[0]][row[1]], "value": row[2],
                               **_key(core, row[3]), "event_id": row[4]+1, "owner_task_id": row[7]+1,
                               "mode": TRIGGERS[core._row(N, row[0])[6]]})
        frames = _frames(core, limit)
        credits = {"tasks": core._m(RES_TASK), "tokens": core._m(RES_TOKEN),
                   "traces": core._m(RES_TRACE)}
        if frames["initialized"]:
            base = core._offsets[FRAMES]
            for name, offset in (("tasks", 24), ("traces", 25), ("frames", 26)):
                credits[name] = credits.get(name, 0) + core._arena[base+offset]
        storage = [{"name": name, "used": core._used(SECTIONS.index(name)),
                    "reserved": credits.get(name, 0), "capacity": capacity,
                    "unit": "int64_words" if name == "frames" else "records"}
                   for name, capacity in core._capacities.items()]
        output_count, outputs = core._m(NOUT), []
        for index in range(max(0, output_count-limit), output_count):
            task, node, value, key, event, port, _, _ = core._row(OUT, index)
            identifier = f"{runtime.instance_id}:{index+1}"
            record = {"output_id": identifier, "output": index+1, "task": task+1,
                      "node": core._node_name(node), "port": core._output_names[port],
                      "value": value, "event": event+1, **_key(core, key),
                      "acknowledged": identifier in runtime._acknowledged}
            # Existing annotations are safe to copy. Collecting them here would
            # initialize the frame adapter or register a host-receipt action.
            existing = runtime._outbox.get(identifier, {})
            for field in ("batch_id", "frame_id", "generation", "position", "marker"):
                if field in existing:
                    record[field] = copy.deepcopy(existing[field])
            outputs.append(record)
        total_trace = core._m(NTRACE)
        start = max(0, total_trace-limit) if since_trace is None else min(since_trace, total_trace)
        end = min(start+limit, total_trace)
        result = {"schema": "jkcuda.observe/1", "instance_id": runtime.instance_id,
                  "status": status, "model_version": core._m(MODEL_INDEX),
                  "queues": queues, "active_task": None if active < 0 else _task(core, active, frame_ids[active]),
                  "task_activity": activity,
                  "events": {"pending": event_count, "total": core._m(NEVENT),
                             "items": events, "truncated": event_count > limit},
                  "tokens": {"pending": pending_tokens, "total": core._m(NTOKEN),
                             "items": tokens, "truncated": pending_tokens > limit},
                  "storage": storage, "outputs": {"total": output_count,
                      "unacknowledged": output_count-len(runtime._acknowledged),
                      "items": outputs, "truncated": output_count > limit},
                  "frames": frames,
                  "trace": {"items": [_trace(core, i, frame_ids) for i in range(start, end)],
                            "next_cursor": end, "total": total_trace, "has_more": end < total_trace}}
        if include_model:
            result["model"] = core.current_model()
        return result
