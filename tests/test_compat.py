"""Legacy expectations derived from JKRD and published draft byte vectors."""

import copy
import hashlib
import json
from pathlib import Path
import unittest

from jkcuda.compat import (
    CompatibilityError, SUPPORT_MATRIX, canonical_bytes, fingerprints_v5,
    import_v5_structure, load_document, parse_v5_ex, verify_v5_fingerprints,
)


ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "assets/v5-snapshot-design"


def structure():
    return json.loads((FIXTURES / "structure-example.json").read_text())


def signed(doc):
    """Independent literal F/M formula for semantic-invalid fixture mutations."""
    result = copy.deepcopy(doc)
    normalized = copy.deepcopy(result["structure"])
    for node in normalized["nodes"]:
        if node.get("pro") == "q=0/1":
            node.pop("pro")
    fmt = {"domain": "jk-v5-format-draft-1", "schema_revision": result["schema_revision"],
           "rule_profile": result["rule_profile"], "canonicalization": result["canonicalization"],
           "structure": normalized}
    run = {"domain": "jk-v5-document-draft-1", "format": result["format"],
           "format_payload": fmt, "runtime": result.get("runtime")}
    digest = lambda value: hashlib.md5(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                                 separators=(",", ":")).encode()).hexdigest()
    result["fingerprints"] = {"format_md5": digest(fmt), "md5": digest(run)}
    return result


class FingerprintTests(unittest.TestCase):
    def test_published_canonical_byte_vectors(self):
        cases = json.loads((FIXTURES / "validation-and-fingerprint-cases.json").read_text())
        for vector in cases["byte_vectors"]:
            with self.subTest(vector=vector["id"]):
                obj = json.loads(vector.get("equivalent_input_text", vector["canonical_text"]))
                actual = canonical_bytes(obj)
                self.assertEqual(actual.hex(), vector["utf8_hex"])
                self.assertEqual(hashlib.md5(actual).hexdigest(), vector["md5"])

    def test_unicode_scalar_order_and_array_order(self):
        self.assertEqual(canonical_bytes({"𐀀": 0, "\ue000": 1}), '{"\ue000":1,"𐀀":0}'.encode())
        self.assertNotEqual(canonical_bytes([1, 0, 1]), canonical_bytes([0, 1, 1]))

    def test_all_historical_documents_and_embedded_contracts(self):
        paths = [FIXTURES / "structure-example.json", FIXTURES / "runtime-example.json"]
        paths += sorted((FIXTURES / "a03-dynamic").glob("0*.json"))
        self.assertEqual(len(paths), 8)
        for path in paths:
            with self.subTest(path=path.name):
                doc = json.loads(path.read_text())
                self.assertEqual(verify_v5_fingerprints(path), doc["fingerprints"])

    def test_only_root_metadata_and_exact_default_pro_are_excluded(self):
        doc = structure()
        old = fingerprints_v5(doc)
        doc["metadata"]["display"]["layout"] = "changed"
        doc["structure"]["nodes"][0]["pro"] = "q=0/1"
        self.assertEqual(fingerprints_v5(doc), old)
        doc = json.loads((FIXTURES / "runtime-example.json").read_text())
        before = fingerprints_v5(doc)
        # Task cause is nested runtime history; it is not root display metadata.
        task = next(task for queue in doc["runtime"]["fifos"].values() for task in queue)
        task["cause"].append({"kind": "input", "identity": "different-input"})
        after = fingerprints_v5(doc)
        self.assertEqual(after["format_md5"], before["format_md5"])
        self.assertNotEqual(after["md5"], before["md5"])

    def test_document_and_contract_tampering_rejected(self):
        doc = structure()
        doc["structure"]["initial_q"] = {"0": ["Q0", "Q1"], "1": ["Q2"]}
        with self.assertRaisesRegex(CompatibilityError, "fingerprint mismatch"):
            verify_v5_fingerprints(doc)
        doc = json.loads((FIXTURES / "a03-dynamic/01-input-copy-midway.json").read_text())
        doc["structure"]["contracts"][0]["definition"]["tampered"] = 1
        doc = signed(doc)  # Outer hashes cannot substitute for definition_md5.
        with self.assertRaisesRegex(CompatibilityError, "contract definition"):
            verify_v5_fingerprints(doc)

    def test_lexical_rejections(self):
        invalid = ['{"a":0,"\\u0061":1}', '{"a":-0}', '{"a":1.0}', '{"a":1e0}',
                   '{"a":NaN}', '{"a":Infinity}', '{"a":"\\ud800"}', '\ufeff{}',
                   '{} trailing', '{/* comment */}', '{"a":9007199254740992}']
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(CompatibilityError):
                load_document(value)
        with self.assertRaises(CompatibilityError):
            load_document(b'\xff')

    def test_unknown_profile_is_not_relabelled(self):
        doc = structure()
        doc["schema_revision"] = "draft-3"
        with self.assertRaises(CompatibilityError):
            verify_v5_fingerprints(doc)


class LegacyStructureTests(unittest.TestCase):
    def test_stateful_input_copies_are_event_sources(self):
        result = import_v5_structure(FIXTURES / "structure-example.json")
        nodes = {n["id"]: n for n in result.model["nodes"]}
        self.assertEqual(nodes["Q0"]["state"], "Q0")
        self.assertEqual(nodes["Q2"]["trigger"], {"mode": "ALL_LATEST", "ports": ["Q0", "Q1"]})
        self.assertEqual(nodes["Q2"]["sources"]["Q0"], {"kind": "PARAM", "param": "Q0"})
        self.assertEqual(result.model["queues"], [{"name": "Xi.FIFO", "priority": 1},
                                                {"name": "RAM.FIFO", "priority": 2},
                                                {"name": "Qi.FIFO", "priority": 5}])
        self.assertFalse(result.report["native_restore"])
        self.assertEqual(result.report["operation"], "import-structure-as-new-run")

    def test_repeated_self_and_live_state_binding(self):
        doc = structure()
        doc["structure"]["nodes"].append({"id": "Q3", "generation": "1", "ex_version": "1", "ex": "K(Q2)K(Q3)K(Q2)"})
        doc["structure"]["initial_q"]["0"].append("Q3")
        doc["structure"]["q_y"][0]["node"]["id"] = "Q3"
        nodes = import_v5_structure(signed(doc)).model["nodes"]
        target = nodes[-1]
        self.assertEqual(target["sources"]["Q2"], {"kind": "STATE", "state": "Q2"})
        self.assertEqual(target["sources"]["Q3"], {"kind": "SELF"})
        self.assertEqual(target["ops"], [["K", "Q2"], ["K", "Q3"], ["K", "Q2"]])
        self.assertEqual(target["trigger"], {"mode": "ANY", "ports": ["Q2"]})

    def test_migrated_model_loads_and_runs_independent_reference(self):
        from jkcuda.model import load_model
        from jkcuda.reference import Reference

        model = load_model(import_v5_structure(FIXTURES / "structure-example.json").model)
        reference = Reference(model)
        # Two complete pairs latch before Q2 runs. Stateful Q0/Q1 are still
        # event sources, so queued Q2 calls retain distinct pairs (1,0)/(0,0).
        reference.enqueue([{"node": "Q0", "params": {"X0": 1}},
                           {"node": "Q1", "params": {"X1": 0}},
                           {"node": "Q0", "params": {"X0": 0}},
                           {"node": "Q1", "params": {"X1": 0}}])
        while reference.step():
            pass
        self.assertEqual(reference.states["Q2"], 1)
        self.assertEqual([row["value"] for row in reference.outputs], [1, 1])
        self.assertEqual([row["node"] for row in reference.trace if row["kind"] == "select"],
                         ["Q0", "Q1", "Q0", "Q1", "Q2", "Q2"])

    def test_sparse_large_logical_id_keeps_numeric_order_without_narrowing(self):
        from jkcuda.model import load_model

        doc = structure()
        identifier = "Q" + str(2**100)
        doc["structure"]["nodes"][2]["id"] = identifier
        doc["structure"]["initial_q"]["0"][2] = identifier
        doc["structure"]["q_y"][0]["node"]["id"] = identifier
        model = load_model(import_v5_structure(signed(doc)).model)
        self.assertEqual(model["nodes"][2]["id"], identifier)
        self.assertEqual(model["subscriptions"][0]["target"], identifier)

    def test_complete_grammar_consumption(self):
        self.assertEqual(parse_v5_ex("J0K1J(Q0)K(Q0)"), [("J", "0"), ("K", "1"), ("J", "Q0"), ("K", "Q0")])
        for expression in ("", "J0 junk", "J0K(Q01)", "J0K(Q0) ", "J0K2", "J0K((Q0))", "J0K(self)", "J0K(-1)"):
            with self.subTest(expression=expression), self.assertRaises(CompatibilityError):
                parse_v5_ex(expression)

    def test_semantic_counterexamples(self):
        cases = []
        doc = structure(); doc["structure"]["nodes"][0]["ex"] = "J0K(X1)"; cases.append(doc)
        doc = structure(); doc["structure"]["nodes"][2]["ex"] = "J0K1"; cases.append(doc)
        doc = structure(); doc["structure"]["nodes"][2]["ex"] = "K(Q2)"; cases.append(doc)
        doc = structure(); doc["structure"]["nodes"][2]["ex"] = "K(Q99)"; cases.append(doc)
        doc = structure(); doc["structure"]["initial_q"]["0"].remove("Q2"); cases.append(doc)
        doc = structure(); doc["structure"]["nodes"][2]["pro"] = "q=1"; cases.append(doc)
        doc = structure(); doc["structure"]["initial_q"]["1"].append("Q2"); cases.append(doc)
        doc = structure(); doc["structure"]["q_y"][0]["node"]["generation"] = "2"; cases.append(doc)
        doc = structure(); doc["structure"]["nodes"][0]["hidden_behavior"] = "ignore-me"; cases.append(doc)
        doc = structure(); doc["structure"]["nodes"][2]["generation"] = str(2**63); cases.append(doc)
        for doc in cases:
            with self.subTest(doc=doc["structure"]), self.assertRaises(CompatibilityError):
                import_v5_structure(signed(doc))

    def test_silent_nodes_and_mutual_state_references_do_not_exempt_dag(self):
        doc = structure()
        doc["structure"]["nodes"][2]["ex"] = "K(Q0)K(Q1)K(Q3)"
        doc["structure"]["nodes"].append({"id": "Q3", "generation": "1", "ex_version": "1", "ex": "K(Q2)", "pro": "q="})
        doc["structure"]["initial_q"]["0"].append("Q3")
        with self.assertRaisesRegex(CompatibilityError, "DAG"):
            import_v5_structure(signed(doc))

    def test_unreferenced_live_state_is_rejected(self):
        doc = structure()
        doc["structure"]["nodes"].append({"id": "Q3", "generation": "1", "ex_version": "1", "ex": "K(Q2)", "pro": "q="})
        doc["structure"]["initial_q"]["0"].append("Q3")
        with self.assertRaisesRegex(CompatibilityError, "consumer"):
            import_v5_structure(signed(doc))

    def test_runtime_and_modules_are_not_silently_migrated(self):
        for path in (FIXTURES / "runtime-example.json", FIXTURES / "a03-dynamic/04-ack-pair-and-retired-rounds.json"):
            with self.subTest(path=path.name), self.assertRaisesRegex(CompatibilityError, "runtime restore"):
                import_v5_structure(path)
        doc = structure(); doc["structure"]["modules"] = [{"id": "unregistered"}]
        with self.assertRaisesRegex(CompatibilityError, "modules"):
            import_v5_structure(signed(doc))
        self.assertIn("unsupported", SUPPORT_MATRIX["V5.draft-2-a03-ready.runtime"])


if __name__ == "__main__":
    unittest.main()
