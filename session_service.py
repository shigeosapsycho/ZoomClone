import threading

from common import JsonRequestHandler, ThreadedTCPServer, setup_logging

HOST = "0.0.0.0"
PORT = 5001

logger = setup_logging("session_service")

# Milestone 1 storage assumption: volatile, in-memory session state.
# Restarting this process forgets every meeting. Later milestones can make this
# fault tolerant (e.g. by replicating it across nodes).
# Meetings are created on demand by setdefault() below: meeting_id -> [users].
meetings: dict[str, list[str]] = {}
meetings_lock = threading.Lock()


class SessionHandler(JsonRequestHandler):
    logger = logger

    def handle_request(self, message: dict) -> dict:
        if message.get("type") != "REGISTER_PARTICIPANT":
            return {"status": "error", "reason": "unknown request type"}

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
