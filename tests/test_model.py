"""Contract-level loader counterexamples, independent of backend execution."""

from copy import deepcopy
import unittest

from jkcuda.model import ModelError, load_model, parse_ex, structure_fingerprint


def base_model():
    return {"profile": "jkcuda.v6.1", "format_version": 1,
            "queues": [{"name": "input", "priority": 1}, {"name": "compute", "priority": 5}],
            "states": [{"id": "accumulator", "initial": 0}],
            "nodes": [{"id": "input", "queue": "input", "ex": "J0K(bit)",
                       "sources": {"bit": {"kind": "PARAM", "param": "bit"}},
                       "trigger": {"mode": "ANY", "ports": []}},
                      {"id": "compute", "queue": "compute", "state": "accumulator",
                       "ex": "K(value)K(self)K(value)",
                       "sources": {"value": {"kind": "PARAM", "param": "value"},
                                   "self": {"kind": "SELF"}},
                       "trigger": {"mode": "ANY", "ports": ["value"]}, "output": "result"}],
            "subscriptions": [{"source": "input", "target": "compute", "port": "value", "order": 0}],
            "inputs": [{"name": "input", "node": "input", "param": "bit"}]}


class ModelTests(unittest.TestCase):
    def reject(self, model, message=None):
        if message is None:
            with self.assertRaises(ModelError):
                load_model(model)
        else:
            with self.assertRaisesRegex(ModelError, message):
                load_model(model)

    def test_normalization_preserves_repeated_ops_and_is_idempotent(self):
        original = base_model()
        model = load_model(original)
        self.assertNotIn("ops", original["nodes"][0])
        self.assertEqual(model["nodes"][1]["ops"], [["K", "value"], ["K", "self"], ["K", "value"]])
        self.assertEqual(load_model(model), model)

    def test_unknown_profile_and_revision_fail_closed(self):
        for revision in (0, 2, True):
            model = base_model(); model["format_version"] = revision
            self.reject(model)
        model = base_model(); model["profile"] = "JKRD-V5-DAG-1-2-5"
        self.reject(model)

    def test_fifo_names_priorities_and_node_ownership(self):
        model = base_model(); model["queues"][1]["priority"] = 1; self.reject(model)
        model = base_model(); model["queues"][1]["name"] = "input"; self.reject(model)
        model = base_model(); model["nodes"][1]["queue"] = "undeclared"; self.reject(model)
        model = base_model(); model["queues"][0]["priority"] = True; self.reject(model)

    def test_literal_compilation_cannot_remove_declared_parameter_contract(self):
        model = base_model()
        model["nodes"][0]["sources"]["$0"] = {"kind": "PARAM", "param": "required"}
        self.reject(model)
        model = base_model()
        model["nodes"][0]["sources"]["$0"] = {"kind": "CONST", "value": 1}
        self.reject(model)

    def test_parser_consumes_all_tokens_and_checks_compiled_ops(self):
        for expression in ("J0K(bit) rubbish", "J0K(undefined)", "J0K((bit))", "K2", ""):
            model = base_model(); model["nodes"][0]["ex"] = expression; self.reject(model)
        model = base_model(); model["nodes"][1]["ops"] = [["J", "value"]]; self.reject(model)

    def test_invalid_bits_and_missing_state_or_value_are_not_defaulted(self):
        for value in (False, True, -1, 2, "0", 0.0, None):
            model = base_model(); model["states"][0]["initial"] = value; self.reject(model)
        model = base_model(); model["nodes"][1]["state"] = "missing"; self.reject(model)
        model = base_model(); model["nodes"][1]["sources"]["self"] = {"kind": "STATE", "state": "missing"}; self.reject(model)
        model = base_model(); model["nodes"][1]["sources"]["self"] = {"kind": "VALUE", "value_id": "future"}; self.reject(model)

    def test_any_cannot_supply_two_independent_event_parameters(self):
        model = base_model()
        target = model["nodes"][1]
        target["sources"]["other"] = {"kind": "PARAM", "param": "other"}
        target["ex"] += "K(other)"
        target["trigger"]["ports"].append("other")
        model["subscriptions"].append({"source": "input", "target": "compute", "port": "other", "order": 1})
        self.reject(model, "ANY")
        target["trigger"]["mode"] = "ALL_LATEST"
        self.assertEqual(load_model(model)["nodes"][1]["trigger"]["ports"], ["value", "other"])

    def test_partial_collecting_trigger_cannot_claim_missing_port(self):
        model = base_model()
        model["nodes"][1]["trigger"] = {"mode": "ZIP", "ports": ["value", "absent"]}
        self.reject(model)

    def test_subscriptions_preserve_declared_order_and_reject_ambiguous_order(self):
        model = base_model()
        model["subscriptions"].append(deepcopy(model["subscriptions"][0]))
        self.reject(model)
        model = base_model(); model["subscriptions"][0]["order"] = 2**63; self.reject(model)
        model = base_model(); model["subscriptions"][0]["port"] = "absent"; self.reject(model)

    def test_feedback_requires_start_path_and_budget(self):
        model = base_model()
        node = model["nodes"][1]
        model["subscriptions"].append({"source": "compute", "target": "compute", "port": "value", "order": 0})
        self.reject(model, "budget")
        model["budgets"] = [{"id": 0, "limit": 10}]
        node["budget_group"] = 0
        load_model(model)
        model["subscriptions"] = model["subscriptions"][1:]
        self.reject(model, "startup")
        model["entrypoints"] = ["compute"]
        load_model(model)

    def test_transaction_dependency_must_be_earlier_and_supply_required_parameters(self):
        model = base_model()
        model["transactions"] = [{"name": "combine", "queue": "compute",
                                  "steps": [{"node": "compute", "params": {"value": {"param": "x"}}},
                                            {"node": "compute", "result_refs": {"value": 0}}]}]
        normalized = load_model(model)
        self.assertEqual(normalized["transactions"][0]["steps"][1]["result_refs"], {"value": 0})
        model["transactions"][0]["steps"][1]["result_refs"]["value"] = 1
        self.reject(model)
        model = base_model()
        model["transactions"] = [{"name": "missing", "queue": "compute", "steps": [{"node": "compute"}]}]
        self.reject(model)

    def test_no_unknown_semantic_fields_or_duplicate_state_ids(self):
        model = base_model(); model["nodes"][0]["skip_fifo"] = True; self.reject(model)
        model = base_model(); model["states"].append(deepcopy(model["states"][0])); self.reject(model)
        model = base_model(); model["subscriptions"][0]["source"] = "missing"; self.reject(model)

    def test_structure_hash_excludes_only_root_metadata(self):
        model = load_model(base_model())
        before = structure_fingerprint(model)
        model["metadata"] = {"display": "rearranged"}
        self.assertEqual(structure_fingerprint(model), before)
        model["states"][0]["initial"] = 1
        self.assertNotEqual(structure_fingerprint(model), before)


if __name__ == "__main__":
    unittest.main()
