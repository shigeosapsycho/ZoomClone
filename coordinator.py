import os
import socketserver

from common import receive_json, rpc, send_json, setup_logging

HOST = "0.0.0.0"
PORT = 5000

SESSION_HOST = os.environ.get("SESSION_HOST", "127.0.0.1")
SESSION_PORT = int(os.environ.get("SESSION_PORT", "5001"))
MESSAGE_HOST = os.environ.get("MESSAGE_HOST", "127.0.0.1")
MESSAGE_PORT = int(os.environ.get("MESSAGE_PORT", "5002"))

logger = setup_logging("coordinator")


class CoordinatorHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        try:
            request = receive_json(self.request)
            logger.info("Received from client %s -> %s", self.client_address, request)

            if request.get("type") != "JOIN_MEETING":
                response = {"status": "error", "reason": "unknown request type"}
                send_json(self.request, response)
                return

            meeting_id = request.get("meeting_id")
            user = request.get("user")

            if not meeting_id or not user:
                response = {
                    "status": "error",
                    "reason": "meeting_id and user are required",
                }
                send_json(self.request, response)
                return

            # Service-to-service request #1: update session state.
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

            if session_response.get("status") != "ok":
                response = {
                    "status": "error",
                    "reason": "session service rejected the join request",
                }
                send_json(self.request, response)
                return

            # Service-to-service request #2: emit a logical meeting message.
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

            response = {
                "status": "ok",
                "type": "JOIN_ACCEPTED",
                "meeting_id": meeting_id,
                "user": user,
                "participant_count": session_response["participant_count"],
                "participants": session_response["participants"],
                "message_service_status": message_response.get("status"),
            }

            logger.info("Sending to client %s <- %s", self.client_address, response)
            send_json(self.request, response)

        except (ConnectionError, OSError) as exc:
            logger.exception("A dependent service is unavailable: %s", exc)
            try:
                send_json(
                    self.request,
                    {
                        "status": "error",
                        "reason": "dependent service unavailable",
                    },
                )
            except Exception:
                pass
        except Exception as exc:
            logger.exception("Unexpected coordinator error: %s", exc)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


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

    with Server((HOST, PORT), CoordinatorHandler) as server:
        server.serve_forever()
