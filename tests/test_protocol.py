import json
import unittest

from protocol import MAX_MESSAGE_BYTES, marshal, message, unmarshal


class ProtocolTests(unittest.TestCase):
    def test_roundtrip_unicode_and_newline(self):
        original = message("event", sender="bob", body={"content": "Hi 🌍\nNext line"})
        self.assertEqual(unmarshal(marshal(original)), original)

    def test_message_is_delimited(self):
        packed = marshal(message("request", body={"operation": "meeting_info"}))
        self.assertEqual(packed.count(b"\n"), 1)
        self.assertTrue(packed.endswith(b"\n"))

    def test_malformed_data_rejected(self):
        for bad in (b"no newline", b"{bad}\n", b"[]\n", b"{}\n", b"\xff\n",
                    b"{\"type\":\"x\"}" + b"x" * MAX_MESSAGE_BYTES + b"\n"):
            with self.subTest(bad=bad[:10]):
                with self.assertRaises(ValueError):
                    unmarshal(bad)

    def test_oversize_outgoing_rejected(self):
        with self.assertRaises(ValueError):
            marshal(message("publish", body={"content": "x" * MAX_MESSAGE_BYTES}))


if __name__ == "__main__":
    unittest.main()
