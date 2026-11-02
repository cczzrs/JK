"""Independent examples derived from plan.V6.1.md, not production predicates."""

import unittest

from jkcuda.reference import Reference


def node(name, *, queue="work", state=None, seed=0, mode="ANY", ports=(),
         sources=None, ops=None, publish="always", output=None):
    instructions = ops if ops is not None else [["J", "zero"], ["K", "p"]]
    return {"id": name, "generation": 1, "version": 1, "queue": queue,
            "state": state, "seed": seed,
            "ex": "".join(operation + "(" + source + ")" for operation, source in instructions),
            "sources": sources if sources is not None else {"p": {"kind": "PARAM", "param": "p"},
                                                            "zero": {"kind": "CONST", "value": 0}},
            "ops": instructions,
            "trigger": {"mode": mode, "ports": list(ports)},
            "publish": publish, "output": output}


def model(nodes, *, subscriptions=(), states=(), queues=None, values=None):
    return {"profile": "jkcuda.v6.1", "format_version": 1,
            "queues": queues or [{"name": "work", "priority": 1}],
            "states": [{"id": key, "initial": initial} for key, initial in states],
            "nodes": nodes, "subscriptions": list(subscriptions), "inputs": [],
            "values": values or {}}


def matcher_model(mode="ALL_LATEST", *, output="Y", state=None):
    sink = node("join", state=state, mode=mode, ports=("a", "b"), output=output,
                sources={"zero": {"kind": "CONST", "value": 0},
                         "a": {"kind": "PARAM", "param": "a"},
                         "b": {"kind": "PARAM", "param": "b"}},
                ops=[["J", "zero"], ["K", "a"], ["K", "b"]])
    edges = [{"source": "a", "target": "join", "port": "a", "order": 0},
             {"source": "b", "target": "join", "port": "b", "order": 0}]
    return model([node("a"), node("b"), sink], subscriptions=edges,
                 states=[] if state is None else [(state, 0)])


def inputs(items):
    return [{"node": name, "params": {"p": value}, "key": key}
            for name, value, key in items]


class ReferenceTests(unittest.TestCase):
    def test_transaction_ordered_aliases_and_result_references(self):
        n = node("n", state="S", sources={"p": {"kind": "PARAM", "param": "p"}},
                 ops=[["K", "p"]], output="Y")
        ref = Reference(model([n], states=[("S", 0)]))
        ref.enqueue([{"transaction": [
            {"node": "n", "params": {"p": 1}},
            {"node": "n", "result_refs": {"p": 0}},
            {"node": "n", "result_refs": {"p": 1}},
            {"node": "n", "result_refs": {"p": 0}}], "queue": "work", "contract": "toggle_chain"}])
        self.assertEqual(ref.run(), 1)
        self.assertEqual([row["seed"] for row in ref.trace if row["kind"] == "bind"], [0, 1, 0, 0])
        self.assertEqual([row["value"] for row in ref.outputs], [1, 0, 0, 1])
        self.assertEqual(ref.states, {"S": 1})
        self.assertEqual(ref.versions, {"S": 4})

    def test_transaction_missing_step_has_no_partial_commit(self):
        ref = Reference(model([node("n", state="S", output="Y")], states=[("S", 0)]))
        ref.enqueue([{"transaction": [{"node": "n", "params": {"p": 1}}, {"node": "n"}],
                      "queue": "work", "contract": "incomplete"}])
        self.assertEqual(ref.run(), 1)
        self.assertEqual(ref.states, {"S": 0})
        self.assertEqual(ref.versions, {"S": 0})
        self.assertEqual(ref.outputs, [])
        self.assertFalse(any(row["kind"] == "commit" for row in ref.trace))

    def test_transaction_state_source_observes_prior_candidate(self):
        m = model([
            node("write", state="S", sources={"p": {"kind": "PARAM", "param": "p"}}, ops=[["K", "p"]], output="S"),
            node("read", state="T", sources={"zero": {"kind": "CONST", "value": 0},
                                               "s": {"kind": "STATE", "state": "S"}, "self": {"kind": "SELF"}},
                 ops=[["J", "zero"], ["K", "s"], ["K", "self"]], output="T")],
            states=[("S", 0), ("T", 1)])
        ref = Reference(m)
        ref.enqueue([{"transaction": [{"node": "write", "params": {"p": 1}},
                                       {"node": "read"}, {"node": "write", "result_refs": {"p": 1}}],
                      "queue": "work", "contract": "state_alias"}])
        ref.run()
        self.assertEqual([row["seed"] for row in ref.trace if row["kind"] == "bind"], [0, 1, 1])
        self.assertEqual([row["value"] for row in ref.outputs], [1, 0, 1])
        self.assertEqual(ref.states, {"S": 1, "T": 0})
        self.assertEqual(ref.versions, {"S": 2, "T": 1})

    def test_transaction_multiple_events_keep_both_latest_pairs(self):
        ref = Reference(matcher_model("ALL_LATEST"))
        ref.enqueue([{"transaction": [
            {"node": "a", "params": {"p": 0}}, {"node": "b", "params": {"p": 1}},
            {"node": "a", "params": {"p": 1}}, {"node": "b", "params": {"p": 0}}],
            "queue": "work", "contract": "ordered_pair"}])
        ref.run()
        self.assertEqual([row["params"] for row in ref.trace if row["kind"] == "match"],
                         [{"a": 0, "b": 1}, {"a": 1, "b": 0}])
        self.assertEqual([row["value"] for row in ref.outputs], [1, 1])
        commits = [i for i, row in enumerate(ref.trace) if row["kind"] == "commit" and row["task"] == 1]
        first_delivery = next(i for i, row in enumerate(ref.trace) if row["kind"] == "delivery")
        self.assertLess(max(commits), first_delivery)

    def test_enqueue_only_latches_no_execution_or_propagation(self):
        ref = Reference(matcher_model())
        payload = {"p": 0}
        ref.enqueue([{"node": "a", "params": payload}])
        payload["p"] = 1
        self.assertEqual([entry["kind"] for entry in ref.trace], ["enqueue"])
        self.assertEqual(ref.latest, {})
        ref.step()
        self.assertEqual(ref.latest["join"], {"a": 0})

    def test_zero_and_duplicate_any_events_are_distinct(self):
        ref = Reference(model([node("in"), node("out", ports=("p",), output="Y")],
                              subscriptions=[{"source": "in", "target": "out", "port": "p", "order": 0}]))
        ref.enqueue([{"node": "in", "params": {"p": 0}}, {"node": "in", "params": {"p": 0}}])
        self.assertEqual(ref.run(), 4)
        self.assertEqual([row["value"] for row in ref.outputs], [0, 0])
        self.assertEqual([row["output"] for row in ref.outputs], [1, 2])

    def test_all_latest_overwrite_then_clear(self):
        ref = Reference(matcher_model("ALL_LATEST"))
        ref.enqueue(inputs([("a", 0, None), ("a", 1, None), ("b", 0, None),
                            ("b", 1, None), ("a", 0, None)]))
        ref.run()
        pairs = [row["params"] for row in ref.trace if row["kind"] == "match"]
        self.assertEqual(pairs, [{"a": 1, "b": 0}, {"a": 0, "b": 1}])
        self.assertEqual([row["value"] for row in ref.outputs], [1, 1])
        self.assertEqual(ref.latest["join"], {})

    def test_all_latest_keeps_two_complete_pairs(self):
        # V6.1 §3.3 example A=0 B=1 A=1 B=0 must not collapse last values.
        ref = Reference(matcher_model("ALL_LATEST"))
        ref.enqueue(inputs([("a", 0, None), ("b", 1, None), ("a", 1, None), ("b", 0, None)]))
        ref.run()
        self.assertEqual([x["params"] for x in ref.trace if x["kind"] == "match"],
                         [{"a": 0, "b": 1}, {"a": 1, "b": 0}])

    def test_zip_uses_every_source_fifo(self):
        ref = Reference(matcher_model("ZIP"))
        ref.enqueue(inputs([("a", 0, None), ("a", 1, None), ("b", 0, None), ("b", 1, None)]))
        ref.run()
        self.assertEqual([x["params"] for x in ref.trace if x["kind"] == "match"],
                         [{"a": 0, "b": 0}, {"a": 1, "b": 1}])

    def test_keyed_fifo_and_key_identity(self):
        ref = Reference(matcher_model("KEYED"))
        ref.enqueue(inputs([("a", 0, "x"), ("a", 1, "x"), ("a", 1, 1),
                            ("b", 0, "1"), ("b", 1, "x"), ("b", 0, "x"),
                            ("b", 0, 1), ("a", 0, "1")]))
        ref.run()
        pairs = [(row["key"], row["params"]) for row in ref.trace if row["kind"] == "match"]
        self.assertEqual(pairs, [("x", {"a": 0, "b": 1}), ("x", {"a": 1, "b": 0}),
                                 (1, {"a": 1, "b": 0}), ("1", {"a": 0, "b": 0})])

    def test_same_event_multiple_target_inputs_is_ordered(self):
        m = matcher_model()
        m["subscriptions"] = [
            {"source": "a", "target": "join", "port": "b", "order": 20},
            {"source": "a", "target": "join", "port": "a", "order": 10}]
        ref = Reference(m)
        ref.enqueue(inputs([("a", 0, None), ("a", 1, None)]))
        ref.run()
        self.assertEqual([x["port"] for x in ref.trace if x["kind"] == "delivery"],
                         ["a", "b", "a", "b"])
        self.assertEqual([x["value"] for x in ref.outputs], [0, 0])

    def test_priority_reselected_after_complete_propagation(self):
        m = model([node("low"), node("high", queue="urgent", ports=("p",))],
                  queues=[{"name": "urgent", "priority": 1}, {"name": "work", "priority": 5}],
                  subscriptions=[{"source": "low", "target": "high", "port": "p", "order": 0}])
        ref = Reference(m)
        ref.enqueue(inputs([("low", 0, None), ("low", 1, None)]))
        ref.run()
        self.assertEqual([x["node"] for x in ref.trace if x["kind"] == "select"],
                         ["low", "high", "low", "high"])
        active = None
        for entry in ref.trace:
            if entry["kind"] == "select":
                self.assertIsNone(active)
                active = entry["task"]
            elif entry["kind"] == "complete":
                self.assertEqual(entry["task"], active)
                active = None
        self.assertIsNone(active)

    def test_self_and_repeated_sources_bound_before_instructions(self):
        m = model([node("s", state="S", output="Y", sources={
            "zero": {"kind": "CONST", "value": 0}, "self": {"kind": "SELF"},
            "source": {"kind": "STATE", "state": "S"}},
            ops=[["J", "zero"], ["K", "self"], ["K", "source"], ["K", "source"]])], states=[("S", 1)])
        ref = Reference(m)
        ref.enqueue([{"node": "s"}, {"node": "s"}])
        ref.run()
        self.assertEqual([row["value"] for row in ref.outputs], [1, 1])
        self.assertEqual(ref.versions, {"S": 2})

    def test_seed_read_when_task_selected(self):
        m = model([node("s", state="S", output="Y", sources={"one": {"kind": "CONST", "value": 1}},
                        ops=[["K", "one"]])], states=[("S", 0)])
        ref = Reference(m)
        ref.enqueue([{"node": "s"}, {"node": "s"}, {"node": "s"}])
        ref.run()
        self.assertEqual([x["seed"] for x in ref.trace if x["kind"] == "bind"], [0, 1, 0])
        self.assertEqual([x["value"] for x in ref.outputs], [1, 0, 1])

    def test_missing_parameter_normal_completion_and_value_zero(self):
        m = model([node("missing", state="S"), node("value", sources={
            "v": {"kind": "VALUE", "value_id": "v0"}}, ops=[["K", "v"]], output="Y")],
            states=[("S", 1)], values={"v0": 0})
        ref = Reference(m)
        ref.enqueue([{"node": "missing"}, {"node": "value"}])
        ref.run()
        self.assertEqual(ref.states["S"], 1)
        self.assertEqual(ref.versions["S"], 0)
        self.assertEqual([x["outcome"] for x in ref.trace if x["kind"] == "complete"], ["missing", "computed"])
        self.assertEqual([x["value"] for x in ref.outputs], [0])

    def test_declared_parameter_check_survives_unused_arithmetic(self):
        m = model([node("n", output="Y", sources={
            "zero": {"kind": "CONST", "value": 0},
            "required": {"kind": "PARAM", "param": "required"}},
            ops=[["J", "zero"]])])
        ref = Reference(m)
        ref.enqueue([{"node": "n"}, {"node": "n", "params": {"required": 0}}])
        ref.run()
        self.assertEqual([x["outcome"] for x in ref.trace if x["kind"] == "complete"], ["missing", "computed"])
        self.assertEqual([x["value"] for x in ref.outputs], [0])

    def test_publish_modes_do_not_reuse_old_result(self):
        for condition, expected in [("always", [0, 1, 1, 0]), ("zero", [0, 0]),
                                    ("one", [1, 1]), ("never", []), ("changed", [1, 0])]:
            with self.subTest(condition=condition):
                ref = Reference(model([node("n", state="S", publish=condition, output="Y")], states=[("S", 0)]))
                ref.enqueue(inputs([("n", x, None) for x in [0, 1, 1, 0]]))
                ref.run()
                self.assertEqual([x["value"] for x in ref.outputs], expected)
                self.assertEqual(ref.versions["S"], 4)

    def test_all_latest_unmatched_input_does_not_block_next_task(self):
        ref = Reference(matcher_model())
        ref.enqueue(inputs([("a", 0, None)]))
        self.assertTrue(ref.step())
        self.assertFalse(ref.step())
        ref.enqueue(inputs([("b", 1, None)]))
        self.assertEqual(ref.run(), 2)
        self.assertEqual([x["value"] for x in ref.outputs], [1])

    def test_request_validation_is_atomic(self):
        ref = Reference(model([node("n")]))
        with self.assertRaises(ValueError):
            ref.enqueue([{"node": "n", "params": {"p": 0}}, {"node": "n", "params": {"p": 2}}])
        self.assertEqual(ref.trace, [])
        self.assertEqual(ref.next_task, 1)


if __name__ == "__main__":
    unittest.main()
