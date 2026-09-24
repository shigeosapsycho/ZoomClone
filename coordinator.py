import os
import socketserver
from typing import Any

from common import (
    SERVER_SOCKET_TIMEOUT,
    ProtocolError,
    ThreadedTCPServer,
    read_json,
    rpc,
    setup_logging,
    write_json,
)

HOST = "0.0.0.0"
PORT = 5000

# Where the other services live. The defaults work on one machine; set these
# environment variables when the services run on different machines (see README).
SESSION_HOST = os.environ.get("SESSION_HOST", "127.0.0.1")
SESSION_PORT = int(os.environ.get("SESSION_PORT", "5001"))
MESSAGE_HOST = os.environ.get("MESSAGE_HOST", "127.0.0.1")
MESSAGE_PORT = int(os.environ.get("MESSAGE_PORT", "5002"))

logger = setup_logging("coordinator")


# socketserver creates one handler instance per incoming connection and calls
# handle() on it. StreamRequestHandler.setup() first wraps the client socket in
# self.rfile (buffered reader) and self.wfile (writer), once per connection.
class CoordinatorHandler(socketserver.StreamRequestHandler):
    timeout = SERVER_SOCKET_TIMEOUT  # applied to the socket in setup()

    def handle(self) -> None:
        try:
            message = read_json(self.rfile)
        except (ConnectionError, ProtocolError, OSError) as exc:
            logger.warning("Bad or missing request from %s: %s", self.client_address, exc)
            self.try_send({"status": "error", "reason": str(exc)})
            return

        logger.info("Received from client %s -> %s", self.client_address, message)

        match message.get("type"):
            case "JOIN_MEETING":
                response = self.join_meeting(message)
            case _:
                response = {"status": "error", "reason": "unknown request type"}

        logger.info("Sending to client %s <- %s", self.client_address, response)
        self.try_send(response)

    def try_send(self, response: dict[str, Any]) -> None:
        try:
            write_json(self.wfile, response)
        except OSError as exc:
            logger.warning("Client %s disconnected before reply: %s", self.client_address, exc)

    def join_meeting(self, message: dict[str, Any]) -> dict[str, Any]:
        meeting_id = message.get("meeting_id")
        user = message.get("user")

        if not meeting_id or not user:
            return {"status": "error", "reason": "meeting_id and user are required"}

        # Service-to-service request #1: update session state.
        try:
            session_response = rpc(
                SESSION_HOST,
                SESSION_PORT,
                {
                    "type": "REGISTER_PARTICIPANT",
                    "meeting_id": meeting_id,
                    "user": user,
                },
                logger,
            )
        except (ConnectionError, ProtocolError, OSError) as exc:
            logger.error("Session service unavailable: %s", exc)
            return {"status": "error", "reason": "session service unavailable"}

        if session_response.get("status") != "ok":
            return {"status": "error", "reason": "session service rejected the join request"}

        # Service-to-service request #2: emit a logical meeting message.
        try:
            message_response = rpc(
                MESSAGE_HOST,
                MESSAGE_PORT,
                {
                    "type": "SYSTEM_MESSAGE",
                    "meeting_id": meeting_id,
                    "text": f"{user} joined the meeting",
                },
                logger,
            )
        except (ConnectionError, ProtocolError, OSError) as exc:
            logger.error("Messaging service unavailable: %s", exc)
            return {"status": "error", "reason": "messaging service unavailable"}

        return {
            "status": "ok",
            "type": "JOIN_ACCEPTED",
            "meeting_id": meeting_id,
            "user": user,
            "participant_count": session_response.get("participant_count"),
            "participants": session_response.get("participants"),
            "message_service_status": message_response.get("status"),
        }


if __name__ == "__main__":
    logger.info(
        "Coordinator listening on %s:%s; session=%s:%s; messaging=%s:%s",
        HOST,
        PORT,
        SESSION_HOST,
        SESSION_PORT,
        MESSAGE_HOST,
        MESSAGE_PORT,
    )

    with ThreadedTCPServer((HOST, PORT), CoordinatorHandler) as server:
        server.serve_forever()
