"""A loopback-only HTTP interface with fixed routes and bounded requests."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import socket
import sqlite3
import threading
import time
from urllib.parse import parse_qs, urlsplit

from . import __version__
from .images import MAX_UPLOAD, inspect_image
from .storage import MAX_BOARDS, MAX_DESIGNS, Problem, Store, request_deadline

ID = r"[a-f0-9]{32}"
STATIC = {"/": ("index.html", "text/html; charset=utf-8"),
          "/app.css": ("app.css", "text/css; charset=utf-8"),
          "/app.js": ("app.js", "text/javascript; charset=utf-8")}
ROOT = Path(__file__).resolve().parent / "static"


class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 8

    def __init__(self, port, directory):
        self.store = Store(directory)
        self.csrf = secrets.token_hex(32)
        self.slots = threading.BoundedSemaphore(4)
        self.export_slot = threading.BoundedSemaphore(1)
        self.request_timeout = 10
        super().__init__(("127.0.0.1", port), Handler)
        self.origin = f"http://127.0.0.1:{self.server_port}"

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            try:
                request.settimeout(1)
                request.sendall(b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            except OSError:
                pass
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        expires = time.monotonic() + self.request_timeout
        def expire():
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        deadline = threading.Timer(self.request_timeout, expire)
        deadline.daemon = True
        deadline.start()
        try:
            with request_deadline(expires):
                super().process_request_thread(request, client_address)
        finally:
            deadline.cancel()
            self.slots.release()

    def handle_error(self, request, client_address):
        pass  # Never log user comments, upload paths or request bodies.


class Handler(BaseHTTPRequestHandler):
    server_version = f"DraftTable/{__version__}"
    sys_version = ""
    protocol_version = "HTTP/1.0"

    def setup(self):
        super().setup()
        self.connection.settimeout(2)

    def log_message(self, format, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.respond(code, {"error": "This request is not supported."})

    def respond(self, status, content, mime="application/json; charset=utf-8", download=None):
        if not isinstance(content, (bytes, bytearray, memoryview)):
            content = json.dumps(content, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; "
                         "img-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
        self.send_header("Connection", "close")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)
        self.close_connection = True

    def guard(self, mutation=False):
        if len(self.path) > 2048 or "\\" in self.path:
            raise Problem("Request path is too long or invalid.")
        if len(self.headers) > 50 or sum(len(key) + len(value) for key, value in self.headers.items()) > 16_384:
            raise Problem("Request headers are too large.", 431)
        if any("\r" in value or "\n" in value for value in self.headers.values()):
            raise Problem("Folded request headers are not supported.")
        if self.headers.get_all("Host", []) != [self.server.origin.removeprefix("http://")]:
            raise Problem("Open this app using its printed 127.0.0.1 address.", 403)
        origins = self.headers.get_all("Origin", [])
        if origins and origins != [self.server.origin]:
            raise Problem("Cross-origin requests are not allowed.", 403)
        if self.headers.get("Sec-Fetch-Site") not in (None, "none", "same-origin"):
            raise Problem("Cross-site requests are not allowed.", 403)
        if self.headers.get_all("Transfer-Encoding") or self.headers.get_all("Expect"):
            raise Problem("Unsupported request framing.")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1 or (lengths and re.fullmatch(r"[0-9]{1,9}", lengths[0]) is None):
            raise Problem("Invalid content length.")
        if self.command == "DELETE" and lengths and int(lengths[0]) != 0:
            raise Problem("Delete requests must not contain data.")
        if mutation:
            if origins != [self.server.origin] or self.headers.get_all("X-CSRF-Token", []) != [self.server.csrf]:
                raise Problem("Reload this page before making changes.", 403)
            if not lengths and self.command != "DELETE":
                raise Problem("A content length is required.", 411)
        elif lengths and lengths != ["0"]:
            raise Problem("This request must not contain a body.")
        parts = urlsplit(self.path)
        if parts.scheme or parts.netloc or parts.fragment or "%" in parts.path:
            raise Problem("Invalid request path.")
        try:
            query = parse_qs(parts.query, keep_blank_values=True, strict_parsing=True,
                             encoding="utf-8", errors="strict", max_num_fields=2)
        except (ValueError, UnicodeError) as error:
            raise Problem("Invalid query.") from error
        if any(len(value) != 1 for value in query.values()):
            raise Problem("Repeated query values are not supported.")
        return parts.path, {key: value[0] for key, value in query.items()}

    def body(self, maximum):
        length = int(self.headers.get("Content-Length", "0"))
        if length > maximum:
            raise Problem("That request is too large.", 413)
        deadline = time.monotonic() + 8
        chunks, remaining = [], length
        while remaining:
            available = deadline - time.monotonic()
            if available <= 0:
                raise Problem("The upload took too long. Please try again.", 408)
            self.connection.settimeout(min(2, available))
            try:
                chunk = self.rfile.read1(min(remaining, 65_536))
            except (socket.timeout, OSError) as error:
                raise Problem("The upload stopped before it finished.", 408) from error
            if not chunk:
                raise Problem("Incomplete request body.")
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)

    def object(self, allowed):
        if self.headers.get("Content-Type", "").split(";", 1)[0].strip() != "application/json":
            raise Problem("Send JSON for this action.", 415)
        def unique(pairs):
            result = {}
            for key, value in pairs:
                if key in result:
                    raise ValueError("Duplicate key")
                result[key] = value
            return result
        try:
            result = json.loads(self.body(16_384).decode("utf-8"), object_pairs_hook=unique,
                                parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite number")))
        except (UnicodeError, ValueError) as error:
            raise Problem("The request must contain a valid JSON object.") from error
        if not isinstance(result, dict) or set(result) - allowed:
            raise Problem("This action contains unsupported fields.")
        return result

    def handle_action(self, mutation=False):
        try:
            path, query = self.guard(mutation)
            self.route(path, query)
        except Problem as error:
            self.respond(error.status, {"error": str(error)})
        except (BrokenPipeError, ConnectionResetError, socket.timeout):
            self.close_connection = True
        except sqlite3.Error:
            self.respond(503, {"error": "Local storage is busy or unavailable. Try again."})
        except OSError:
            self.respond(503, {"error": "A local file is unavailable. Check the app folder and try again."})
        except (ValueError, RecursionError):
            self.respond(400, {"error": "This request could not be read."})

    def do_GET(self):
        self.handle_action()

    def do_POST(self):
        self.handle_action(True)

    def do_PATCH(self):
        self.handle_action(True)

    def do_DELETE(self):
        self.handle_action(True)

    def do_OPTIONS(self):
        self.respond(405, {"error": "Cross-origin access is not supported."})

    def route(self, path, query):
        method, store = self.command, self.server.store
        if query and not ((method == "GET" and path == "/api/export") or
                          (method == "POST" and re.fullmatch(rf"/api/boards/{ID}/designs", path))):
            raise Problem("This route does not accept query values.")
        if method == "GET":
            if path in STATIC:
                name, mime = STATIC[path]
                self.respond(200, (ROOT / name).read_bytes(), mime)
                return
            if path == "/api/state":
                state = store.state()
                state.update(csrf=self.server.csrf, limits={"upload_bytes": MAX_UPLOAD,
                             "max_designs": MAX_DESIGNS, "max_boards": MAX_BOARDS})
                self.respond(200, state)
                return
            match = re.fullmatch(rf"/media/({ID})", path)
            if match:
                image, mime = store.image(match[1])
                self.respond(200, image, mime)
                return
            if path == "/api/export":
                if set(query) - {"board"}:
                    raise Problem("Choose a board or export the workspace.")
                board = query.get("board")
                if board is not None and re.fullmatch(ID, board) is None:
                    raise Problem("Choose an existing board.")
                if not self.server.export_slot.acquire(blocking=False):
                    raise Problem("Another export is in progress. Try again shortly.", 429)
                try:
                    self.respond(200, store.export(board), "application/zip", "draft-table-export.zip")
                finally:
                    self.server.export_slot.release()
                return
        elif method == "POST":
            if path == "/api/boards":
                self.respond(201, {"board": store.add_board(self.object({"title"}).get("title"))})
                return
            match = re.fullmatch(rf"/api/boards/({ID})/designs", path)
            if match:
                if set(query) - {"title"}:
                    raise Problem("Only a design name can be supplied with an image.")
                image = self.body(MAX_UPLOAD)
                try:
                    details = inspect_image(image, self.headers.get("Content-Type", ""))
                except ValueError as error:
                    raise Problem(str(error), 415) from error
                self.respond(201, {"design": store.add_design(match[1], query.get("title", "Untitled design"), image, details)})
                return
            match = re.fullmatch(rf"/api/designs/({ID})/comments", path)
            if match:
                data = self.object({"text", "parent_id"})
                self.respond(201, {"comment": store.add_comment(match[1], data.get("text"), data.get("parent_id"))})
                return
            if path == "/api/reset":
                if self.object({"confirm"}).get("confirm") != "DELETE ALL LOCAL DATA":
                    raise Problem("Confirm the workspace reset first.")
                store.reset()
                self.respond(200, {"ok": True})
                return
        elif method == "PATCH":
            match = re.fullmatch(rf"/api/boards/({ID})", path)
            if match:
                self.respond(200, {"board": store.rename_board(match[1], self.object({"title"}).get("title"))})
                return
            match = re.fullmatch(rf"/api/designs/({ID})", path)
            if match:
                self.respond(200, {"design": store.update_design(match[1], self.object({"title", "status"}))})
                return
        elif method == "DELETE":
            for table, operation in (("boards", store.delete_board), ("designs", store.delete_design),
                                     ("comments", store.delete_comment)):
                match = re.fullmatch(rf"/api/{table}/({ID})", path)
                if match:
                    operation(match[1])
                    self.respond(200, {"ok": True})
                    return
        raise Problem("That page or action does not exist.", 404)
