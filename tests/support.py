"""Helpers for starting the real services and talking to them in tests."""

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

PORTS = {"coordinator": 5000, "session_service": 5001, "messaging_service": 5002}

# Services started by the tests use a short server timeout (see SERVER_SOCKET_TIMEOUT in common.py).
TEST_SERVER_TIMEOUT = 1.0


def port_in_use(port: int) -> bool:
    with socket.socket() as sock:
        # connect_ex returns an error code instead of raising an exception.
        # 0 means the connection succeeded, i.e. something is listening (port in use).
        # A local listener answers in ~1 ms; the short timeout avoids Windows' ~2 s
        # of retries when nothing is listening.
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_for_port(port: int, timeout: float = 10) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if port_in_use(port):
            return
        time.sleep(0.05)
    raise RuntimeError(f"Nothing started listening on port {port}")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        # getsockname returns ("127.0.0.1", free_port_num: int)
        return sock.getsockname()[1]


class Services:
    """Runs some of the services as subprocesses.

    Each process runs in a temporary working directory, so the test runs write
    their logs there instead of into the project's logs/ folder.
    """

    def __init__(self, *names: str) -> None:
        self.names = names
        self.procs: dict[str, subprocess.Popen] = {}
        self.workdir = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)

    def start(self) -> "Services":
        busy = [name for name, port in PORTS.items() if port_in_use(port)]
        if busy:
            raise RuntimeError(
                f"Ports already in use by {busy}. Stop any running services before testing."
            )

        for name in self.names:
            self.procs[name] = subprocess.Popen(
                [sys.executable, str(ROOT / f"{name}.py")],
                cwd=self.workdir.name,
                env={**os.environ, "SERVER_SOCKET_TIMEOUT": str(TEST_SERVER_TIMEOUT)},
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        for name in self.names:
            wait_for_port(PORTS[name])
        return self

    def stop(self) -> None:
        for proc in self.procs.values():
            proc.terminate()
        for proc in self.procs.values():
            proc.wait()
        self.workdir.cleanup()

    def log(self, name: str) -> str:
        """Contents of one service's log file from this test run."""
        path = Path(self.workdir.name) / "logs" / f"{name}.log"
        return path.read_text(encoding="utf-8") if path.exists() else ""


def send_raw(payload: bytes, port: int = PORTS["coordinator"], timeout: float = 15) -> dict[str, Any]:
    """Send raw bytes to a service and return its one-line JSON reply."""
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as sock:
        if payload:
            sock.sendall(payload)
        with sock.makefile("rb") as rfile:
            line = rfile.readline()
    if not line:
        raise AssertionError("Service closed the connection without replying")
    return json.loads(line)


def join(user: str, meeting_id: str) -> dict[str, Any]:
    message = {"type": "JOIN_MEETING", "meeting_id": meeting_id, "user": user}
    return send_raw((json.dumps(message) + "\n").encode("utf-8"))


def run_client(*args: str, cwd: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(ROOT / "client.py"), *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        timeout=30,
        check=False,  # tests inspect the exit code themselves
    )
