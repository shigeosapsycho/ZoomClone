import argparse
import json

from common import ProtocolError, rpc, setup_logging

logger = setup_logging("client")


def main() -> None:
    parser = argparse.ArgumentParser(description="Milestone 1 meeting client")
    parser.add_argument("--host", default="127.0.0.1", help="Coordinator host")
    parser.add_argument("--port", type=int, default=5000, help="Coordinator port")
    parser.add_argument("--user", default="Alice", help="Participant name")
    parser.add_argument("--meeting", default="demo-room", help="Meeting ID")
    args = parser.parse_args()

    request = {
        "type": "JOIN_MEETING",
        "meeting_id": args.meeting,
        "user": args.user,
    }

    # One-shot request: connect, send, read the reply, close.
    # A persistent connection (e.g. a chat loop) is future work.
    try:
        response = rpc(args.host, args.port, request, logger)
    except (ConnectionError, ProtocolError, OSError) as exc:
        logger.error("Could not reach the coordinator at %s:%s: %s", args.host, args.port, exc)
        return

    print("\nServer response:")
    print(json.dumps(response, indent=2))


if __name__ == "__main__":
    main()
