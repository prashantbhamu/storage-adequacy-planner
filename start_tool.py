from __future__ import annotations

import threading
import webbrowser

import uvicorn


HOST = "127.0.0.1"
PORT = 8765


def open_browser() -> None:
    webbrowser.open(f"http://{HOST}:{PORT}")


if __name__ == "__main__":
    timer = threading.Timer(1.2, open_browser)
    timer.daemon = True
    timer.start()
    uvicorn.run("backend.main:app", host=HOST, port=PORT, reload=False)
