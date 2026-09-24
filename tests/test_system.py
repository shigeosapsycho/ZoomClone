"""End-to-end tests that start the real services as subprocesses.

These use the fixed ports 5000-5002, so stop any services you have running first.
"""

import json
import tempfile
import time
import unittest

from tests.support import (
    TEST_SERVER_TIMEOUT,
    Services,
    free_port,
    join,
    run_client,
    send_raw,
)


class AllServicesUpTests(unittest.TestCase):
    """Coordinator, session and messaging services all running.

    Each test uses its own meeting_id so the tests don't depend on each other's state.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.services = Services("session_service", "messaging_service", "coordinator").start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.services.stop()

    def test_participant_count_increases(self) -> None:
        Alice = join("Alice", "count-room")
        Bob = join("Bob", "count-room")

        self.assertEqual(Alice["status"], "ok")
        self.assertEqual(Alice["type"], "JOIN_ACCEPTED")
        self.assertEqual(Alice["participant_count"], 1)
        self.assertEqual(Bob["participant_count"], 2)
        self.assertEqual(Bob["participants"], ["Alice", "Bob"])
        self.assertEqual(Bob["message_service_status"], "ok")

    def test_rejoining_does_not_duplicate_participant(self) -> None:
        join("Alice", "rejoin-room")
        again = join("Alice", "rejoin-room")

        self.assertEqual(again["participants"], ["Alice"])

    def test_meetings_are_separate(self) -> None:
        join("Alice", "room-one")
        other = join("Bob", "room-two")

        self.assertEqual(other["participants"], ["Bob"])

    def test_join_is_logged_by_messaging_service(self) -> None:
        join("Dana", "log-room")

        self.assertIn("Dana joined the meeting", self.services.log("messaging_service"))

    def test_missing_fields(self) -> None:
        reply = send_raw(b'{"type": "JOIN_MEETING"}\n')

        self.assertEqual(reply, {"status": "error", "reason": "meeting_id and user are required"})

    def test_unknown_request_type(self) -> None:
        reply = send_raw(b'{"type": "NOPE"}\n')

        self.assertEqual(reply, {"status": "error", "reason": "unknown request type"})

    def test_non_object_json(self) -> None:
        reply = send_raw(b"[1]\n")

        self.assertEqual(reply, {"status": "error", "reason": "expected a JSON object"})

    def test_invalid_json(self) -> None:
        reply = send_raw(b"not json\n")

        self.assertEqual(reply, {"status": "error", "reason": "message is not valid JSON"})

    def test_invalid_utf8(self) -> None:
        reply = send_raw(b"\xff\xfe\n")

        self.assertEqual(reply, {"status": "error", "reason": "message is not valid UTF-8"})

    def test_silent_client_times_out(self) -> None:
        # Waits for the server-side timeout (shortened to TEST_SERVER_TIMEOUT for tests).
        start = time.monotonic()
        reply = send_raw(b"", timeout=TEST_SERVER_TIMEOUT + 5)
        elapsed = time.monotonic() - start

        self.assertEqual(reply, {"status": "error", "reason": "timed out"})
        self.assertGreaterEqual(elapsed, TEST_SERVER_TIMEOUT * 0.9)

    def test_client_cli_joins(self) -> None:
        result = run_client("--user", "Erin", "--meeting", "cli-room", cwd=self.services.workdir.name)

        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout.split("Server response:")[1])
        self.assertEqual(response["status"], "ok")
        self.assertEqual(response["participants"], ["Erin"])


class MessagingServiceDownTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.services = Services("session_service", "coordinator").start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.services.stop()

    def test_join_reports_messaging_unavailable(self) -> None:
        reply = join("Carol", "down-room")

        self.assertEqual(reply, {"status": "error", "reason": "messaging service unavailable"})

    def test_coordinator_keeps_serving(self) -> None:
        join("Carol", "down-room-2")
        reply = send_raw(b'{"type": "NOPE"}\n')

        self.assertEqual(reply["reason"], "unknown request type")


class SessionServiceDownTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.services = Services("messaging_service", "coordinator").start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.services.stop()

    def test_join_reports_session_unavailable(self) -> None:
        reply = join("Carol", "down-room")

        self.assertEqual(reply, {"status": "error", "reason": "session service unavailable"})


class ClientWithoutCoordinatorTests(unittest.TestCase):
    def test_unreachable_coordinator_has_no_traceback(self) -> None:
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as workdir:
            result = run_client("--port", str(free_port()), cwd=workdir)

        self.assertIn("Could not reach the coordinator", result.stderr)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    unittest.main()
