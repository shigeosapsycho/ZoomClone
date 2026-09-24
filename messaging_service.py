import socketserver
import threading

from common import receive_json, send_json, setup_logging

HOST = "0.0.0.0"
PORT = 5002

logger = setup_logging("messaging_service")

messages = []
messages_lock = threading.Lock()


class MessagingHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        try:
            request = receive_json(self.request)
            logger.info("Received from %s -> %s", self.client_address, request)

            if request.get("type") != "SYSTEM_MESSAGE":
                response = {"status": "error", "reason": "unknown request type"}
            else:
                meeting_id = request.get("meeting_id")
                text = request.get("text")

                if not meeting_id or not text:
                    response = {
                        "status": "error",
                        "reason": "meeting_id and text are required",
                    }
                else:
                    with messages_lock:
                        messages.append({"meeting_id": meeting_id, "text": text})
                        count = len(messages)

                    # For Milestone 1 we only log the logical broadcast.
                    # Actual multicast/fan-out can be added in a later milestone.
                    logger.info("Broadcast for meeting %s: %s", meeting_id, text)
                    response = {"status": "ok", "stored_messages": count}

            logger.info("Sending to %s <- %s", self.client_address, response)
            send_json(self.request, response)

        except Exception as exc:
            logger.exception("Failed to process request: %s", exc)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    logger.info("Messaging service listening on %s:%s", HOST, PORT)
    with Server((HOST, PORT), MessagingHandler) as server:
        server.serve_forever()
