# CECS 327 Milestone 1 — Zoom-like Distributed Skeleton

A minimal distributed prototype: a Coordinator, a Session Service, and a Messaging Service that communicate over TCP, plus a client that joins a meeting.

## Required software

- Python 3.10 or newer (the code uses `match` statements).

## Installing dependencies

Nothing to install. The project uses only the Python standard library, including `unittest` for the tests.

## Starting each service

Open a terminal in this directory for each service and start them in this order:

| Terminal | Command | Service | Port |
|---|---|---|---|
| 1 | `python session_service.py` | Session Service | 5001 |
| 2 | `python messaging_service.py` | Messaging Service | 5002 |
| 3 | `python coordinator.py` | Coordinator | 5000 |

Each service logs to its terminal and to `logs/<service>.log`. Stop a service with `Ctrl+C`.

## Running the demo

With all three services running, open a fourth terminal and join a meeting:

```bash
python client.py --user Alice --meeting demo-room
```

Then join as a second user:

```bash
python client.py --user Bob --meeting demo-room
```

Each client prints the Coordinator's response and exits. The second response lists both participants and a `participant_count` of 2. The Messaging Service terminal shows a "joined the meeting" message for each user.

Client options: `--host` (default `127.0.0.1`), `--port` (default `5000`), `--user` (default `Alice`), `--meeting` (default `demo-room`).

To see failure handling, stop the Session Service or Messaging Service and run the client again; the Coordinator replies with `session service unavailable` or `messaging service unavailable` instead of crashing.

## Reproducing the test cases

Stop any running services first, since the system tests start their own on ports 5000–5002. Then run from this directory:

```bash
python -m unittest -v
```

All 22 tests should pass in about 12 seconds on Windows (less on Linux/macOS). To run part of the suite:

```bash
python -m unittest tests.test_protocol                           # one file
python -m unittest tests.test_system.MessagingServiceDownTests   # one test class
```

| File | What it covers |
|---|---|
| `tests/test_protocol.py` | Newline-delimited JSON encoding and decoding, with no network |
| `tests/test_system.py` | Starts the real services and checks joins, separate meetings, bad input, the server timeout, a service being down, and the client CLI |
| `tests/support.py` | Helpers for starting/stopping services and sending raw requests |

Test logs go to a temporary folder, not `logs/`.
