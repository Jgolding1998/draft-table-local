import argparse
from pathlib import Path

from .server import Server


def main():
    parser = argparse.ArgumentParser(description="Review design images on this computer. No account or external service.")
    parser.add_argument("--port", type=int, default=18741, help="Local port (default: 18741)")
    parser.add_argument("--data-dir", type=Path, default=Path("data"), help="Local storage folder (default: ./data)")
    options = parser.parse_args()
    if not 1 <= options.port <= 65535:
        parser.error("Choose a port between 1 and 65535.")
    try:
        server = Server(options.port, options.data_dir)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Could not start local storage/server: {error}\n")
    print(f"Draft Table is ready at {server.origin}\nKeep this terminal open. Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
