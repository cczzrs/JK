#!/usr/bin/env python3
"""Run the independent full-trace corpus on the selected production backend.

Examples (from the repository root):
    python3 scripts/validate_cuda.py --device native-cpu
    python3 scripts/validate_cuda.py --device cuda
    python3 scripts/validate_cuda.py --print-sanitizer-commands

Missing CUDA exits 77 (explicit skip), unless --allow-skip was requested. A CPU
success cannot be presented as CUDA compilation or memory-ordering validation.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import shlex
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cuda", "native-cpu"), default="cuda")
    parser.add_argument("--allow-skip", action="store_true")
    parser.add_argument("--work-bounds", default="1,7,10000")
    parser.add_argument("--propagation", choices=("serial", "parallel", "both"), default="both")
    parser.add_argument("--propagation-chunk", type=int, default=128)
    parser.add_argument("--block-size", type=int, default=128)
    parser.add_argument("--case", help="run only case names containing this string")
    parser.add_argument("--modules", action="store_true",
                        help="also run propagation, business, dynamic structure and frame/ACK suites")
    parser.add_argument("--print-sanitizer-commands", action="store_true")
    args = parser.parse_args()
    if args.print_sanitizer_commands:
        command = shlex.join([sys.executable, str(Path(__file__).resolve()), "--device", "cuda", "--modules"])
        for check in ("memcheck", "initcheck", "synccheck", "racecheck"):
            print("compute-sanitizer --error-exitcode=1 --tool " + check + " " + command)
        return 0
    work_bounds = [int(value) for value in args.work_bounds.split(",")]
    if not work_bounds or any(value <= 0 for value in work_bounds):
        parser.error("--work-bounds must contain positive integers")
    environment = {"python": platform.python_version(), "platform": platform.platform(),
                   "device": args.device, "work_bounds": work_bounds,
                   "propagation": args.propagation, "propagation_chunk": args.propagation_chunk,
                   "block_size": args.block_size}
    if args.device == "cuda":
        reason = None
        if importlib.util.find_spec("torch") is None:
            reason = "PyTorch is not installed"
        else:
            import torch
            environment.update({"torch": torch.__version__, "cuda": torch.version.cuda})
            if not torch.cuda.is_available():
                reason = "PyTorch has no available NVIDIA CUDA device"
            else:
                environment["gpu"] = torch.cuda.get_device_name(torch.cuda.current_device())
        if reason is not None:
            print(json.dumps({"status": "skipped", "reason": reason,
                              "environment": environment, "cuda_verified": False}, indent=2))
            return 0 if args.allow_skip else 77
    from jkcuda.backend import Core
    from jkcuda.reference import Reference
    from tests.test_differential import execute_core, semantic_cases
    cases = [case for case in semantic_cases() if args.case is None or args.case in case[0]]
    if not cases:
        parser.error("no matching case")
    started = time.perf_counter()
    completed_runs, completed_tasks, compared_records = 0, 0, 0
    for name, model, requests in cases:
        reference = Reference(model)
        reference.enqueue(requests)
        reference.run()
        variants = ("serial", "parallel") if args.propagation == "both" else (args.propagation,)
        for variant in variants:
            for work in work_bounds:
                core = Core(model, device=args.device, propagation=variant,
                            propagation_chunk=args.propagation_chunk, block_size=args.block_size)
                core.enqueue(requests)
                execute_core(core, reference.trace, max_work=work, max_tasks=1 if work < 10000 else 10000)
                completed_runs += 1
                completed_tasks += reference.completed
                compared_records += len(reference.trace)
                print(json.dumps({"case": name, "propagation": variant,
                                  "work_bound": work, "status": "passed"}), flush=True)
    module_report = None
    if args.modules:
        os.environ["JKCUDA_TEST_DEVICE"] = args.device
        suite = unittest.defaultTestLoader.loadTestsFromNames(
            ["tests.test_dynamic", "tests.test_frames_semantics",
             "tests.test_parallel_propagation", "tests.test_business", "tests.test_business_audit"])
        result = unittest.TextTestRunner(verbosity=1).run(suite)
        module_report = {"device": args.device, "tests": result.testsRun,
                         "failures": len(result.failures), "errors": len(result.errors),
                         "skipped": len(result.skipped), "passed": result.wasSuccessful() and not result.skipped}
    passed = module_report is None or module_report["passed"]
    report = {"status": "passed" if passed else "failed", "environment": environment, "cases": len(cases),
              "runs": completed_runs, "completed_tasks": completed_tasks,
              "compared_trace_records": compared_records,
              "validation_wall_seconds": time.perf_counter() - started,
              "cuda_verified": args.device == "cuda" and passed,
              "sanitizer_verified": False,
              "module_tests": module_report,
              "coverage": "enqueue/select/bind/commit/event/delivery/match/output/complete ordered traces",
              "limitations": ["validation wall time is not an end-to-end performance benchmark",
                              "native-cpu emulates cooperative phases but does not exercise CUDA synchronization",
                              "Compute Sanitizer results must be collected by separate runs"]}
    print(json.dumps(report, indent=2))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
