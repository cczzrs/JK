#!/usr/bin/env python3
"""Measure completed FIFO tasks, never isolated arithmetic kernel speed.

Run only after semantic validation. Native CPU is explicitly marked and cannot
produce a CUDA performance claim. Reports synchronized wall time and counters.
"""
import argparse
import json
from pathlib import Path
import platform
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from jkcuda import Runtime


def percentile(samples, percent):
    values = sorted(samples)
    index = (len(values) - 1) * percent
    lower = int(index)
    upper = min(lower + 1, len(values) - 1)
    return values[lower] + (values[upper] - values[lower]) * (index - lower)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", default="cuda")
    parser.add_argument("--model", default=str(ROOT / "examples/cuda/xor.json"))
    parser.add_argument("--input", default='{"X0":1,"X1":0}')
    parser.add_argument("--samples", type=int, default=100)
    parser.add_argument("--warmup", type=int, default=5)
    parser.add_argument("--work-slice", type=int, default=1024)
    parser.add_argument("--output")
    args = parser.parse_args()
    if args.samples <= 0 or args.warmup < 0:
        parser.error("samples must be positive and warmup nonnegative")
    inputs = json.loads(args.input)
    environment = {"platform": platform.platform(), "python": platform.python_version(), "device": args.device}
    if args.device.startswith("cuda"):
        try:
            import torch
        except ImportError:
            print(json.dumps({"status": "skipped", "cuda_verified": False, "reason": "PyTorch unavailable"}))
            return 77
        if not torch.cuda.is_available():
            print(json.dumps({"status": "skipped", "cuda_verified": False, "reason": "NVIDIA CUDA unavailable"}))
            return 77
        environment.update(gpu=torch.cuda.get_device_name(), torch=torch.__version__, cuda=torch.version.cuda)
    input_complete, output_readable, measured, tasks = [], [], 0.0, 0
    with Runtime(args.model, device=args.device, work_slice=args.work_slice) as runtime:
        for sample in range(args.samples + args.warmup):
            before = runtime.status()["completed"]
            start = time.perf_counter()
            ticket = runtime.send(inputs, request_id=f"benchmark:{sample}", key=sample).wait("device_visible")
            input_done = None
            completed_inputs = set()
            while True:
                status = runtime.step()
                if status["reason"]:
                    raise RuntimeError(f"benchmark paused: {status['reason']}; grow explicitly, do not discard work")
                completed_inputs = {r["task"] for r in runtime.trace() if r["kind"] == "complete"}
                if input_done is None and set(ticket.task_ids) <= completed_inputs:
                    input_done = time.perf_counter() - start
                if not status["active_task"] and not status["pending"]:
                    break
            records = runtime.read_output()
            finish = time.perf_counter()
            for record in records:
                runtime.ack_output(record["output_id"])
            if sample >= args.warmup:
                input_complete.append(input_done)
                output_readable.append(finish - start)
                measured += finish - start
                tasks += status["completed"] - before
        final_status = runtime.status()
        metrics = final_status["metrics"]
    report = {"status": "measured", "environment": environment, "samples": args.samples,
              "warmup": args.warmup, "model": str(Path(args.model).resolve()),
              "completed_tasks": tasks, "measured_wall_seconds": measured,
              "completed_tasks_per_second": tasks / measured,
              "input_tasks_complete_seconds": {"p50": percentile(input_complete, .5), "p99": percentile(input_complete, .99)},
              "quiescent_output_readable_seconds": {"p50": percentile(output_readable, .5), "p99": percentile(output_readable, .99)},
              "counters_including_warmup": metrics,
              "physical_counters_including_warmup": final_status.get("physical_metrics", {}),
              "D_over_E": metrics["D"] / metrics["E"] if metrics["E"] else None,
              "D_over_R": metrics["D"] / metrics["R"] if metrics["R"] else None,
              "limitations": ["includes trace inspection and host synchronization overhead",
                              "one synchronous request per sample, not sustained asynchronous I/O",
                              "phase-level GPU timing, memory traffic and variant comparison remain unmeasured"]}
    rendered = json.dumps(report, indent=2)
    print(rendered)
    if args.output:
        Path(args.output).write_text(rendered + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
