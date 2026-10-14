"""Launch a coordinator and three actual participant processes and save evidence."""

import argparse
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def free_local_port():
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def wait_for_broker(process, port, seconds=7):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError("Broker terminated during startup")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                return
        except OSError:
            time.sleep(0.05)
    raise TimeoutError("Broker did not start")


def wait_for_ready(path, process, seconds=7):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.exists():
            return
        if process.poll() is not None:
            raise RuntimeError(f"{process.args} exited before subscribing")
        time.sleep(0.05)
    raise TimeoutError(f"No readiness signal from {path}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", default=str(ROOT / "evidence" / "demo_run"))
    args = parser.parse_args()
    target = Path(args.output_dir).resolve()
    if target == ROOT or target == ROOT.parent:
        raise ValueError("Output directory cannot be the project root")
    target.mkdir(parents=True, exist_ok=True)
    # Only remove demo-generated files; do not delete unrelated user files.
    for pattern in ("*.ready", "*.log", "*.console.txt", "demo_transcript.txt"):
        for generated in target.glob(pattern):
            if generated.is_file():
                generated.unlink()
    port = free_local_port()
    processes = []
    handles = []

    def launch(label, script, extra):
        out_path = target / f"{label}.console.txt"
        handle = out_path.open("w", encoding="utf-8")
        handles.append(handle)
        proc = subprocess.Popen([sys.executable, str(ROOT / script), *extra],
                                cwd=ROOT, stdout=handle, stderr=subprocess.STDOUT)
        processes.append(proc)
        return proc

    try:
        broker = launch("server", "server.py", ["--host", "127.0.0.1", "--port", str(port),
                                                  "--log-dir", str(target), "--trace-marshalling"])
        wait_for_broker(broker, port)
        subscribers = []
        for name in ("bob", "charlie"):
            ready = target / f"{name}.ready"
            proc = launch(name, "demo_node.py", ["--name", name, "--role", "subscriber",
                                                       "--host", "127.0.0.1", "--port", str(port),
                                                       "--log-dir", str(target), "--ready-file", str(ready)])
            wait_for_ready(ready, proc)
            subscribers.append(proc)
        publisher = launch("alice", "demo_node.py", ["--name", "alice", "--role", "publisher",
                                                       "--host", "127.0.0.1", "--port", str(port),
                                                       "--log-dir", str(target)])
        for proc in [publisher, *subscribers]:
            if proc.wait(timeout=12) != 0:
                raise RuntimeError(f"A participant failed: {proc.args}")
        for name in ("alice", "bob", "charlie"):
            content = (target / f"{name}.console.txt").read_text(encoding="utf-8")
            if "RESULT: PASS" not in content:
                raise RuntimeError(f"Missing PASS marker in {name}")
        print("PASS: request/reply, two subscriber deliveries, and group deliveries")
    finally:
        for proc in processes:
            if proc.poll() is None:
                proc.terminate()
        for proc in processes:
            try:
                proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        for handle in handles:
            handle.close()
        transcript = target / "demo_transcript.txt"
        with transcript.open("w", encoding="utf-8") as summary:
            summary.write("CECS 327 Milestone 2 - actual process output (UTC timestamps)\n")
            for name in ("server", "bob", "charlie", "alice"):
                log = target / f"{name}.console.txt"
                summary.write(f"\n{'=' * 25} {name.upper()} {'=' * 25}\n")
                if log.exists():
                    for line in log.read_text(encoding="utf-8").splitlines():
                        if ("JOIN_REPLY:" in line or "SUBSCRIBE_REPLY:" in line or
                            "REQUEST_REPLY:" in line or "PUBLISH_REPLY:" in line or
                            "GROUP_SEND_REPLY:" in line or "PUBSUB_RECEIVED:" in line or
                            "GROUP_RECEIVED:" in line or "RESULT: PASS" in line or
                            "MARSHAL object=" in line or "UNMARSHAL wire_bytes=" in line or
                            "PUBLISH meeting=" in line or "GROUP_SEND meeting=" in line):
                            summary.write(line + "\n")
        print("Evidence:", transcript)


if __name__ == "__main__":
    main()
