"""Independent scalar semantic oracle for the explicitly registered V6.1 profile.

This module deliberately imports neither the production backend nor Torch.  Its
objects and algorithms follow plan.V6.1.md §§3.1–3.5: ordered FIFO tasks, fixed
execution-time bindings, and complete propagation before the next selection.
It is a correctness reference, never a CUDA fallback or a performance model.
"""

from collections import defaultdict, deque
from copy import deepcopy


class Reference:
    """Run a normalized model with unbounded Python collections.

    ``enqueue`` latches parameters but does not read state or propagate events.
    ``step`` completes one logical task, including all deliveries and enqueues.
    The oracle intentionally has no production memory allocator/fault protocol;
    interrupted production traces are compared to the uninterrupted oracle.
    """

    def __init__(self, model):
        self.model = deepcopy(model)
        self.nodes = {n["id"]: n for n in self.model["nodes"]}
        self.states = {s["id"]: s["initial"] for s in self.model.get("states", [])}
        self.versions = {s: 0 for s in self.states}
        self.values = deepcopy(self.model.get("values", {}))
        self.queues = {q["name"]: deque() for q in self.model["queues"]}
        self.queue_order = [q["name"] for q in sorted(
            self.model["queues"], key=lambda q: q["priority"])]
        self.subscriptions = defaultdict(list)
        for edge in self.model.get("subscriptions", []):
            self.subscriptions[edge["source"]].append(deepcopy(edge))
        for edges in self.subscriptions.values():
            edges.sort(key=lambda edge: edge["order"])
        self.latest = defaultdict(dict)
        self.waiting = defaultdict(lambda: defaultdict(deque))
        self.trace = []
        self.outputs = []
        self.tasks = {}
        self.next_task = 1
        self.next_event = 1
        self.next_output = 1
        self.completed = 0

    def _record(self, kind, **fields):
        self.trace.append({"kind": kind, **deepcopy(fields)})

    def enqueue(self, requests):
        """Atomically validate and latch a list of explicit node requests."""
        prepared = []
        for request in requests:
            steps = None
            if "transaction" in request:
                node = None
                steps = deepcopy(request["transaction"])
                if not isinstance(steps, list) or not steps:
                    raise ValueError("transaction requires ordered internal steps")
                queue = request["queue"]
                if queue not in self.queues:
                    raise ValueError("unknown FIFO")
                for index, step in enumerate(steps):
                    step["definition"] = deepcopy(self.nodes[step["node"]])
                    for value in step.get("params", {}).values():
                        if type(value) is not int or value not in (0, 1):
                            raise ValueError("transaction parameters must be integer bits")
                    for parameter, prior in step.get("result_refs", {}).items():
                        if type(prior) is not int or not 0 <= prior < index or parameter in step.get("params", {}):
                            raise ValueError("transaction result must refer to a distinct preceding step")
            else:
                node = self.nodes[request["node"]]
                queue = node["queue"]
            params = deepcopy(request.get("params", {}))
            if any(type(v) is not int or v not in (0, 1) for v in params.values()):
                raise ValueError("parameters must be integer bits")
            key = request.get("key")
            if key is not None and type(key) not in (str, int):
                raise ValueError("key must be a string, integer, or null")
            prepared.append((deepcopy(node), params, key, steps, queue))
        return [self._append(node, params, key, steps, queue)
                for node, params, key, steps, queue in prepared]

    def _append(self, node, params, key, steps=None, queue=None):
        task_id = self.next_task
        self.next_task += 1
        task = {"id": task_id, "node": deepcopy(node),
                "params": deepcopy(params), "key": key, "steps": deepcopy(steps)}
        self.tasks[task_id] = task
        queue = node["queue"] if queue is None else queue
        self.queues[queue].append(task)
        self._record("enqueue", task=task_id, node=node["id"] if node else None, queue=queue,
                     key=key, params=params)
        return task_id

    def _binding(self, node, task, seed, states=None):
        """Resolve each declared source once, before evaluating any instruction."""
        bound = {}
        for name, source in node["sources"].items():
            kind = source["kind"]
            if kind == "CONST":
                bound[name] = source["value"]
            elif kind == "STATE":
                bound[name] = (self.states if states is None else states)[source["state"]]
            elif kind == "PARAM":
                if source["param"] not in task["params"]:
                    return None
                bound[name] = task["params"][source["param"]]
            elif kind == "VALUE":
                if source["value_id"] not in self.values:
                    return None
                bound[name] = self.values[source["value_id"]]
            elif kind == "SELF":
                bound[name] = seed
            else:
                raise ValueError("unknown source kind: " + str(kind))
        return bound

    @staticmethod
    def _evaluate(ops, bound, seed):
        # Truth-table indexing is intentionally different from the production
        # accumulator's bit operations; order and fixed bindings remain explicit.
        truth = {"J": ((0, 0), (0, 1)), "K": ((0, 1), (1, 0))}
        accumulator = seed
        for operation, source in ops:
            accumulator = truth[operation][accumulator][bound[source]]
        return accumulator

    def _deliver(self, task, event_id, source, edge, value, key):
        target = self.nodes[edge["target"]]
        port = edge["port"]
        self._record("delivery", task=task["id"], event=event_id, source=source,
                     target=target["id"], port=port, value=value, key=key)
        mode = target["trigger"]["mode"]
        ports = target["trigger"]["ports"]
        if mode == "ANY":
            params = {port: value}
        elif mode == "ALL_LATEST":
            pending = self.latest[target["id"]]
            pending[port] = value
            if any(p not in pending for p in ports):
                return
            params = {p: pending[p] for p in ports}
            pending.clear()
        elif mode in ("ZIP", "KEYED"):
            bucket = (target["id"], (type(key).__name__, key) if mode == "KEYED" else None)
            pending = self.waiting[bucket]
            pending[port].append(value)
            if any(not pending[p] for p in ports):
                return
            params = {p: pending[p].popleft() for p in ports}
        else:
            raise ValueError("unknown trigger mode: " + str(mode))
        self._record("match", event=event_id, node=target["id"], params=params, key=key)
        self._append(target, params, key)

    def step(self):
        task = None
        for name in self.queue_order:
            if self.queues[name]:
                task = self.queues[name].popleft()
                break
        if task is None:
            return False
        node = task["node"]
        task_id = task["id"]
        node_id = node["id"] if node else None
        self._record("select", task=task_id, node=node_id)
        candidates = []
        local_states = dict(self.states)
        operations = task["steps"] if task["steps"] is not None else [
            {"definition": node, "params": task["params"]}]
        for operation in operations:
            definition = operation["definition"]
            state_id = definition.get("state")
            seed = local_states[state_id] if state_id is not None else definition.get("seed", 0)
            self._record("bind", task=task_id, node=definition["id"], seed=seed)
            params = deepcopy(operation.get("params", {}))
            for parameter, prior in operation.get("result_refs", {}).items():
                params[parameter] = candidates[prior][2]
            bound = self._binding(definition, {"params": params}, seed, local_states)
            if bound is None:
                self._record("complete", task=task_id, node=node_id, outcome="missing")
                self.completed += 1
                return True
            result = self._evaluate(definition["ops"], bound, seed)
            candidates.append((definition, seed, result))
            if state_id is not None:
                local_states[state_id] = result
        events = []
        for definition, seed, result in candidates:
            emitted = self._commit(task, definition, seed, result)
            if emitted is not None:
                events.append(emitted)
        for source, event_id, result in events:
            # All internal EXs belong to the declared transaction. Its complete
            # write set and ordered event sequence precede any target execution.
            for edge in self.subscriptions[source]:
                self._deliver(task, event_id, source, edge, result, task["key"])
        self._record("complete", task=task_id, node=node_id, outcome="computed")
        self.completed += 1
        return True

    def _commit(self, task, node, seed, result):
        task_id, node_id, state_id = task["id"], node["id"], node.get("state")
        if state_id is not None:
            self.states[state_id] = result
            self.versions[state_id] += 1
        self._record("commit", task=task_id, node=node_id, value=result,
                     state_version=self.versions[state_id] if state_id is not None else None)
        condition = node["publish"]
        publish = (condition == "always" or condition == "zero" and result == 0
                   or condition == "one" and result == 1
                   or condition == "changed" and result != seed)
        if publish:
            event_id = self.next_event
            self.next_event += 1
            self._record("event", task=task_id, node=node_id, event=event_id,
                         value=result, key=task["key"])
            if node.get("output") is not None:
                output = {"output": self.next_output, "task": task_id, "node": node_id,
                          "port": node["output"], "value": result, "key": task["key"],
                          "event": event_id}
                self.next_output += 1
                self.outputs.append(deepcopy(output))
                self._record("output", **output)
            return node_id, event_id, result
        return None

    def run(self, limit=100000):
        if type(limit) is not int or limit < 0:
            raise ValueError("limit must be a nonnegative integer")
        count = 0
        while count < limit and self.step():
            count += 1
        return count

    def pending(self):
        return {name: [task["id"] for task in queue] for name, queue in self.queues.items()}
