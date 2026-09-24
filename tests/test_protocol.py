"""Unit tests for the newline-delimited JSON helpers in common.py (no network)."""

import io
import unittest

from common import ProtocolError, read_json, write_json
from tests.support import ROOT  # noqa: F401  (puts the project root on sys.path)


class WriteJsonTests(unittest.TestCase):
    def test_writes_one_line_ending_in_newline(self) -> None:
        buf = io.BytesIO()
        write_json(buf, {"text": "line one\nline two\nline three"})

        data = buf.getvalue()
        self.assertTrue(data.endswith(b"\n"))
        # The newline inside the text is escaped, so only the terminator is a raw newline.
        self.assertEqual(data.count(b"\n"), 1)

    def test_round_trip(self) -> None:
        buf = io.BytesIO()
        message = {"type": "JOIN_MEETING", "user": "Jojo", "meeting_id": "demo-room"}
        write_json(buf, message)
        buf.seek(0)

        self.assertEqual(read_json(buf), message)


class ReadJsonTests(unittest.TestCase):
    def test_reads_consecutive_messages_from_one_reader(self) -> None:
        # Two messages arriving together: the reader's buffer keeps the second one.
        rfile = io.BytesIO(b'{"id": 1}\n{"id": 2}\n')

        self.assertEqual(read_json(rfile), {"id": 1})
        self.assertEqual(read_json(rfile), {"id": 2})

    def test_empty_stream_means_peer_closed(self) -> None:
        with self.assertRaises(ConnectionError):
            read_json(io.BytesIO(b""))

    def test_rejects_invalid_json(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "not valid JSON"):
            read_json(io.BytesIO(b"not json\n"))

    def test_rejects_invalid_utf8(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "not valid UTF-8"):
            read_json(io.BytesIO(b"\xff\xfe\n"))

    def test_rejects_non_object(self) -> None:
        with self.assertRaisesRegex(ProtocolError, "expected a JSON object"):
            read_json(io.BytesIO(b"[1, 2]\n"))


if __name__ == "__main__":
    unittest.main()
