"""Local SQLite storage; images and their records share one atomic transaction."""

from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import secrets
import sqlite3
import threading
import time
import zipfile

MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_BOARDS, MAX_DESIGNS, MAX_COMMENTS = 20, 100, 1000
_deadline = ContextVar("draft_table_request_deadline", default=None)


class Problem(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


@contextmanager
def request_deadline(expires):
    token = _deadline.set(expires)
    try:
        yield
    finally:
        _deadline.reset(token)


def storage_timeout():
    expires = _deadline.get()
    remaining = 3 if expires is None else expires - time.monotonic()
    if remaining <= 0:
        raise Problem("This request expired before it could be saved. Reload before trying again.", 408)
    return min(3, remaining)


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def text(value, maximum, label):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= maximum:
        raise Problem(f"{label} must contain 1–{maximum} characters.")
    if any(ord(character) < 32 and character not in "\t\r\n" for character in value):
        raise Problem(f"{label} contains unsupported control characters.")
    return value.strip()


class Store:
    def __init__(self, directory):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = directory / "reviews.sqlite3"
        if self.path.is_symlink():
            raise ValueError("The local database must not be a symbolic link.")
        self.lock = threading.RLock()
        with self.connection() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS boards(
                    id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS designs(
                    id TEXT PRIMARY KEY, board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
                    title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL,
                    mime TEXT NOT NULL, extension TEXT NOT NULL, width INTEGER NOT NULL,
                    height INTEGER NOT NULL, bytes INTEGER NOT NULL, image BLOB NOT NULL);
                CREATE TABLE IF NOT EXISTS comments(
                    id TEXT PRIMARY KEY, design_id TEXT NOT NULL REFERENCES designs(id) ON DELETE CASCADE,
                    parent_id TEXT REFERENCES comments(id) ON DELETE CASCADE,
                    text TEXT NOT NULL, created_at TEXT NOT NULL);
            """)
            if not db.execute("SELECT 1 FROM boards").fetchone():
                db.execute("INSERT INTO boards VALUES(?,?,?)", (secrets.token_hex(16), "First board", now()))
        try:
            self.path.chmod(0o600)
        except OSError:
            pass  # Windows inherits directory permissions; see the trusted-local boundary.

    @contextmanager
    def connection(self):
        if not self.lock.acquire(timeout=storage_timeout()):
            storage_timeout()  # Report an expired request separately from ordinary contention.
            raise Problem("Local storage is busy. Try again shortly.", 503)
        try:
            db = sqlite3.connect(self.path, timeout=storage_timeout())
            try:
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA foreign_keys=ON")
                db.execute("BEGIN IMMEDIATE")
                with db:
                    storage_timeout()
                    yield db
                    # Expired work must roll back, even if the socket has already closed.
                    timeout_ms = max(1, int(storage_timeout() * 1000))
                    db.execute(f"PRAGMA busy_timeout={timeout_ms}")
            finally:
                db.close()
        finally:
            self.lock.release()

    @staticmethod
    def require(db, table, identifier):
        # Table is selected by internal callers, never supplied by a request.
        columns = "id,board_id,title,status,created_at,mime,extension,width,height,bytes" if table == "designs" else "*"
        row = db.execute(f"SELECT {columns} FROM {table} WHERE id=?", (identifier,)).fetchone()
        if row is None:
            raise Problem("That item no longer exists.", 404)
        return row

    @staticmethod
    def design(db, identifier):
        row = Store.require(db, "designs", identifier)
        result = {key: row[key] for key in ("id", "board_id", "title", "status", "created_at", "width", "height", "bytes")}
        result["image_url"] = "/media/" + identifier
        result["comments"] = [dict(item) for item in db.execute(
            "SELECT id,parent_id,text,created_at FROM comments WHERE design_id=? ORDER BY rowid", (identifier,))]
        return result

    @staticmethod
    def read_state(db):
        return {"boards": [dict(row) for row in db.execute("SELECT * FROM boards ORDER BY rowid")],
                "designs": [Store.design(db, row[0]) for row in db.execute("SELECT id FROM designs ORDER BY rowid DESC")]}

    def state(self):
        with self.connection() as db:
            return self.read_state(db)

    def add_board(self, title):
        title = text(title, 100, "Board name")
        with self.connection() as db:
            if db.execute("SELECT COUNT(*) FROM boards").fetchone()[0] >= MAX_BOARDS:
                raise Problem("This workspace has reached its 20-board limit.", 429)
            identifier = secrets.token_hex(16)
            db.execute("INSERT INTO boards VALUES(?,?,?)", (identifier, title, now()))
            return dict(self.require(db, "boards", identifier))

    def rename_board(self, identifier, title):
        title = text(title, 100, "Board name")
        with self.connection() as db:
            self.require(db, "boards", identifier)
            db.execute("UPDATE boards SET title=? WHERE id=?", (title, identifier))
            return dict(self.require(db, "boards", identifier))

    def delete_board(self, identifier):
        with self.connection() as db:
            self.require(db, "boards", identifier)
            db.execute("DELETE FROM boards WHERE id=?", (identifier,))

    def add_design(self, board, title, image, details):
        title = text(title, 100, "Design name")
        mime, extension, width, height = details
        with self.connection() as db:
            self.require(db, "boards", board)
            count, total = db.execute("SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM designs").fetchone()
            if count >= MAX_DESIGNS or total + len(image) > MAX_TOTAL_BYTES:
                raise Problem("Workspace full: export or delete designs before adding more (100 designs / 64 MiB).", 429)
            identifier = secrets.token_hex(16)
            db.execute("INSERT INTO designs VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                       (identifier, board, title, "exploring", now(), mime, extension, width, height, len(image), image))
            return self.design(db, identifier)

    def update_design(self, identifier, changes):
        if not changes or set(changes) - {"title", "status"}:
            raise Problem("Change the design name or its status.")
        if "title" in changes:
            changes["title"] = text(changes["title"], 100, "Design name")
        if "status" in changes and changes["status"] not in ("exploring", "shortlisted", "approved"):
            raise Problem("Choose exploring, shortlisted or approved.")
        with self.connection() as db:
            self.require(db, "designs", identifier)
            for key, value in changes.items():
                db.execute(f"UPDATE designs SET {key}=? WHERE id=?", (value, identifier))
            return self.design(db, identifier)

    def delete_design(self, identifier):
        with self.connection() as db:
            self.require(db, "designs", identifier)
            db.execute("DELETE FROM designs WHERE id=?", (identifier,))

    def add_comment(self, design, content, parent):
        content = text(content, 2000, "Feedback")
        with self.connection() as db:
            self.require(db, "designs", design)
            if parent is not None:
                if not isinstance(parent, str):
                    raise Problem("Choose an existing feedback thread.")
                thread = self.require(db, "comments", parent)
                if thread["design_id"] != design or thread["parent_id"] is not None:
                    raise Problem("Replies must belong to a top-level thread on this design.")
            if db.execute("SELECT COUNT(*) FROM comments").fetchone()[0] >= MAX_COMMENTS:
                raise Problem("Workspace full: export or remove feedback before adding more.", 429)
            identifier = secrets.token_hex(16)
            db.execute("INSERT INTO comments VALUES(?,?,?,?,?)", (identifier, design, parent, content, now()))
            return {key: self.require(db, "comments", identifier)[key] for key in ("id", "parent_id", "text", "created_at")}

    def delete_comment(self, identifier):
        with self.connection() as db:
            self.require(db, "comments", identifier)
            db.execute("DELETE FROM comments WHERE id=?", (identifier,))

    def image(self, identifier):
        with self.connection() as db:
            self.require(db, "designs", identifier)
            row = db.execute("SELECT image,mime FROM designs WHERE id=?", (identifier,)).fetchone()
            return row["image"], row["mime"]

    def export(self, board=None):
        with self.connection() as db:
            if board is not None:
                self.require(db, "boards", board)
            state = self.read_state(db)
            if board is not None:
                state["boards"] = [item for item in state["boards"] if item["id"] == board]
                state["designs"] = [item for item in state["designs"] if item["board_id"] == board]
            state.update(format="draft-table-v1", exported_at=now())
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_STORED) as archive:
                for design in state["designs"]:
                    row = db.execute("SELECT image,extension FROM designs WHERE id=?", (design["id"],)).fetchone()
                    name = "images/" + design["id"] + "." + row["extension"]
                    archive.writestr(name, row["image"])
                    design["image_file"] = name
                    del design["image_url"]
                archive.writestr("review.json", json.dumps(state, ensure_ascii=False, indent=2))
            return output.getbuffer()

    def reset(self):
        with self.connection() as db:
            db.execute("DELETE FROM boards")
            db.execute("INSERT INTO boards VALUES(?,?,?)", (secrets.token_hex(16), "First board", now()))
