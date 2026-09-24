import argparse
import json

from common import rpc, setup_logging

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

    response = rpc(args.host, args.port, request, logger)

    print("\nServer response:")
    print(json.dumps(response, indent=2))


if __name__ == "__main__":
    main()
