import threading

from common import JsonRequestHandler, ThreadedTCPServer, setup_logging

HOST = "0.0.0.0"
PORT = 5002

logger = setup_logging("messaging_service")

# Flat log of every message across all meetings. A dict keyed by meeting_id
# would make per-meeting lookups easier in a later milestone.
messages = []
# handle() runs in a separate thread per connection, so shared state needs a lock.
messages_lock = threading.Lock()


class MessagingHandler(JsonRequestHandler):
    logger = logger

    def handle_request(self, message: dict) -> dict:
        if message.get("type") != "SYSTEM_MESSAGE":
            return {"status": "error", "reason": "unknown request type"}

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
