import io
import json
import logging
import os
import socket
import socketserver
from typing import Any

# Seconds a server-side handler waits for a client that connects but never sends
# a full line. Overridable so the tests don't have to wait the full 10 seconds.
SERVER_SOCKET_TIMEOUT = float(os.environ.get("SERVER_SOCKET_TIMEOUT", "10"))


class ProtocolError(ValueError):
    """The peer sent something that is not a single JSON object."""


def setup_logging(component: str) -> logging.Logger:
    os.makedirs("logs", exist_ok=True)

    logger = logging.getLogger(component)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    if logger.handlers:
        return logger

    formatter = logging.Formatter(fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

    console = logging.StreamHandler()
    console.setFormatter(formatter)

    file_handler = logging.FileHandler(
        os.path.join("logs", f"{component}.log"), encoding="utf-8"
    )
    file_handler.setFormatter(formatter)

    logger.addHandler(console)
    logger.addHandler(file_handler)
    return logger


def write_json(wfile: io.BufferedIOBase, message: dict[str, Any]) -> None:
    r"""json.dumps never emits a raw newline, so "\n" safely marks the end of the message."""
    wfile.write((json.dumps(message) + "\n").encode("utf-8"))
    wfile.flush()


def read_json(rfile: io.BufferedIOBase) -> dict[str, Any]:
    """Read one newline-delimited JSON object from a buffered reader.

    Reuse the same rfile for every message on a connection: its buffer holds any
    bytes that were read past the newline, which belong to the next message.
    """
    line = rfile.readline()

    if not line:
        raise ConnectionError("Peer closed the connection before sending a message")

    try:
        message = json.loads(line.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ProtocolError("message is not valid UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise ProtocolError("message is not valid JSON") from exc

    if not isinstance(message, dict):
        raise ProtocolError("expected a JSON object")

    return message


# Remote procedure call: one request and one response over a fresh TCP connection.
def rpc(host: str, port: int, request: dict[str, Any], logger: logging.Logger) -> dict[str, Any]:
    logger.info("Sending to %s:%s -> %s", host, port, request)

    with (
        socket.create_connection((host, port), timeout=5) as sock,
        sock.makefile("rb") as rfile,
        sock.makefile("wb") as wfile,
    ):
        write_json(wfile, request)
        response = read_json(rfile)

    logger.info("Received from %s:%s <- %s", host, port, response)
    return response


class ThreadedTCPServer(socketserver.ThreadingTCPServer):
    """a configured `socketserver.ThreadingTCPServer` class
    
    ThreadingTCPServer runs each connection's handle() in its own thread, so one
    slow request (e.g. the coordinator waiting on another service) doesn't block
    everyone else. It also means handlers run in parallel, hence the locks
    around shared state in the services.
    """
    allow_reuse_address = True  # restart without "address already in use"
    daemon_threads = True  # handler threads don't block Ctrl+C / exit
