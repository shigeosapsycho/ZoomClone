# CECS 327 — Milestone 2: Video Meeting Communication Prototype

This project implements **the communication mechanisms**, rather than media streaming, for a future Zoom-style distributed meeting system. It is based on the uploaded Milestone 2 specification.

## Features

- **TCP sockets:** one persistent TCP connection per participant; a thread handles each client.
- **Request–reply:** `request(list_participants)` and `request(meeting_info)` return a correlated `reply`.
- **Publish–subscribe:** a participant calls `subscribe(topic)`; a `publish(topic, content)` event is forwarded only to subscribers **within the same meeting**.
- **Group communication:** `group_send(content)` is forwarded to every participant **within the same meeting**, including the sender.
- **Marshalling/unmarshalling:** Python dictionaries are serialized to UTF-8 JSON and deserialized on arrival. TCP framing uses **one JSON object per newline**.
- **Logging:** each process emits UTC timestamps, message identifiers, send/receive messages, and, when enabled, dictionary/byte representations of marshalling operations.
- **Independent processes:** `demo.py` launches one server and three participant processes (Alice, Bob, Charlie).

### Architecture

```text
          Bob (client process) ---------\
                                        \
          Charlie (client process) ------> TCP Meeting Coordinator (server process)
                                        /   ├── Meeting membership / request–reply
          Alice (client process) -------/    ├── Topic subscription & event forwarding
                                             └── Group messaging / fan-out
```

This is a *centralized communication broker with independently running network clients*. This fulfills Milestone 2 communication requirements but **is not** decentralized coordination, a consensus algorithm, leader election, persistent replication, automatic server failover, or audio/video streaming. Those are outside the listed Milestone 2 requirements.

## Required software

- Python 3.9+ (standard library only)
- Localhost networking for the automatic demo, or TCP network access between machines for manual use
- No packages to install; no `requirements.txt` dependencies

Check Python: `python --version` (`python3 --version` on systems where appropriate).

## One-command demo: required for the video

From the directory containing `demo.py`:

```sh
python demo.py
```

The program starts **four OS processes**, waits for Bob and Charlie to join and subscribe, and then runs Alice's scenario. It checks that all three participants complete successfully.

Actual machine-generated evidence appears in:

```text
evidence/demo_run/demo_transcript.txt
 evidence/demo_run/server.log
 evidence/demo_run/alice.log
 evidence/demo_run/bob.log
 evidence/demo_run/charlie.log
 evidence/demo_run/*.console.txt
```

The transcript includes both `MARSHAL object=... -> wire_bytes=...` and `UNMARSHAL wire_bytes=... -> object=...` trace lines so the recording can show data **before** and **after** marshalling. The demo overwrites only previously generated demo files in `evidence/demo_run` each time.

**Expected behavior:** Alice requests a participant list, publishes a meeting notification, and sends a group chat message. Bob and Charlie independently receive the published event and group message. The `RESULT: PASS` line appears in all three client outputs. Subscriber delivery count is 2; group delivery count is 3 (includes Alice).

## Manual demo: start each service separately

Open **four terminals** in the project directory.

Terminal 1 (server):

```sh
python server.py --host 127.0.0.1 --port 5000 --trace-marshalling
```

Terminals 2–4 (participants):

```sh
python client.py --name alice   --meeting demo-room --port 5000 --trace-marshalling
python client.py --name bob     --meeting demo-room --port 5000 --trace-marshalling
python client.py --name charlie --meeting demo-room --port 5000 --trace-marshalling
```

Enter the following commands at the `bob>` and `charlie>` prompts **first**:

```text
subscribe meeting.announcements
```

At `alice>`:

```text
members
info
publish meeting.announcements The meeting begins now
say Hello to the entire group
```

Watch the Bob/Charlie console logs for `DELIVERED event` and `DELIVERED group_message`. Type `quit` in each client; press Ctrl+C at the server.

### Run on separate computers (same LAN)

On server machine:

```sh
python server.py --host 0.0.0.0 --port 5000
```

On each client machine, replace `192.168.1.10` with the server computer's reachable LAN IPv4 address:

```sh
python client.py --name bob --host 192.168.1.10 --port 5000 --meeting demo-room
```

Permit **TCP port 5000** through the server host firewall if needed. All peers must reach the server. Do **not** expose this prototype to the public Internet: it provides no encryption or authentication.

## Message protocol

Every message has a `type`, generated `id`, UTC `timestamp`, and a `body`; requests that receive replies carry a matching `request_id` in the reply.

Example (illustrative, IDs/timestamps change every run):

```json
{"type":"request","id":"abc123","timestamp":"2026-10-13T20:00:00.000+00:00","body":{"operation":"list_participants"}}
```

```json
{"type":"reply","id":"def456","timestamp":"2026-10-13T20:00:00.100+00:00","request_id":"abc123","body":{"status":"ok","operation":"list_participants","meeting":"demo-room","participants":["alice","bob","charlie"]}}
```

Publish format: `{"type":"publish", "body":{"topic":"meeting.announcements","content":"..."}, ...}`. The broker routes an `event` with `sender` and `meeting` fields.

Group format: `{"type":"group_send", "body":{"content":"..."}, ...}`. The broker routes a `group_message` with `sender` and `meeting` fields.

**Socket transport framing:** Every encoded JSON packet ends in `\n`; the receiver calls `readline` and parses exactly one packet. Maximum 65,536 wire bytes per packet; Unicode is supported.

## Test cases

From the project root:

```sh
python -m unittest discover -s tests -v
```

Tests cover JSON round-trip, Unicode, invalid/truncated data, oversize packets, request–reply, fan-out to **two** subscribers, group delivery to **three** participants, meeting isolation, invalid requests, and duplicate usernames.

For complete multi-process smoke testing:

```sh
python demo.py
```

## Source files

| File | Responsibility |
| --- | --- |
| `protocol.py` | Packet creation, JSON encoding/decoding, framing, UTC logging |
| `server.py` | TCP listener, membership, subscription registry, request routing, publish fan-out, group fan-out |
| `client.py` | Reusable participant API, asynchronous receiver, correlated request/reply, interactive CLI |
| `demo_node.py` | Deterministic publisher/subscriber scenario executed by one client process |
| `demo.py` | Launches four processes, synchronizes demo startup, records proof |
| `tests/` | Protocol and socket integration tests |
| `Milestone2_Report.pdf` | Communication design and real test/log evidence |
| `CONTRIBUTIONS_TEMPLATE.md` | Contribution table to fill with real group work |

## Short video walkthrough (recommended)

1. Show the architecture and the PDF design report.
2. Run `python demo.py` and show `RESULT: PASS` outputs.
3. Open `evidence/demo_run/demo_transcript.txt` and locate `REQUEST_REPLY`, `PUBLISH_REPLY`, two `PUBSUB_RECEIVED` lines, and two `GROUP_RECEIVED` lines.
4. Show `MARSHAL object=... -> wire_bytes=b'...\\n'` and `UNMARSHAL wire_bytes=... -> object=...` logs.
5. Identify the protocol, server, client, and demo code files.

## Known limitations and security assumptions

The server is an in-memory **single point of failure**; messages are not persisted or retransmitted after disconnection. A successful delivery count means the TCP write succeeded, **not** that an application processed the message. `publish` is routed only to active subscribers; there is no replay. A participant can connect without authentication, and traffic is unencrypted. Separate-process demo works locally; for WAN use, proper authentication, TLS, NAT traversal, reliable media streaming, replication, and failover require additional design. The interface currently coordinates participants and messages but does **not** transmit microphone or camera data.
