#!/usr/bin/env python3
"""Compare complete FIFO execution with serial and cooperative propagation.

This is a synthetic fanout workload, not a JK application performance claim.
Compile/warmup is excluded; admission, bounded advances and synchronous transfer
are included. Both variants must produce exactly the same full logical state.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import platform
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from jkcuda.backend import Core
from jkcuda.model import load_model


def workload(fanout):
    def node(identifier):
        return {"id": identifier, "queue": "work", "ex": "J0K(p)",
                "sources": {"p": {"kind": "PARAM", "param": "p"}},
                "trigger": {"mode": "ANY", "ports": ["p"]},
                "publish": "always" if identifier == "source" else "never"}
    return load_model({"profile": "jkcuda.v6.1", "format_version": 1,
                       "queues": [{"name": "work", "priority": 0}],
                       "nodes": [node("source")] + [node(f"sink:{i}") for i in range(fanout)],
                       "entrypoints": ["source"],
                       "subscriptions": [{"source": "source", "target": f"sink:{i}",
                                          "port": "p", "order": fanout-i} for i in range(fanout)]})


def complete(core, work_slice):
    while True:
        status = core.advance(max_work=work_slice, max_tasks=1000000)
        if status["status"] != "ready":
            raise RuntimeError(f"benchmark stopped: {status['reason']}")
        if status["active_task"] is None and status["pending"] == 0:
            return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", choices=("cuda", "native-cpu"), default="cuda")
    parser.add_argument("--fanout", type=int, default=256)
    parser.add_argument("--events", type=int, default=32)
    parser.add_argument("--propagation-chunk", type=int, default=128)
    parser.add_argument("--block-size", type=int, default=128)
    parser.add_argument("--work-slice", type=int, default=65536)
    parser.add_argument("--output")
    args = parser.parse_args()
    if min(args.fanout, args.events, args.work_slice) < 1:
        parser.error("fanout, events and work-slice must be positive")
    environment = {"device": args.device, "python": platform.python_version(),
                   "platform": platform.platform()}
    if args.device == "cuda":
        if importlib.util.find_spec("torch") is None:
            print(json.dumps({"status": "skipped", "reason": "PyTorch unavailable"}))
            return 77
        import torch
        if not torch.cuda.is_available():
            print(json.dumps({"status": "skipped", "reason": "NVIDIA CUDA unavailable"}))
            return 77
        environment.update(gpu=torch.cuda.get_device_name(), torch=torch.__version__, cuda=torch.version.cuda)
    model = workload(args.fanout)
    requests = [{"node": "source", "params": {"p": i % 2}, "key": i} for i in range(args.events)]
    count = args.events * (args.fanout + 1)
    capacities = {"tasks": count + args.fanout + 8, "events": args.events + 8,
                  "tokens": args.events * args.fanout + 8, "traces": count * 8 + 32}
    results, logical = {}, None
    for variant in ("serial", "parallel"):
        options = dict(device=args.device, propagation=variant,
                       propagation_chunk=args.propagation_chunk, block_size=args.block_size)
        warmup = Core(model, capacities=capacities, **options)
        warmup.enqueue(requests[:1]); complete(warmup, args.work_slice)
        core = Core(model, capacities=capacities, **options)
        started = time.perf_counter()
        core.enqueue(requests)
        status = complete(core, args.work_slice)
        elapsed = time.perf_counter() - started
        current = core.logical_state()
        if logical is not None and current != logical:
            raise AssertionError("serial/parallel logical states differ; no benchmark accepted")
        logical = current
        results[variant] = {"wall_seconds": elapsed, "completed_tasks": status["completed"],
                            "completed_tasks_per_second": status["completed"] / elapsed,
                            "metrics": status["metrics"], "physical_metrics": status["physical_metrics"]}
    report = {"status": "measured", "environment": environment,
              "fanout": args.fanout, "events": args.events,
              "propagation_chunk": args.propagation_chunk, "block_size": args.block_size,
              "logical_states_equal": True, "variants": results,
              "limitations": ["synthetic ANY fanout; not all application workloads",
                              "native-cpu uses a serial emulator of cooperative phases, not GPU performance",
                              "one sample per variant; repeat and compare distributions on the actual GPU",
                              "full arena transfer remains included; phase-level GPU timings unavailable"]}
    rendered = json.dumps(report, indent=2)
    print(rendered)
    if args.output:
        Path(args.output).write_text(rendered + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
