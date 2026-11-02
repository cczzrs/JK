#!/usr/bin/env python3
"""Reproduce the V6.1 local evidence and write an auditable JSON report.

This deliberately selects native-cpu for semantic tests. The separate CUDA
availability check must remain skipped on machines without NVIDIA/PyTorch.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]


def run(command, env):
    completed = subprocess.run(command, cwd=ROOT, env=env, text=True, capture_output=True)
    return {"command": command, "exit_code": completed.returncode,
            "stdout": completed.stdout, "stderr": completed.stderr}


def last_json(text):
    decoder = json.JSONDecoder()
    value = None
    remaining = text.lstrip()
    while remaining:
        value, end = decoder.raw_decode(remaining)
        remaining = remaining[end:].lstrip()
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default=str(ROOT / "docs/cuda-validation.json"))
    args = parser.parse_args()
    environment = dict(os.environ, JKCUDA_TEST_DEVICE="native-cpu")
    compiler = shutil.which("clang++") or shutil.which("g++")
    checks = {}
    checks["unittest"] = run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-q"], environment)
    match = re.search(r"Ran (\d+) tests?", checks["unittest"]["stderr"])
    checks["unittest"]["tests_run"] = int(match.group(1)) if match else None
    if compiler:
        checks["cpp_strict"] = run([compiler, "-std=c++17", "-Wall", "-Wextra", "-Wpedantic",
                                    "-Werror", "-fsyntax-only", "jkcuda/native/cpu.cpp"], environment)
    else:
        checks["cpp_strict"] = {"exit_code": 77, "status": "skipped", "reason": "C++ compiler unavailable"}
    checks["native_differential"] = run([sys.executable, "scripts/validate_cuda.py", "--device", "native-cpu", "--modules"], environment)
    if checks["native_differential"]["exit_code"] == 0:
        checks["native_differential"]["summary"] = last_json(checks["native_differential"].pop("stdout"))
    checks["propagation_harness_smoke"] = run(
        [sys.executable, "scripts/benchmark_propagation.py", "--device", "native-cpu",
         "--fanout", "129", "--events", "3", "--propagation-chunk", "33", "--block-size", "64"], environment)
    if checks["propagation_harness_smoke"]["exit_code"] == 0:
        checks["propagation_harness_smoke"]["summary"] = last_json(checks["propagation_harness_smoke"].pop("stdout"))
    checks["cuda"] = run([sys.executable, "scripts/validate_cuda.py", "--device", "cuda", "--modules"], environment)
    try:
        checks["cuda"]["summary"] = last_json(checks["cuda"].pop("stdout"))
    except (ValueError, KeyError):
        pass
    paths = sorted([*ROOT.glob("jkcuda/*.py"), *ROOT.glob("jkcuda/native/*"),
                    *ROOT.glob("tests/*.py"), *ROOT.glob("scripts/*.py"),
                    *ROOT.glob("examples/cuda/*.json"), ROOT / "pyproject.toml"])
    report = {"verified_at_utc": datetime.now(timezone.utc).isoformat(),
              "environment": {"python": platform.python_version(), "platform": platform.platform(), "compiler": compiler},
              "checks": checks,
              "cuda_verified": checks["cuda"].get("summary", {}).get("cuda_verified", False),
              "compute_sanitizer_verified": False, "gpu_performance_measured": False,
              "limitations": ["native success does not prove GPU compilation, memory ordering or performance",
                              "V5 full runtime recovery and 75-task continuation are not implemented",
                              "cooperative CUDA propagation has only native phase-emulation evidence locally",
                              "JIT, physical GC, multi-block propagation and asynchronous arena transfer remain incomplete"],
              "source_sha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths if path.is_file()}}
    destination = Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    summary = {"report": str(destination), "tests_run": checks["unittest"]["tests_run"],
               "checks": {name: value["exit_code"] for name, value in checks.items()},
               "cuda_verified": report["cuda_verified"]}
    print(json.dumps(summary, indent=2))
    return 0 if (all(checks[name]["exit_code"] == 0 for name in
                    ("unittest", "cpp_strict", "native_differential", "propagation_harness_smoke"))
                 and checks["cuda"]["exit_code"] in (0, 77)) else 1


if __name__ == "__main__":
    raise SystemExit(main())
