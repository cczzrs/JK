#!/usr/bin/env python3
"""JKRD7 static checks (JKRD7.md §11.1).

Checks every JSON block in JKRD7.md, the ASCII model asset, a set of negative
and positive fixtures for the §2/§3/§5/§6.2/§8 rules, the JSON syntax of the
pending factory attachments, local Markdown links and jk.config.json paths.
It does not execute models; see jk_reference.py.

    python3 scripts/validate_jkrd7.py [--write-report]
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from jk_model import Model, check_jki, check_run_script, check_snapshot  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DOC = ROOT / "JKRD7.md"
CONFIG = ROOT / "jk.config.json"
REPORT = ROOT / "reports/static-validation.json"
DOC_MODELS = ("M1", "M_FLOW", "M_PATH", "M_SYNC", "M_TX", "M_NEST", "M_REG")
MODEL_ASSETS = ("assets/ascii-bit-design/digits.jkm.json",)
PENDING_ASSETS = ("assets/jks-factory-v7-design/JKI.FACTORY.json",
                  "assets/jks-factory-v7-design/RAM.FACTORY.json",
                  "assets/jks-factory-v7-design/design-contract.json",
                  "assets/jks-factory-v7-design/generation-example.json")
MARKDOWN = ("README.md", "JKRD7.md", "AGENTS.md", "docs/*.md", "docs/modules/*.md")


def jkm(*roots):
    return {"jkm": "FIX", "version": "7.0.0", "queues": ["work"], "roots": list(roots)}


def jks(jks_id, members, trigger):
    return {"id": jks_id, "members": members, "trigger": trigger, "queue": "work", "pro": {}, "runtime": {}}


def base():
    """A valid model: G1 inputs; G2 with transaction prereq Q1 and range Q2, Q3, G2.G1.Q1."""
    return jkm(
        jks("G1", [{"id": "Q1", "q": 1, "trigger": {"any": []}},
                     {"id": "Q2", "q": 1, "trigger": {"any": []}}], {"any": ["Q1", "Q2"]}),
        jks("G2", [
            {"id": "Q1", "q": 0, "trigger": {"any": ["G1.Q1"]}},
            {"id": "Q2", "q": 0, "trigger": {"any": ["Q1"]}, "sources": {"seed": 0, "s": ["Q1"], "ex": ["K"]}},
            {"id": "Q3", "q": 0, "trigger": {"all": ["Q1", "Q2"]}, "runtime": {"trigger_all": [None, None]}},
            jks("G1", [{"id": "Q1", "q": 0, "trigger": {"any": ["G2.Q2"]}}], {"any": ["Q1"]}),
        ], {"transaction": ["Q1"]}),
    )


def node(model, *path):
    """The object at root id / member ids."""
    obj = next(r for r in model["roots"] if r["id"] == path[0])
    for part in path[1:]:
        obj = next(m for m in obj["members"] if m.get("id") == part)
    return obj


def mutate(fn):
    def build():
        model = base()
        fn(model)
        return model
    return build


def _set(obj, **fields):
    obj.update(fields)


def _drop(obj, key):
    obj.pop(key)


# (name, builder, expected error fragment)
NEGATIVE = [
    ("seed 为 null", mutate(lambda m: node(m, "G2", "Q2")["sources"].update(seed=None)), "sources.seed 只能是 0 或 1"),
    ("q 为字符串", mutate(lambda m: _set(node(m, "G2", "Q1"), q="1")), "q 必须是整数 0 或 1"),
    ("q 为布尔值", mutate(lambda m: _set(node(m, "G2", "Q1"), q=True)), "q 必须是整数 0 或 1"),
    ("未批准的 JKI 字段", mutate(lambda m: _set(node(m, "G2", "Q1"), state=0)), "未批准的 JKI 字段"),
    ("trigger 同时有 any 和 all",
     mutate(lambda m: _set(node(m, "G2", "Q1"), trigger={"any": ["G1.Q1"], "all": ["G1.Q2"]})),
     "trigger 必须恰好有 any 或 all"),
    ("trigger.all 为空", mutate(lambda m: _set(node(m, "G2", "Q3"), trigger={"all": []}, runtime={"trigger_all": []})),
     "trigger.all 不得为空"),
    ("ex 与 s 不等长", mutate(lambda m: node(m, "G2", "Q2")["sources"].update(ex=["K", "J"])), "必须与 s 等长"),
    ("publish 集合错误", mutate(lambda m: _set(node(m, "G2", "Q2"), publish={"always": [1, 0]})), "publish 必须是七种模式之一"),
    ("publish 未知模式", mutate(lambda m: _set(node(m, "G2", "Q2"), publish={"rising": [1]})), "publish 必须是七种模式之一"),
    ("all 节点缺少记录", mutate(lambda m: _drop(node(m, "G2", "Q3"), "runtime")), "all 节点必须保留"),
    ("all 记录长度不符", mutate(lambda m: _set(node(m, "G2", "Q3"), runtime={"trigger_all": [None]})), "all 节点必须保留"),
    ("any 节点保存记录", mutate(lambda m: _set(node(m, "G2", "Q2"), runtime={"trigger_all": [None]})),
     "any 节点不保存 trigger_all"),
    ("pro 未批准字段", mutate(lambda m: _set(node(m, "G2", "Q2"), pro={"atomic": True})), "pro 含未批准字段"),
    ("id 不是 Q＋数字", mutate(lambda m: _set(node(m, "G2", "Q2"), id="B1")), "id 必须是 Q＋正整数"),
    ("JKS id 是 Q＋数字", mutate(lambda m: _set(node(m, "G2", "G1"), id="Q9")), "JKS id 必须是 G＋正整数"),
    ("JKS id 带名称", mutate(lambda m: _set(node(m, "G2"), id="G_TX")), "JKS id 必须是 G＋正整数"),
    ("JKS 缺字段", mutate(lambda m: _drop(node(m, "G2", "G1"), "runtime")), "JKS 必须恰好有六个字段"),
    ("JKS.pro 未批准字段", mutate(lambda m: _set(node(m, "G2"), pro={"atomic": True})), "JKS.pro 含未批准字段"),
    ("JKS.pro.tag 非字符串", mutate(lambda m: _set(node(m, "G2"), pro={"tag": [1]})), "JKS.pro.tag 必须是非空字符串"),
    ("JKS.runtime 非空", mutate(lambda m: _set(node(m, "G2"), runtime={"pending": []})), "JKS.runtime 内部格式未定义"),
    ("queue 未声明", mutate(lambda m: _set(node(m, "G2"), queue="fast")), "queue 必须是 JKM.queues 中声明的名称"),
    ("JKM 版本错误", mutate(lambda m: m.update(version="6.0.0")), "version 必须是"),
    ("JKM 多出字段", mutate(lambda m: m.update(runtime={})), "JKM 字段必须恰好"),
    ("queues 重复", mutate(lambda m: m.update(queues=["work", "work"])), "queues 必须是非空、无重复"),
    ("members 写成 ID", mutate(lambda m: node(m, "G2")["members"].append("Q9")), "成员必须是完整对象"),
    ("同层 id 重复",
     mutate(lambda m: node(m, "G2")["members"].append({"id": "Q2", "q": 0, "trigger": {"any": ["Q1"]}})),
     "同层成员 id 重复"),
    ("根 id 重复", mutate(lambda m: m["roots"].append(jks("G1", [{"id": "Q1", "q": 1, "trigger": {"any": []}}], {"any": ["Q1"]}))),
     "根 id 重复"),
    ("短 ID 跨层", mutate(lambda m: _set(node(m, "G2", "G1", "Q1"), trigger={"any": ["Q2"]})), "短 ID Q2 不是"),
    ("引用落到 JKS", mutate(lambda m: _set(node(m, "G2", "Q2"), trigger={"any": ["G2.G1"]})), "落到 JKS"),
    ("引用不存在", mutate(lambda m: node(m, "G2", "Q2")["sources"].update(s=["G2.Q7"])), "绝对路径 G2.Q7 不存在"),
    ("trigger 短 ID 与路径重复", mutate(lambda m: _set(node(m, "G2", "Q2"), trigger={"any": ["Q1", "G2.Q1"]})), "属于重复"),
    ("未定义的登记类型", mutate(lambda m: _set(node(m, "G2"), trigger={"transaction": ["Q1"], "sync": ["Q2"]})),
     "未定义的登记类型"),
    ("登记为空数组", mutate(lambda m: _set(node(m, "G2"), trigger={"transaction": ["Q1"], "all": []})),
     "必须是非空的前置 ID 数组"),
    ("登记外部节点", mutate(lambda m: _set(node(m, "G2"), trigger={"transaction": ["G1.Q1"]})), "不是本结构的成员 JKI"),
    ("跨类型重复登记", mutate(lambda m: _set(node(m, "G2"), trigger={"transaction": ["Q1"], "all": ["G2.Q1"]})), "重复登记"),
    ("同一 JKI 被两个 JKS 登记",
     mutate(lambda m: _set(node(m, "G2"), trigger={"transaction": ["Q1"], "all": ["G2.G1.Q1"]})), "暂不支持"),
    ("未登记节点写空 any", mutate(lambda m: _set(node(m, "G2", "Q2"), trigger={"any": []})), "只允许用于已登记的输入入口"),
    ("事务范围被外部触发", mutate(lambda m: _set(node(m, "G2", "Q2"), trigger={"any": ["G1.Q2"]})),
     "外部上游只能接到前置成员上"),
    ("事务范围成环", mutate(lambda m: _set(node(m, "G2", "Q2"), trigger={"any": ["Q1", "Q3"]})), "成环"),
    ("定义中 trigger_all 非 null", mutate(lambda m: _set(node(m, "G2", "Q3"), runtime={"trigger_all": [0, None]})),
     "定义中的 runtime.trigger_all 必须全为 null"),
    ("pro.jksid 不存在", mutate(lambda m: _set(node(m, "G2", "Q2"), pro={"jksid": "G9"})), "pro.jksid 必须是实际 JKS 的绝对路径"),
    ("pro.jksid 指向 JKI", mutate(lambda m: _set(node(m, "G2", "Q2"), pro={"jksid": "G2.Q1"})), "pro.jksid 必须是实际 JKS 的绝对路径"),
    ("纯通知环", mutate(lambda m: node(m, "G1")["members"].extend([
        {"id": "Q3", "q": 1, "trigger": {"any": ["Q1", "Q4"]}},
        {"id": "Q4", "q": 0, "trigger": {"any": ["Q3"]}, "publish": {"zero": [0]}}])), "纯通知环"),
]


def loop_model():
    return jkm(jks("G1", [
        {"id": "Q1", "q": 1, "trigger": {"any": []}},
        {"id": "Q2", "q": 0, "trigger": {"any": ["Q1", "Q3"]}, "sources": {"s": ["Q3"], "ex": ["K"]}},
        {"id": "Q3", "q": 0, "trigger": {"any": ["Q2"]}, "sources": {"seed": 1, "s": ["Q2"], "ex": ["K"]}},
    ], {"any": ["Q1"]}))


def nested_prereq_model():
    return jkm(jks("G1", [
        jks("G1", [{"id": "Q1", "q": 1, "trigger": {"any": []}}], {}),
        {"id": "Q1", "q": 0, "trigger": {"any": ["G1.G1.Q1"]}},
    ], {"all": ["G1.G1.Q1"]}))


def quiet_loop_model():
    """An empty-EX loop that cannot run forever: one node never publishes."""
    model = base()
    node(model, "G1")["members"].extend([
        {"id": "Q3", "q": 1, "trigger": {"any": ["Q1", "Q4"]}},
        {"id": "Q4", "q": 1, "trigger": {"any": ["Q3"]}, "publish": {"zero": [0]}}])
    return model


def explicit_empty_model():
    model = base()
    node(model, "G2", "Q2")["pro"] = {"jksid": "G2.G1"}
    node(model, "G2", "Q1").update(sources={}, publish={}, pro={})
    node(model, "G2")["trigger"] = {"transaction": ["Q1"], "ack": ["Q3"]}
    node(model, "G2")["pro"] = {"tag": ["tx"]}
    node(model, "G1")["pro"] = {"tag": []}
    return model


POSITIVE = [
    ("基准模型", base),
    ("事务范围以外成环", loop_model),
    ("前置为嵌套成员（绝对路径）", nested_prereq_model),
    ("显式空对象、ack 登记、JKS.pro.tag 与 pro.jksid", explicit_empty_model),
    ("会停下的空 EX 环", quiet_loop_model),
]


class Checker:
    def __init__(self):
        self.errors = []
        self.items = []
        self.files = {DOC, CONFIG}

    def record(self, name, problems):
        self.items.append({"check": name, "passed": not problems})
        self.errors.extend(f"{name}: {p}" for p in problems)

    def doc_blocks(self):
        blocks = re.findall(r"```json\n(.*?)```", DOC.read_text(encoding="utf-8"), re.S)
        parsed = []
        for i, block in enumerate(blocks, 1):
            try:
                parsed.append(json.loads(block))
            except json.JSONDecodeError as exc:
                self.record(f"JKRD7 JSON 块 {i}", [f"无法解析：{exc}"])
        models = {d["jkm"]: d for d in parsed if isinstance(d, dict) and "roots" in d and "jkm" in d}
        for i, data in enumerate(parsed, 1):
            problems = []
            if isinstance(data, dict) and "snapshot" in data:
                name = f"JKRD7 快照 {data.get('snapshot')}"
                base_model = models.get(data.get("jkm"))
                problems = (check_snapshot(data, Model(base_model, data["jkm"])) if base_model
                            else [f"快照对应的模型 {data.get('jkm')} 不在正文中"])
            elif isinstance(data, dict) and "run" in data:
                name = f"JKRD7 运行脚本 {data.get('run')}"
                path = ROOT / str(data.get("model"))
                if path.exists():
                    self.files.add(path)
                    problems = check_run_script(data, Model(json.loads(path.read_text(encoding="utf-8")), str(path)))
                else:
                    problems = [f"模型文件 {data.get('model')} 不存在"]
            elif isinstance(data, dict) and "jkm" in data:
                name = f"JKRD7 模型 {data['jkm']}"
                problems = Model(data, data["jkm"]).errors
            elif isinstance(data, dict) and "members" not in data:
                name = f"JKRD7 JKI 片段 {data.get('id')}"
                check_jki(data, f"片段 {data.get('id')}", problems)
            else:
                name = f"JKRD7 JSON 块 {i}"
                problems = ["正文 JSON 块只能是 JKM、JKI 片段、运行脚本或快照"]
            self.record(name, problems)
        self.record("JKRD7 第 10 节模型齐全", [f"缺少 {m}" for m in DOC_MODELS if m not in models])

    def assets(self):
        for rel in MODEL_ASSETS:
            path = ROOT / rel
            self.files.add(path)
            self.record(f"模型附件 {rel}", Model(json.loads(path.read_text(encoding="utf-8")), rel).errors)
        for rel in PENDING_ASSETS:
            path = ROOT / rel
            self.files.add(path)
            try:
                json.loads(path.read_text(encoding="utf-8"))
                problems = []
            except (OSError, json.JSONDecodeError) as exc:
                problems = [str(exc)]
            self.record(f"待适配附件 JSON 语法 {rel}", problems)

    def fixtures(self):
        for name, build in POSITIVE:
            self.record(f"正例：{name}", Model(build(), name).errors)
        for name, build, fragment in NEGATIVE:
            errors = Model(build(), name).errors
            ok = any(fragment in e for e in errors)
            self.record(f"负例：{name}", [] if ok else [f"预期包含“{fragment}”的错误，实际 {errors}"])

    def links(self):
        problems = []
        for pattern in MARKDOWN:
            for md in sorted(ROOT.glob(pattern)):
                self.files.add(md)
                for target in re.findall(r"\]\(([^)\s]+)\)", md.read_text(encoding="utf-8")):
                    if re.match(r"[a-z]+:", target) or target.startswith("#"):
                        continue
                    local = re.sub(r"(#.*|:\d+)$", "", target)
                    if not (md.parent / local).exists():
                        problems.append(f"{md.relative_to(ROOT)} → {target}")
        self.record("本地链接", problems)

    def config(self):
        data = json.loads(CONFIG.read_text(encoding="utf-8"))
        problems = []

        def walk(value):
            if isinstance(value, dict):
                for v in value.values():
                    walk(v)
            elif isinstance(value, str) and re.search(r"\.(md|json|py)$", value) and not (ROOT / value).exists():
                problems.append(value)

        walk(data)
        if data.get("canonical", {}).get("rules_version") != "7.0.0":
            problems.append("rules_version 不是 7.0.0")
        self.record("jk.config.json 索引", problems)

    def run(self):
        self.doc_blocks()
        self.assets()
        self.fixtures()
        self.links()
        self.config()
        return self.errors


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write-report", action="store_true")
    args = parser.parse_args()
    checker = Checker()
    errors = checker.run()
    passed = sum(1 for item in checker.items if item["passed"])
    for e in errors:
        print("错误", e)
    print(f"{passed}/{len(checker.items)} 项静态检查通过（负例 {len(NEGATIVE)} 个，正例 {len(POSITIVE)} 个）")
    if args.write_report:
        files = sorted(checker.files | {Path(__file__).resolve(), ROOT / "scripts/jk_model.py"})
        report = {
            "status": "passed" if not errors else "failed",
            "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "scope": "JKRD7 §2/§3/§5/§6.2/§8 static rules, document JSON, model asset, fixtures, links and index; "
                     "no execution (see reports/reference-run.json)",
            "checks": checker.items,
            "errors": errors,
            "sha256": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
        }
        REPORT.parent.mkdir(exist_ok=True)
        REPORT.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"报告已写入 {REPORT.relative_to(ROOT)}")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
