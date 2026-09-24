import json
import logging
import os
import socket
from typing import Any, Dict


def setup_logging(component: str) -> logging.Logger:
    os.makedirs("logs", exist_ok=True)

    logger = logging.getLogger(component)
    logger.setLevel(logging.INFO)
    logger.propagate = False

    if logger.handlers:
        return logger

    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    console = logging.StreamHandler()
    console.setFormatter(formatter)

    file_handler = logging.FileHandler(
        os.path.join("logs", f"{component}.log"), encoding="utf-8"
    )
    file_handler.setFormatter(formatter)

    logger.addHandler(console)
    logger.addHandler(file_handler)
    return logger


def send_json(sock: socket.socket, message: Dict[str, Any]) -> None:
    payload = (json.dumps(message) + "\n").encode("utf-8")
    sock.sendall(payload)


def receive_json(sock: socket.socket) -> Dict[str, Any]:
    # This sample protocol uses exactly one newline-delimited JSON message
    # in each direction for every TCP connection.
    with sock.makefile("r", encoding="utf-8") as stream:
        line = stream.readline()

    if not line:
        raise ConnectionError("Peer closed the connection before sending a message")

    return json.loads(line)


def rpc(host: str, port: int, request: Dict[str, Any], logger: logging.Logger) -> Dict[str, Any]:
    logger.info("Sending to %s:%s -> %s", host, port, request)

    with socket.create_connection((host, port), timeout=5) as sock:
        send_json(sock, request)
        response = receive_json(sock)

    logger.info("Received from %s:%s <- %s", host, port, response)
    return response
