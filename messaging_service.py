import socketserver
import threading
from typing import Any

from common import (
    SERVER_SOCKET_TIMEOUT,
    ProtocolError,
    ThreadedTCPServer,
    read_json,
    setup_logging,
    write_json,
)

HOST = "0.0.0.0"
PORT = 5002

logger = setup_logging("messaging_service")

# Flat log of every message across all meetings. A dict keyed by meeting_id
# would make per-meeting lookups easier in a later milestone.
messages = []
# handle() runs in a separate thread per connection, so shared state needs a lock.
messages_lock = threading.Lock()


class MessagingHandler(socketserver.StreamRequestHandler):
    timeout = SERVER_SOCKET_TIMEOUT  # applied to the socket in setup()

    def handle(self) -> None:
        try:
            message = read_json(self.rfile)
        except (ConnectionError, ProtocolError, OSError) as exc:
            logger.warning("Bad or missing request from %s: %s", self.client_address, exc)
            self.try_send({"status": "error", "reason": str(exc)})
            return

        logger.info("Received from %s -> %s", self.client_address, message)

        match message.get("type"):
            case "SYSTEM_MESSAGE":
                response = self.system_message(message)
            case _:
                response = {"status": "error", "reason": "unknown request type"}

        logger.info("Sending to %s <- %s", self.client_address, response)
        self.try_send(response)

    def try_send(self, response: dict[str, Any]) -> None:
        try:
            write_json(self.wfile, response)
        except OSError as exc:
            logger.warning("%s disconnected before reply: %s", self.client_address, exc)

    def system_message(self, message: dict[str, Any]) -> dict[str, Any]:
        meeting_id = message.get("meeting_id")
        text = message.get("text")

        if not meeting_id or not text:
            return {"status": "error", "reason": "meeting_id and text are required"}

        with messages_lock:
            messages.append({"meeting_id": meeting_id, "text": text})
            count = len(messages)

        # For Milestone 1 we only log the logical broadcast.
        # Actual multicast/fan-out can be added in a later milestone.
        logger.info("Broadcast for meeting %s: %s", meeting_id, text)
        return {"status": "ok", "stored_messages": count}


if __name__ == "__main__":
    logger.info("Messaging service listening on %s:%s", HOST, PORT)
    with ThreadedTCPServer((HOST, PORT), MessagingHandler) as server:
        server.serve_forever()
