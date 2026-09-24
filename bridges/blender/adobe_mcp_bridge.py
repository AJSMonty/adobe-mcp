# adobe-mcp live bridge for Blender.
#
# Install: Edit → Preferences → Add-ons → (dropdown) Install from Disk… → pick this file, then
# enable "adobe-mcp Bridge". It listens on 127.0.0.1:9877 (override with the BLENDER_MCP_PORT
# environment variable before launching Blender) and executes Python sent by the adobe-mcp
# server on Blender's MAIN thread (bpy is not thread-safe), one request at a time.
#
# Protocol: one JSON line in {"code": "..."} → one JSON line out
#   {"ok": true, "result": <value of `result`>, "stdout": "..."}  or
#   {"ok": false, "error": "...", "line": n, "traceback": "..."}
# Localhost only, no auth: anything that can reach the port can run Python in Blender.
# Disable the add-on when you are not using it.

bl_info = {
    "name": "adobe-mcp Bridge",
    "author": "AJ Montgomery",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "Runs in the background (127.0.0.1:9877)",
    "description": "Lets the adobe-mcp MCP server run Python in this Blender session",
    "category": "System",
}

import contextlib
import io
import json
import os
import queue
import socket
import threading
import traceback

import bpy

PORT = int(os.environ.get("BLENDER_MCP_PORT", "9877"))
_requests = queue.Queue()
_server = {"sock": None, "thread": None, "stop": False}


def _execute(code):
    ns = {"__name__": "__adobe_mcp__"}
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            exec(compile(code, "<adobe-mcp>", "exec"), ns)
        return {"ok": True, "result": ns.get("result"), "stdout": out.getvalue()[-8000:]}
    except BaseException as e:
        line = e.lineno if isinstance(e, SyntaxError) and e.filename == "<adobe-mcp>" else None
        for fr in traceback.extract_tb(e.__traceback__):
            if fr.filename == "<adobe-mcp>":
                line = fr.lineno
        return {
            "ok": False,
            "error": "%s: %s" % (type(e).__name__, e),
            "line": line,
            "traceback": traceback.format_exc()[-4000:],
            "stdout": out.getvalue()[-4000:],
        }


def _pump():
    """Timer callback on the main thread: run queued requests."""
    while True:
        try:
            code, reply = _requests.get_nowait()
        except queue.Empty:
            break
        reply(_execute(code))
    return None if _server["stop"] else 0.05


def _serve_client(conn):
    with conn:
        buf = b""
        while b"\n" not in buf:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
        try:
            code = json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))["code"]
        except Exception as e:
            conn.sendall((json.dumps({"ok": False, "error": "Bad request: %s" % e}) + "\n").encode())
            return
        done = threading.Event()
        box = {}

        def reply(res):
            box["res"] = res
            done.set()

        _requests.put((code, reply))
        done.wait()
        conn.sendall((json.dumps(box["res"], default=str) + "\n").encode("utf-8"))


def _accept_loop(sock):
    while not _server["stop"]:
        try:
            conn, _ = sock.accept()
        except OSError:
            break
        threading.Thread(target=_serve_client, args=(conn,), daemon=True).start()


def register():
    _server["stop"] = False
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", PORT))
    sock.listen(4)
    _server["sock"] = sock
    _server["thread"] = threading.Thread(target=_accept_loop, args=(sock,), daemon=True)
    _server["thread"].start()
    bpy.app.timers.register(_pump, persistent=True)
    print("adobe-mcp bridge listening on 127.0.0.1:%d" % PORT)


def unregister():
    _server["stop"] = True
    if _server["sock"]:
        try:
            _server["sock"].close()
        except OSError:
            pass
        _server["sock"] = None
    if bpy.app.timers.is_registered(_pump):
        bpy.app.timers.unregister(_pump)


if __name__ == "__main__":
    register()
