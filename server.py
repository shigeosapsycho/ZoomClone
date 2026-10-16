"""TCP meeting coordinator, pub-sub broker, and group message distributor."""

import argparse
import re
import socketserver
import threading

from protocol import configure_logging, message, receive, send

IDENTIFIER_RE = re.compile(r"^[A-Za-z0-9_.-]{1,32}$")


class MeetingServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    request_queue_size = 64

    def __init__(self, address, logger, trace=False):
        super().__init__(address, ConnectionHandler)
        self.log = logger
        self.trace = trace
        self.state_lock = threading.RLock()
        self.members = {}  # (meeting_id, username) -> ConnectionHandler
        self.subscriptions = {}  # (meeting_id, topic) -> set((meeting_id, username))

    def join(self, session, meeting, username):
        key = (meeting, username)
        with self.state_lock:
            if key in self.members:
                return False
            self.members[key] = session
        self.log.info("JOIN meeting=%s participant=%s", meeting, username)
        return True

    def remove(self, session):
        if session.username is None:
            return
        key = (session.meeting, session.username)
        with self.state_lock:
            if self.members.get(key) is not session:
                return
            del self.members[key]
            for topic, listeners in list(self.subscriptions.items()):
                listeners.discard(key)
                if not listeners:
                    del self.subscriptions[topic]
            targets = [member for (meeting, _), member in self.members.items()
                       if meeting == session.meeting]
        self.log.info("LEAVE meeting=%s participant=%s", *key)
        announcement = message("participant_left", sender="server", meeting=session.meeting,
                               body={"username": session.username,
                                     "content": f"{session.username} left the meeting."})
        # Send after releasing the state lock; failed writes can remove other sessions.
        self.distribute(targets, announcement)

    def members_in(self, meeting):
        with self.state_lock:
            return sorted(username for room, username in self.members if room == meeting)

    def subscribe(self, key, topic):
        with self.state_lock:
            self.subscriptions.setdefault((key[0], topic), set()).add(key)
        self.log.info("SUBSCRIBE meeting=%s topic=%s participant=%s", key[0], topic, key[1])

    def subscribers(self, meeting, topic):
        with self.state_lock:
            keys = self.subscriptions.get((meeting, topic), set()).copy()
            return [self.members[key] for key in sorted(keys) if key in self.members]

    def group(self, meeting):
        with self.state_lock:
            return [session for (room, _), session in self.members.items() if room == meeting]

    def distribute(self, targets, packet):
        delivered = 0
        for session in targets:
            try:
                session.send_packet(packet)
                delivered += 1
            except OSError:
                self.log.warning("Delivery failed to %s", session.username)
                session.close_connection()
                self.remove(session)
        return delivered


class ConnectionHandler(socketserver.BaseRequestHandler):
    def setup(self):
        self.send_lock = threading.Lock()
        self.username = None
        self.meeting = None
        self.reader = self.request.makefile("rb")
        self.log = self.server.log

    def send_packet(self, packet):
        send(self.request, packet, self.send_lock, self.log, self.server.trace)

    def close_connection(self):
        try:
            self.request.shutdown(2)
        except OSError:
            pass
        self.request.close()

    def reply(self, incoming, **body):
        self.send_packet(message("reply", request_id=incoming.get("id"), body=body))

    def error(self, incoming, reason):
        self.send_packet(message("error", request_id=incoming.get("id"), body={"error": reason}))

    def handle(self):
        self.log.info("CONNECTION remote=%s:%s", *self.client_address[:2])
        try:
            while True:
                try:
                    packet = receive(self.reader, self.log, self.server.trace)
                except ValueError as exc:
                    self.log.warning("Invalid packet: %s", exc)
                    self.send_packet(message("error", body={"error": str(exc)}))
                    break
                if packet is None:
                    break
                if self.username is None:
                    if packet["type"] != "join":
                        self.error(packet, "First packet must be join")
                        break
                    body = packet.get("body", {})
                    if not isinstance(body, dict):
                        self.error(packet, "Invalid join body")
                        break
                    username, meeting = body.get("username"), body.get("meeting")
                    if not isinstance(username, str) or not IDENTIFIER_RE.fullmatch(username):
                        self.error(packet, "Invalid username (1-32: letters, digits, . _ -)")
                        break
                    if not isinstance(meeting, str) or not IDENTIFIER_RE.fullmatch(meeting):
                        self.error(packet, "Invalid meeting ID (1-32: letters, digits, . _ -)")
                        break
                    if not self.server.join(self, meeting, username):
                        self.error(packet, "Username already in this meeting")
                        break
                    self.username, self.meeting = username, meeting
                    self.reply(packet, status="joined", meeting=meeting, username=username)
                    continue
                self.dispatch(packet)
        except (OSError, ConnectionError) as exc:
            self.log.warning("Connection ended for %s: %s", self.username, exc)
        finally:
            self.server.remove(self)

    def dispatch(self, packet):
        kind = packet["type"]
        body = packet.get("body", {})
        if not isinstance(body, dict):
            self.error(packet, "Body must be a JSON object")
            return
        if kind == "request":
            operation = body.get("operation")
            if operation == "list_participants":
                self.reply(packet, status="ok", operation=operation,
                           meeting=self.meeting, participants=self.server.members_in(self.meeting))
            elif operation == "meeting_info":
                self.reply(packet, status="ok", operation=operation, meeting=self.meeting,
                           participant_count=len(self.server.members_in(self.meeting)))
            else:
                self.error(packet, "Unknown request operation")
        elif kind == "subscribe":
            topic = body.get("topic")
            if not isinstance(topic, str) or not IDENTIFIER_RE.fullmatch(topic):
                self.error(packet, "Invalid topic")
                return
            self.server.subscribe((self.meeting, self.username), topic)
            self.reply(packet, status="subscribed", topic=topic)
        elif kind == "publish":
            topic, content = body.get("topic"), body.get("content")
            if not isinstance(topic, str) or not IDENTIFIER_RE.fullmatch(topic) or not isinstance(content, str) or len(content) > 4096:
                self.error(packet, "Invalid topic/content (content: at most 4096 chars)")
                return
            event = message("event", sender=self.username, meeting=self.meeting,
                            body={"topic": topic, "content": content})
            count = self.server.distribute(self.server.subscribers(self.meeting, topic), event)
            self.log.info("PUBLISH meeting=%s topic=%s publisher=%s delivered=%s", self.meeting, topic, self.username, count)
            self.reply(packet, status="published", subscriber_deliveries=count)
        elif kind == "group_send":
            content = body.get("content")
            if not isinstance(content, str) or len(content) > 4096:
                self.error(packet, "Invalid group content (at most 4096 chars)")
                return
            group_packet = message("group_message", sender=self.username, meeting=self.meeting,
                                   body={"content": content})
            count = self.server.distribute(self.server.group(self.meeting), group_packet)
            self.log.info("GROUP_SEND meeting=%s sender=%s delivered=%s", self.meeting, self.username, count)
            self.reply(packet, status="distributed", group_deliveries=count)
        else:
            self.error(packet, "Unknown message type")

    def finish(self):
        try:
            self.reader.close()
        finally:
            self.close_connection()


def main():
    parser = argparse.ArgumentParser(description="Meeting coordination TCP broker")
    parser.add_argument("--host", default="127.0.0.1", help="Bind IP; use 0.0.0.0 for LAN access")
    parser.add_argument("--port", type=int, default=5000)
    parser.add_argument("--log-dir", default="logs")
    parser.add_argument("--trace-marshalling", action="store_true")
    args = parser.parse_args()
    logger = configure_logging("server", args.log_dir, args.trace_marshalling)
    with MeetingServer((args.host, args.port), logger, args.trace_marshalling) as server:
        logger.info("Listening on %s:%d", *server.server_address[:2])
        try:
            server.serve_forever(poll_interval=0.2)
        except KeyboardInterrupt:
            logger.info("Stopping server")


if __name__ == "__main__":
    main()
