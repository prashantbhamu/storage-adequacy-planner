"""Entry point of the packaged Windows app.

Starts the planner on this computer, opens it in the default browser and keeps
running until the console window is closed. Uses port 8765 when it is free,
otherwise any free port, so a second copy or another program cannot block it.
PLANNER_PORT picks the port and PLANNER_NO_BROWSER=1 skips the browser (used by
the automated check of each release build).
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import webbrowser

import uvicorn

from backend.main import app

HOST = "127.0.0.1"
PREFERRED_PORT = 8765


def free_port() -> int:
    for port in (PREFERRED_PORT, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            try:
                probe.bind((HOST, port))
            except OSError:
                continue
            return probe.getsockname()[1]
    raise RuntimeError("No free local port was found.")


def main() -> None:
    port = int(os.environ.get("PLANNER_PORT") or free_port())
    url = f"http://{HOST}:{port}"
    print("Storage Adequacy Planner")
    print(f"Running on this computer at {url}")
    print("Your data stays on this computer. Close this window to stop the planner.")
    if not os.environ.get("PLANNER_NO_BROWSER"):
        timer = threading.Timer(1.5, webbrowser.open, args=(url,))
        timer.daemon = True
        timer.start()
    uvicorn.run(app, host=HOST, port=port, log_level="warning")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # keep the window open so the message can be read
        print(f"\nThe planner could not start: {error}")
        input("Press Enter to close this window.")
        sys.exit(1)
