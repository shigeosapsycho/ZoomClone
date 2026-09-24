# CECS 327 Milestone 1 — Zoom-like Distributed Skeleton

This is a minimal distributed prototype for Milestone 1. It does **not** stream video yet. Its purpose is to demonstrate multiple communicating processes/services, a client request, server responses, and message logging.

## Components

1. **Coordinator** (`coordinator.py`, TCP 5000)
   - Entry point for clients.
   - Receives `JOIN_MEETING` requests.
   - Calls the Session Service and Messaging Service.

2. **Session Service** (`session_service.py`, TCP 5001)
   - Stores meeting participant state in memory.
   - Registers participants.

3. **Messaging Service** (`messaging_service.py`, TCP 5002)
   - Accepts logical system messages such as "Alice joined the meeting".
   - Logs/stores those messages in memory.

4. **Client** (`client.py`)
   - Sends a join request to the Coordinator.
   - Displays the Coordinator's response.

## Requirements

- Python 3.9+ recommended.
- No third-party packages are required.

## Run the local demo

Open four terminals in this directory.

Terminal 1:

```bash
python session_service.py
```

Terminal 2:

```bash
python messaging_service.py
```

Terminal 3:

```bash
python coordinator.py
```

Terminal 4:

```bash
python client.py --user Alice --meeting demo-room
```

Try a second client:

```bash
python client.py --user Bob --meeting demo-room
```

The response should show the participant count increasing.

## Logs

Each process writes to both the terminal and a file under `logs/`:

- `logs/session_service.log`
- `logs/messaging_service.log`
- `logs/coordinator.log`
- `logs/client.log`

These logs can be used for the Milestone 1 screenshots/log evidence.

## Communication flow

```text
Client
  |
  | JOIN_MEETING
  v
Coordinator :5000
  |
  | REGISTER_PARTICIPANT
  +-----------------------> Session Service :5001
  |                          |
  |<-------------------------+ participant list/count
  |
  | SYSTEM_MESSAGE
  +-----------------------> Messaging Service :5002
  |                          |
  |<-------------------------+ acknowledgement
  |
  | JOIN_ACCEPTED
  v
Client
```

## Running services on different machines later

All servers bind to `0.0.0.0`, so the same code can be distributed across machines.

On the Coordinator machine, set the locations of the other services before starting it:

Linux/macOS:

```bash
SESSION_HOST=192.168.1.20 MESSAGE_HOST=192.168.1.21 python coordinator.py
```

PowerShell:

```powershell
$env:SESSION_HOST="192.168.1.20"
$env:MESSAGE_HOST="192.168.1.21"
python coordinator.py
```

Then point the client at the Coordinator machine:

```bash
python client.py --host 192.168.1.10 --user Alice --meeting demo-room
```

Make sure TCP ports 5000, 5001, and 5002 are allowed through the relevant firewalls.

## Milestone 1 system-model assumptions represented by the code

- **Organization:** distributed services with a coordinator as the current logical entry point.
- **Timing:** semi-synchronous practical assumption; RPC calls use timeouts, but exact network delay is not assumed.
- **Node failure:** crash/temporary unavailability is possible; the coordinator reports a dependent-service error.
- **Link failure:** connections may fail or time out.
- **Storage:** volatile in-memory state only for this milestone. Restarting a service loses its state.

Later milestones can replace the in-memory structures with replicated persistent state, add host/leader election, participant failure detection, and actual audio/video signaling and transport.
