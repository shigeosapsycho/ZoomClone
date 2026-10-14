import logging
import threading
import unittest

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

    def test_duplicate_participant_rejected(self):
        first = self.participant("dupe-test")
        second = Participant("dupe-test", port=self.port)
        with self.assertRaises(ConnectionError):
            second.connect()
        second.close()


if __name__ == "__main__":
    unittest.main()
