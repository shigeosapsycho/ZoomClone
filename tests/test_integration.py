import logging
import queue
import subprocess
import sys
import threading
import unittest
from pathlib import Path

from client import Participant
from server import MeetingServer


class IntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = MeetingServer(("127.0.0.1", 0), logging.getLogger("test_server"))
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def setUp(self):
        self.participants = []

    def participant(self, name, meeting="demo-room"):
        user = Participant(name, meeting=meeting, port=self.port)
        user.connect()
        self.participants.append(user)
        return user

    def tearDown(self):
        for user in self.participants:
            user.close()

    def test_request_reply_pubsub_and_group(self):
        bob = self.participant("bob")
        charlie = self.participant("charlie")
        alice = self.participant("alice")
        outsider = self.participant("dave", meeting="other-room")
        self.assertEqual(alice.request("list_participants")["participants"], ["alice", "bob", "charlie"])
        self.assertEqual(alice.request("meeting_info")["participant_count"], 3)
        self.assertEqual(outsider.request("list_participants")["participants"], ["dave"])
        self.assertEqual(bob.subscribe("meeting.announcements")["status"], "subscribed")
        self.assertEqual(charlie.subscribe("meeting.announcements")["status"], "subscribed")
        answer = alice.publish("meeting.announcements", "Starting meeting")
        self.assertEqual(answer["subscriber_deliveries"], 2)
        for receiver in (bob, charlie):
            packet = receiver.wait_for(lambda p: p["type"] == "event")
            self.assertEqual(packet["body"]["content"], "Starting meeting")
            self.assertEqual(packet["sender"], "alice")
        self.assertTrue(outsider.inbox.empty())
        group_answer = alice.group_send("Hello team")
        self.assertEqual(group_answer["group_deliveries"], 3)  # includes sender
        for receiver in (alice, bob, charlie):
            packet = receiver.wait_for(lambda p: p["type"] == "group_message")
            self.assertEqual(packet["body"]["content"], "Hello team")
        self.assertTrue(outsider.inbox.empty())

    def test_invalid_command_error(self):
        user = self.participant("invalid-test")
        with self.assertRaisesRegex(ValueError, "Unknown request operation"):
            user.request("no-such-operation")

    def test_leave_announced_once_to_remaining_meeting_members(self):
        alice = self.participant("alice", meeting="leave-room")
        bob = self.participant("bob", meeting="leave-room")
        leaver = self.participant("charlie", meeting="leave-room")
        outsider = self.participant("dave", meeting="different-room")
        leaver.subscribe("meeting.announcements")
        with self.server.state_lock:
            session = self.server.members[("leave-room", "charlie")]

        leaver.close()

        # Neither remaining participant subscribed: departures are automatic.
        for observer in (alice, bob):
            packet = observer.inbox.get(timeout=3)
            self.assertEqual(packet["type"], "participant_left")
            self.assertEqual(packet["sender"], "server")
            self.assertEqual(packet["meeting"], "leave-room")
            self.assertEqual(packet["body"], {
                "username": "charlie", "content": "charlie left the meeting."
            })
        self.assertEqual(alice.request("list_participants")["participants"], ["alice", "bob"])
        with self.server.state_lock:
            self.assertNotIn(("leave-room", "meeting.announcements"), self.server.subscriptions)

        # Cleanup can run through both a failed send and the handler's finally block.
        self.server.remove(session)
        for observer in (alice, bob, outsider):
            with self.assertRaises(queue.Empty):
                observer.inbox.get(timeout=0.1)

    def test_abrupt_process_exit_announced(self):
        alice = self.participant("alice", meeting="abrupt-room")
        bob = self.participant("bob", meeting="abrupt-room")
        # os._exit skips Participant.close() and all Python cleanup handlers.
        script = (
            "import os, sys\n"
            "from client import Participant\n"
            "user = Participant('charlie', meeting='abrupt-room', port=int(sys.argv[1]))\n"
            "user.connect()\n"
            "os._exit(0)\n"
        )
        subprocess.run([sys.executable, "-B", "-c", script, str(self.port)],
                       cwd=Path(__file__).resolve().parents[1],
                       check=True, capture_output=True, text=True, timeout=10)
        for observer in (alice, bob):
            packet = observer.inbox.get(timeout=3)
            self.assertEqual(packet["type"], "participant_left")
            self.assertEqual(packet["body"]["username"], "charlie")
        self.assertEqual(alice.request("list_participants")["participants"], ["alice", "bob"])

    def test_duplicate_participant_rejected(self):
        first = self.participant("dupe-test")
        second = Participant("dupe-test", port=self.port)
        with self.assertRaises(ConnectionError):
            second.connect()
        second.close()


if __name__ == "__main__":
    unittest.main()
