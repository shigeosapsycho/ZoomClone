import socketserver
import threading

from common import receive_json, send_json, setup_logging

HOST = "0.0.0.0"
PORT = 5001

logger = setup_logging("session_service")

# Milestone 1 storage assumption: volatile, in-memory session state.
meetings = {"demo-room": []}
meetings_lock = threading.Lock()


class SessionHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        try:
            request = receive_json(self.request)
            logger.info("Received from %s -> %s", self.client_address, request)

            if request.get("type") != "REGISTER_PARTICIPANT":
                response = {"status": "error", "reason": "unknown request type"}
            else:
                meeting_id = request.get("meeting_id")
                user = request.get("user")

                if not meeting_id or not user:
                    response = {
                        "status": "error",
                        "reason": "meeting_id and user are required",
                    }
                else:
                    with meetings_lock:
                        participants = meetings.setdefault(meeting_id, [])
                        if user not in participants:
                            participants.append(user)

                        response = {
                            "status": "ok",
                            "meeting_id": meeting_id,
                            "participants": list(participants),
                            "participant_count": len(participants),
                        }

            logger.info("Sending to %s <- %s", self.client_address, response)
            send_json(self.request, response)

        except Exception as exc:
            logger.exception("Failed to process request: %s", exc)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    logger.info("Session service listening on %s:%s", HOST, PORT)
    with Server((HOST, PORT), SessionHandler) as server:
        server.serve_forever()
