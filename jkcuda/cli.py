"""Small reproducible CLI. Native CPU execution must be selected explicitly."""
import argparse
import json
from pathlib import Path

from .model import load_model, structure_fingerprint
from .runtime import Runtime


def main(argv=None):
    parser = argparse.ArgumentParser(prog="jkcuda")
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate", help="validate an explicit V6.1 structure")
    validate.add_argument("model")
    run = commands.add_parser("run", help="execute FIFO tasks with the selected backend")
    run.add_argument("model")
    run.add_argument("--device", default="cuda")
    run.add_argument("--send", action="append", default=[], metavar='JSON')
    run.add_argument("--max-tasks", type=int, default=100000)
    run.add_argument("--work-slice", type=int, default=1024)
    run.add_argument("--snapshot")
    run.add_argument("--wal")
    run.add_argument("--trace")
    restore = commands.add_parser("restore", help="validate and restore paused; --run is explicit")
    restore.add_argument("checkpoint")
    restore.add_argument("--device", default="cuda")
    restore.add_argument("--journal", action="store_true")
    restore.add_argument("--run", type=int, default=0, metavar="MAX_TASKS")
    serve = commands.add_parser("serve", help="open a live loopback web console for a real Runtime")
    serve.add_argument("model")
    serve.add_argument("--device", default="cuda")
    serve.add_argument("--host", default="127.0.0.1", choices=("127.0.0.1", "localhost"))
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--work-slice", type=int, default=1024)
    serve.add_argument("--propagation", choices=("serial", "parallel"), default="parallel")
    serve.add_argument("--wal")
    arguments = parser.parse_args(argv)
    if arguments.command == "validate":
        model = load_model(arguments.model)
        print(json.dumps({"valid": True, "profile": model["profile"],
                          "structure_fingerprint": structure_fingerprint(model)}, indent=2))
        return 0
    if arguments.command == "serve":
        from .webserver import create_server
        with Runtime(arguments.model, device=arguments.device, work_slice=arguments.work_slice,
                     propagation=arguments.propagation, durable_path=arguments.wal) as runtime:
            server = create_server(runtime, host=arguments.host, port=arguments.port)
            print(f"JK live console: http://{arguments.host}:{server.server_port}  backend={arguments.device}", flush=True)
            try:
                server.serve_forever(poll_interval=0.2)
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
        return 0
    if arguments.command == "run":
        runtime = Runtime(arguments.model, device=arguments.device,
                          durable_path=arguments.wal, work_slice=arguments.work_slice)
    else:
        runtime = Runtime.restore_runtime(arguments.checkpoint, device=arguments.device, journal=arguments.journal)
    with runtime:
        if arguments.command == "run":
            for index, values in enumerate(arguments.send):
                runtime.send(json.loads(values), request_id=f"cli:{index}").wait("device_visible")
            status = runtime.run(arguments.max_tasks)
            if arguments.snapshot:
                runtime.snapshot(arguments.snapshot, active=bool(status["active_task"]))
            if arguments.trace:
                Path(arguments.trace).write_text(json.dumps(runtime.trace(), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        else:
            status = runtime.run(arguments.run) if arguments.run else runtime.status()
        print(json.dumps({"status": status, "outputs": runtime.read_output()}, ensure_ascii=False, indent=2))
        return 2 if status.get("reason") else 0


if __name__ == "__main__":
    raise SystemExit(main())
