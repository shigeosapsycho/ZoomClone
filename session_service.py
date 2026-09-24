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
PORT = 5001

logger = setup_logging("session_service")

# Milestone 1 storage assumption: volatile, in-memory session state.
# Restarting this process forgets every meeting. Later milestones can make this
# fault tolerant (e.g. by replicating it across nodes).
# Meetings are created on demand by setdefault() below: meeting_id -> [users].
meetings: dict[str, list[str]] = {}
meetings_lock = threading.Lock()


class SessionHandler(socketserver.StreamRequestHandler):
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
            case "REGISTER_PARTICIPANT":
                response = self.register_participant(message)
            case _:
                response = {"status": "error", "reason": "unknown request type"}

        logger.info("Sending to %s <- %s", self.client_address, response)
        self.try_send(response)

    def try_send(self, response: dict[str, Any]) -> None:
        try:
            write_json(self.wfile, response)
        except OSError as exc:
            logger.warning("%s disconnected before reply: %s", self.client_address, exc)

    def register_participant(self, message: dict[str, Any]) -> dict[str, Any]:
        meeting_id = message.get("meeting_id")
        user = message.get("user")

        if not meeting_id or not user:
            return {"status": "error", "reason": "meeting_id and user are required"}

        # The lock makes the check-then-append atomic across handler threads.
        with meetings_lock:
            participants = meetings.setdefault(meeting_id, [])
            if user not in participants:
                participants.append(user)

            return {
                "status": "ok",
                "meeting_id": meeting_id,
                "participants": list(participants),
                "participant_count": len(participants),
            }


if __name__ == "__main__":
    logger.info("Session service listening on %s:%s", HOST, PORT)
    with ThreadedTCPServer((HOST, PORT), SessionHandler) as server:
        server.serve_forever()
