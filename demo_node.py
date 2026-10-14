"""Automated node scenario; each invocation runs in an independent OS process."""

import argparse
from pathlib import Path

from client import Participant
from protocol import configure_logging

TOPIC = "meeting.announcements"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--name", required=True)
    parser.add_argument("--role", choices=("publisher", "subscriber"), required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--meeting", default="demo-room")
    parser.add_argument("--log-dir", required=True)
    parser.add_argument("--ready-file")
    args = parser.parse_args()
    log = configure_logging(args.name, args.log_dir, trace=True)
    user = Participant(args.name, args.meeting, args.host, args.port, log, trace=True)
    try:
        print("JOIN_REPLY:", user.connect(), flush=True)
        if args.role == "subscriber":
            print("SUBSCRIBE_REPLY:", user.subscribe(TOPIC), flush=True)
            Path(args.ready_file).write_text("subscribed\n", encoding="utf-8")
            event = user.wait_for(lambda p: p["type"] == "event" and p["body"]["topic"] == TOPIC)
            print("PUBSUB_RECEIVED:", event["sender"], event["body"], flush=True)
            group = user.wait_for(lambda p: p["type"] == "group_message")
            print("GROUP_RECEIVED:", group["sender"], group["body"], flush=True)
        else:
            print("REQUEST_REPLY:", user.request("list_participants"), flush=True)
            print("PUBLISH_REPLY:", user.publish(TOPIC, "The demo meeting has started."), flush=True)
            print("GROUP_SEND_REPLY:", user.group_send("Welcome to our meeting!"), flush=True)
        print("RESULT: PASS", flush=True)
    finally:
        user.close()


if __name__ == "__main__":
    main()
