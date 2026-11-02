"""Checksummed, synchronized checkpoints and an append-only full-state journal.

The first implementation deliberately journals complete logical checkpoints.
It trades throughput for a simple recoverable causal prefix; it is not a claim
of incremental WAL or concurrent GPU copy-on-write performance.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

from .model import canonical_bytes, digest


class RecoveryError(ValueError):
    pass


def envelope(payload: dict) -> dict:
    return {"format": "jkcuda.checkpoint.v1", "sha256": digest(payload), "payload": payload}


def verify(document: dict) -> dict:
    if not isinstance(document, dict) or set(document) != {"format", "sha256", "payload"}:
        raise RecoveryError("invalid checkpoint envelope")
    if document["format"] != "jkcuda.checkpoint.v1" or digest(document["payload"]) != document["sha256"]:
        raise RecoveryError("checkpoint format or SHA-256 mismatch")
    if not isinstance(document["payload"], dict):
        raise RecoveryError("checkpoint payload must be an object")
    return document["payload"]


def read_checkpoint(path) -> dict:
    try:
        return verify(json.loads(Path(path).read_text(encoding="utf-8")))
    except (OSError, ValueError, TypeError) as exc:
        raise RecoveryError(f"cannot validate checkpoint: {exc}") from exc


def _sync_directory(directory: Path) -> None:
    descriptor = os.open(str(directory), os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def write_checkpoint(path, payload: dict) -> None:
    """Publish only after the complete temp file is synced; sync rename as well."""
    destination = Path(path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    data = canonical_bytes(envelope(payload)) + b"\n"
    descriptor, temporary = tempfile.mkstemp(prefix="." + destination.name + ".", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, destination)
        _sync_directory(destination.parent)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class Journal:
    """Hash chained full-state records. An incomplete final write is discarded.

    A malformed complete record is corruption, never silently skipped. No log
    truncation is performed automatically. Use a new journal after recovery.
    """

    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.sequence = 0
        self.previous = "0" * 64
        self.lock = threading.Lock()
        self.failed = False
        with self.path.open("xb") as handle:
            handle.flush()
            os.fsync(handle.fileno())
        _sync_directory(self.path.parent)

    def append(self, state: dict) -> int:
        with self.lock:
            if self.failed:
                raise OSError("journal has a failed write; recover into a new journal")
            record = {"sequence": self.sequence + 1, "previous": self.previous, "state": state}
            record_hash = digest(record)
            data = canonical_bytes({"record": record, "sha256": record_hash}) + b"\n"
            try:
                with self.path.open("ab") as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
            except OSError:
                self.failed = True
                raise
            self.sequence += 1
            self.previous = record_hash
            return self.sequence

    @staticmethod
    def recover(path) -> dict:
        sequence, previous, latest = 0, "0" * 64, None
        with Path(path).open("rb") as handle:
            for line in handle:
                if not line.endswith(b"\n"):
                    break
                try:
                    item = json.loads(line)
                    if set(item) != {"record", "sha256"}:
                        raise ValueError("invalid journal envelope")
                    record = item["record"]
                    if set(record) != {"sequence", "previous", "state"}:
                        raise ValueError("invalid journal record")
                    if (record["sequence"] != sequence + 1 or record["previous"] != previous
                            or digest(record) != item["sha256"]):
                        raise ValueError("sequence or hash chain mismatch")
                    sequence, previous, latest = record["sequence"], item["sha256"], record["state"]
                except (ValueError, TypeError, KeyError) as exc:
                    raise RecoveryError(f"corrupt complete journal record {sequence + 1}: {exc}") from exc
        if latest is None:
            raise RecoveryError("journal contains no complete recoverable record")
        return latest
