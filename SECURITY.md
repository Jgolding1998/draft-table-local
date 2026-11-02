# Security and local trust boundary

Draft Table is a loopback-only application for a trusted computer. It is not a service for untrusted users, LAN access, public hosting or a reverse proxy. There is no login system.

The HTTP server binds only to `127.0.0.1`. It checks the exact Host and Origin and requires a per-process CSRF token for changes. It rejects duplicate or malformed content lengths, transfer encoding, unexpected bodies and unsupported routes. Requests have byte limits, inactivity timeouts, an absolute connection deadline and a four-connection concurrency limit. Large exports have a separate single-export limit.

Static files are served from a fixed three-route allowlist. Images are retrieved by random IDs from SQLite. User-supplied filenames and URL paths are never used to locate files. Uploaded images are stored with their records in a transaction, so deletion cannot remove a different design's image.

Only PNG and JPEG content types are accepted. PNG checks include framing, checksums, dimensions and bounded decompression. JPEG checks include marker framing and dimensions, not a full pixel decode. Image responses use the identified raster MIME type and `nosniff`; active HTML and SVG uploads are rejected. A restrictive content policy blocks external scripts, fonts, frames and connections. Comments are displayed as text rather than HTML.

This does not protect data from software or people who can already read files or issue arbitrary requests as your local computer user. Images keep their original metadata, and exports deliberately include images and comments. SQLite deletion is not a guarantee of forensic erasure. Backups and downloaded exports are under your control.

The project has no runtime third-party dependencies. Tests exercise cross-origin requests, request framing, timeouts, unsafe uploads, path access, persistence, export and cascading deletion. This is a tested boundary, not a claim that all possible security issues have been eliminated.

If you find a security issue, describe the affected version, reproduction steps, and whether it crosses this local trust boundary. Do not include private design files, credentials or other people's data in a public report.
