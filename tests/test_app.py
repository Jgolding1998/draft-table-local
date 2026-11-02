import concurrent.futures
from contextlib import closing, contextmanager
import http.client
import io
import json
from pathlib import Path
import socket
import sqlite3
import struct
import tempfile
import threading
import time
import unittest
from urllib.parse import quote
from unittest.mock import patch
import zipfile
import zlib

from design_review.images import inspect_image, MAX_UPLOAD
from design_review.server import Server
from design_review.storage import Problem, Store, request_deadline


def png(width=4, height=3, trailing=b""):
    def chunk(kind, content):
        return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)) +
            chunk(b"IDAT", zlib.compress(b"".join(b"\0" + b"\x71\x9d\x82" * width for _ in range(height)))) +
            chunk(b"IEND", b"") + trailing)


class AppTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.server = Server(0, cls.directory.name)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port, cls.origin = cls.server.server_port, cls.server.origin
        cls.csrf = cls.server.csrf

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=3)
        cls.directory.cleanup()

    def setUp(self):
        self.server.store.reset()

    def request(self, method, path, payload=None, headers=None, raw=None):
        values = {"Origin": self.origin, "X-CSRF-Token": self.csrf}
        if payload is not None:
            raw = json.dumps(payload).encode()
            values["Content-Type"] = "application/json"
        if headers:
            values.update(headers)
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=4)
        connection.request(method, path, body=raw, headers=values)
        response = connection.getresponse()
        body, result = response.read(), dict(response.getheaders())
        status = response.status
        connection.close()
        if result.get("Content-Type", "").startswith("application/json"):
            body = json.loads(body)
        return status, body, result

    def board(self):
        return self.request("GET", "/api/state")[1]["boards"][0]["id"]

    def upload(self, title="A design", board=None):
        board = board or self.board()
        status, data, _ = self.request("POST", f"/api/boards/{board}/designs?title={quote(title)}",
                                       raw=png(), headers={"Content-Type": "image/png"})
        self.assertEqual(201, status, data)
        return data["design"]

    def wire(self, request):
        with socket.create_connection(("127.0.0.1", self.port), timeout=4) as client:
            client.sendall(request)
            client.shutdown(socket.SHUT_WR)
            output = b""
            while True:
                part = client.recv(8192)
                if not part:
                    break
                output += part
            return output

    def test_round_trip_upload_feedback_status_export_and_delete(self):
        board = self.board()
        design = self.upload("Option one")
        identifier = design["id"]
        self.assertEqual((4, 3), (design["width"], design["height"]))
        self.assertEqual(png(), self.request("GET", design["image_url"])[1])
        message = '<img src=x onerror="alert(1)"> & a useful note'
        status, data, _ = self.request("POST", f"/api/designs/{identifier}/comments", {"text": message})
        self.assertEqual(201, status)
        parent = data["comment"]["id"]
        self.assertEqual(message, data["comment"]["text"])
        self.assertEqual(201, self.request("POST", f"/api/designs/{identifier}/comments",
                                          {"text": "A reply", "parent_id": parent})[0])
        self.assertEqual(200, self.request("PATCH", f"/api/designs/{identifier}", {"status": "shortlisted"})[0])
        state = self.request("GET", "/api/state")[1]
        self.assertEqual("shortlisted", state["designs"][0]["status"])
        self.assertEqual(2, len(state["designs"][0]["comments"]))
        status, archive, headers = self.request("GET", "/api/export?board=" + board)
        self.assertEqual(200, status)
        self.assertIn("attachment", headers["Content-Disposition"])
        with zipfile.ZipFile(io.BytesIO(archive)) as exported:
            review = json.loads(exported.read("review.json"))
            self.assertEqual(message, review["designs"][0]["comments"][0]["text"])
            self.assertEqual(png(), exported.read(review["designs"][0]["image_file"]))
            self.assertTrue(all(".." not in name and not name.startswith("/") for name in exported.namelist()))
        self.assertEqual(200, self.request("DELETE", "/api/comments/" + parent)[0])
        self.assertEqual([], self.request("GET", "/api/state")[1]["designs"][0]["comments"])
        self.assertEqual(200, self.request("DELETE", "/api/designs/" + identifier)[0])
        self.assertEqual(404, self.request("GET", design["image_url"])[0])

    def test_board_crud_and_cascade(self):
        status, data, _ = self.request("POST", "/api/boards", {"title": "New board"})
        self.assertEqual(201, status)
        board = data["board"]["id"]
        self.upload(board=board)
        self.assertEqual(200, self.request("PATCH", "/api/boards/" + board, {"title": "Revised"})[0])
        self.assertEqual(200, self.request("DELETE", "/api/boards/" + board)[0])
        self.assertEqual([], self.request("GET", "/api/state")[1]["designs"])

    def test_origin_host_and_csrf_guards(self):
        cases = [{"Origin": "https://other.invalid"}, {"Origin": "null"}, {"X-CSRF-Token": "bad"},
                 {"Host": "attacker.invalid"}, {"Host": "localhost:" + str(self.port)},
                 {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}]
        for headers in cases:
            with self.subTest(headers=headers):
                self.assertEqual(403, self.request("POST", "/api/boards", {"title": "Blocked"}, headers)[0])
        originless = self.wire(f"POST /api/boards HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nContent-Length: 2\r\n\r\n{{}}".encode())
        self.assertIn(b"403", originless.split(b"\r\n")[0])
        self.assertEqual(403, self.request("GET", "/api/state", headers={"Origin": "https://other.invalid"})[0])

    def test_duplicate_host_and_origin_and_delete_body_are_rejected(self):
        host = f"Host: 127.0.0.1:{self.port}\r\n"
        for headers in (host + host, host + f"Origin: {self.origin}\r\nOrigin: {self.origin}\r\n"):
            response = self.wire(("GET /api/state HTTP/1.1\r\n" + headers + "\r\n").encode())
            self.assertIn(b"403", response.split(b"\r\n")[0])
        design = self.upload()
        self.assertEqual(400, self.request("DELETE", "/api/designs/" + design["id"], raw=b"x")[0])
        self.assertEqual(1, len(self.server.store.state()["designs"]))

    def test_bounded_concurrency_returns_busy_without_mutation(self):
        acquired = 0
        try:
            for _ in range(4):
                self.assertTrue(self.server.slots.acquire(timeout=1))
                acquired += 1
            self.assertEqual(503, self.request("GET", "/api/state")[0])
        finally:
            for _ in range(acquired):
                self.server.slots.release()
        self.assertEqual(200, self.request("GET", "/api/state")[0])

    def test_request_smuggling_and_unbounded_requests_are_rejected(self):
        lines = f"Host: 127.0.0.1:{self.port}\r\nOrigin: {self.origin}\r\nX-CSRF-Token: {self.csrf}\r\n"
        for extra in ("Content-Length: 2\r\nContent-Length: 2\r\n", "Transfer-Encoding: chunked\r\n",
                      "Content-Length: +2\r\n", "Content-Length: 1, 1\r\n", "Expect: 100-continue\r\n"):
            response = self.wire(("POST /api/boards HTTP/1.1\r\n" + lines + extra + "\r\n{}").encode())
            self.assertIn(b"400", response.split(b"\r\n")[0], extra)
        response = self.wire(("POST /api/boards HTTP/1.1\r\n" + lines +
                              "Content-Type: application/json\r\nContent-Length: 999999\r\n\r\n").encode())
        self.assertIn(b"413", response.split(b"\r\n")[0])
        self.assertEqual(400, self.request("GET", "/api/state", raw=b"body")[0])

    def test_body_timeout_releases_connection(self):
        with socket.create_connection(("127.0.0.1", self.port), timeout=4) as client:
            start = time.monotonic()
            client.sendall((f"POST /api/boards HTTP/1.1\r\nHost: 127.0.0.1:{self.port}\r\nOrigin: {self.origin}\r\n"
                            f"X-CSRF-Token: {self.csrf}\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{{").encode())
            self.assertIn(b"408", client.recv(8192).split(b"\r\n")[0])
            self.assertLess(time.monotonic() - start, 3.5)

    def test_absolute_header_deadline_stops_slow_requests(self):
        self.server.request_timeout = 0.3
        try:
            with socket.create_connection(("127.0.0.1", self.port), timeout=2) as client:
                client.sendall(b"GET /api/state HTTP/1.1\r\nHost: ")
                start = time.monotonic()
                self.assertEqual(b"", client.recv(8192))
                self.assertLess(time.monotonic() - start, 1.2)
        finally:
            self.server.request_timeout = 10

    def test_expired_request_waiting_for_storage_does_not_mutate(self):
        self.server.request_timeout = 0.1
        attempted, finished = threading.Event(), threading.Event()
        outcome = {}
        original = self.server.store.add_board
        def tracked(title):
            attempted.set()
            try:
                return original(title)
            finally:
                finished.set()
        def submit():
            try:
                outcome["status"] = self.request("POST", "/api/boards", {"title": "Too late"})[0]
            except (http.client.HTTPException, OSError) as error:
                outcome["error"] = type(error).__name__
        try:
            with patch.object(self.server.store, "add_board", tracked):
                with self.server.store.lock:
                    client = threading.Thread(target=submit)
                    client.start()
                    self.assertTrue(attempted.wait(1))
                    client.join(1)
                    self.assertFalse(client.is_alive(), "The request must expire while storage is blocked.")
                self.assertTrue(finished.wait(1))
            self.assertEqual(1, len(self.server.store.state()["boards"]), outcome)
        finally:
            self.server.request_timeout = 10

    def test_transaction_expiring_before_commit_is_rolled_back(self):
        inserted = False
        with patch("design_review.storage.time.monotonic", return_value=1000) as clock:
            with self.assertRaises(Problem) as expired:
                with request_deadline(1060):
                    with self.server.store.connection() as db:
                        db.execute("INSERT INTO boards VALUES(?,?,?)", ("a" * 32, "Not committed", "2026-01-01"))
                        inserted = True
                        clock.return_value = 1061
        self.assertTrue(inserted, "The transaction must expire after the insert, before commit.")
        self.assertEqual(408, expired.exception.status)
        self.assertEqual(1, len(self.server.store.state()["boards"]))

    def test_expired_request_waiting_for_another_sqlite_connection_does_not_mutate(self):
        self.server.request_timeout = 0.1
        attempted, finished = threading.Event(), threading.Event()
        original = self.server.store.add_board
        def tracked(title):
            attempted.set()
            try:
                return original(title)
            finally:
                finished.set()
        def submit():
            try:
                self.request("POST", "/api/boards", {"title": "Blocked by another connection"})
            except (http.client.HTTPException, OSError):
                pass
        try:
            with patch.object(self.server.store, "add_board", tracked):
                with closing(sqlite3.connect(self.server.store.path)) as blocker:
                    blocker.execute("BEGIN IMMEDIATE")
                    client = threading.Thread(target=submit)
                    client.start()
                    self.assertTrue(attempted.wait(1))
                    client.join(1)
                    self.assertFalse(client.is_alive())
                    # Free the database after the client timed out, then check final state.
                    blocker.rollback()
                    self.assertTrue(finished.wait(1))
            self.assertEqual(1, len(self.server.store.state()["boards"]))
        finally:
            self.server.request_timeout = 10

    def test_jpeg_upload_and_storage_quotas(self):
        sample = Path(__file__).resolve().parents[1] / "examples" / "small-jpeg.jpg"
        status, data, _ = self.request("POST", "/api/boards/" + self.board() + "/designs", raw=sample.read_bytes(),
                                       headers={"Content-Type": "image/jpeg"})
        self.assertEqual(201, status)
        self.assertEqual((8, 6), (data["design"]["width"], data["design"]["height"]))
        with patch("design_review.storage.MAX_DESIGNS", 1):
            self.assertEqual(429, self.request("POST", "/api/boards/" + self.board() + "/designs", raw=png(),
                                              headers={"Content-Type": "image/png"})[0])
        with patch("design_review.storage.MAX_TOTAL_BYTES", 1):
            self.assertEqual(429, self.request("POST", "/api/boards/" + self.board() + "/designs", raw=png(),
                                              headers={"Content-Type": "image/png"})[0])
        self.assertEqual(1, len(self.server.store.state()["designs"]))
        with patch("design_review.storage.MAX_BOARDS", 1):
            self.assertEqual(429, self.request("POST", "/api/boards", {"title": "Another"})[0])

    def test_state_does_not_read_image_blobs(self):
        self.upload()
        original = self.server.store.connection
        @contextmanager
        def metadata_only():
            with original() as db:
                db.set_authorizer(lambda action, table, column, database, trigger:
                                  sqlite3.SQLITE_DENY if action == sqlite3.SQLITE_READ and
                                  table == "designs" and column == "image" else sqlite3.SQLITE_OK)
                yield db
        with patch.object(self.server.store, "connection", metadata_only):
            status, state, _ = self.request("GET", "/api/state")
        self.assertEqual(200, status)
        self.assertEqual(1, len(state["designs"]))

    def test_strict_json_fields_and_titles(self):
        for data in ({"title": ""}, {"title": "x" * 101}, {"title": 3}, {"title": "A", "unknown": True},
                     {"title": "NUL\x00"}, {"title": {"nested": "object"}}):
            self.assertEqual(400, self.request("POST", "/api/boards", data)[0])
        for raw in (b'{"title":"one","title":"two"}', b"[]", b'{"title":NaN}', b"\xff"):
            self.assertEqual(400, self.request("POST", "/api/boards", raw=raw,
                                              headers={"Content-Type": "application/json"})[0])
        self.assertEqual(415, self.request("POST", "/api/boards", raw=b"title=One")[0])

    def test_raster_validation_rejects_active_and_invalid_uploads(self):
        endpoint = "/api/boards/" + self.board() + "/designs"
        for raw, mime in ((b"<svg onload='alert(1)'/>", "image/svg+xml"), (b"<html>text</html>", "image/png"),
                          (png(trailing=b"<script>bad</script>"), "image/png"), (png()[:-4], "image/png"),
                          (png(), "image/jpeg"), (b"\xff\xd8\xff\xd9", "image/jpeg")):
            self.assertEqual(415, self.request("POST", endpoint, raw=raw, headers={"Content-Type": mime})[0])
        corrupt = bytearray(png())
        corrupt[29] ^= 1
        self.assertEqual(415, self.request("POST", endpoint, raw=bytes(corrupt), headers={"Content-Type": "image/png"})[0])
        for width, height in ((9000, 1), (8192, 2048)):
            with self.assertRaises(ValueError):
                inspect_image(png(width, height), "image/png")

    def test_paths_queries_and_secrets_are_not_served(self):
        for path in ("/data/reviews.sqlite3", "/design_review/server.py", "/.git/config", "/media/../x",
                     "/app.js?x=1", "/api/state?x=1", "/api/state?x=1&x=2", "/%2e%2e/data/reviews.sqlite3"):
            self.assertIn(self.request("GET", path)[0], (400, 404))
        _, data, headers = self.request("GET", "/api/state")
        self.assertNotIn("path", data)
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        self.assertEqual("nosniff", headers["X-Content-Type-Options"])
        self.assertIn("frame-ancestors 'none'", headers["Content-Security-Policy"])

    def test_reply_must_be_in_the_same_thread_and_design(self):
        first, second = self.upload(), self.upload()
        parent = self.request("POST", f"/api/designs/{first['id']}/comments", {"text": "Parent"})[1]["comment"]["id"]
        self.assertEqual(400, self.request("POST", f"/api/designs/{second['id']}/comments",
                                          {"text": "Wrong design", "parent_id": parent})[0])
        reply = self.request("POST", f"/api/designs/{first['id']}/comments", {"text": "Reply", "parent_id": parent})[1]["comment"]["id"]
        self.assertEqual(400, self.request("POST", f"/api/designs/{first['id']}/comments",
                                          {"text": "Too deep", "parent_id": reply})[0])

    def test_reset_requires_exact_confirmation_and_keeps_app_usable(self):
        self.upload()
        self.assertEqual(400, self.request("POST", "/api/reset", {"confirm": True})[0])
        self.assertEqual(1, len(self.request("GET", "/api/state")[1]["designs"]))
        self.assertEqual(200, self.request("POST", "/api/reset", {"confirm": "DELETE ALL LOCAL DATA"})[0])
        state = self.request("GET", "/api/state")[1]
        self.assertEqual([], state["designs"])
        self.assertEqual(1, len(state["boards"]))
        self.upload()

    def test_storage_persists_and_updates_are_atomic(self):
        design = self.upload()
        self.assertEqual(design["id"], Store(self.directory.name).state()["designs"][0]["id"])
        board = self.board()
        def add(number):
            return Store(self.directory.name).add_design(board, f"Option {number}", png(), inspect_image(png(), "image/png"))
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
            identifiers = [item["id"] for item in executor.map(add, range(12))]
        self.assertEqual(12, len(set(identifiers)))
        self.assertEqual(13, len(self.server.store.state()["designs"]))


if __name__ == "__main__":
    unittest.main()
