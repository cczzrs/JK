#!/usr/bin/env python3
"""Serve the local design and its linked draft, without build dependencies."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="启动 JK 异步结构存储本地页面")
    parser.add_argument("--port", type=int, default=8765, help="本地端口；0 为自动选择（默认 8765）")
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    handler = partial(SimpleHTTPRequestHandler, directory=str(root))
    with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
        print(f"http://127.0.0.1:{server.server_port}/web/async-structural-storage/", flush=True)
        print("按 Ctrl+C 停止。仅在本机提供访问。", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
