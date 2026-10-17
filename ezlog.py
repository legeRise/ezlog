import os
import sys
import json
import asyncio
import re
import threading
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, FileResponse, Response

from version import __version__ as EZLOG_VERSION
from tailer import LogFile, TailHub, human_size

# --- Load your logs logic ---
try:
    from tracked_logs import load_tracked_logs, group_logs_by_project
except ImportError:
    # Dummy data for testing
    def load_tracked_logs():
        return {f"Project {i}": "test.log" for i in range(1, 50)}
    def group_logs_by_project(data):
        return {"_root": {k: {"alias": k, "path": v} for k, v in data.items()}}


def get_resource_path(relative_path):
    """Get absolute path to resource - works for dev and PyInstaller"""
    if getattr(sys, 'frozen', False):
        # Running as compiled executable
        base_path = Path(sys._MEIPASS)
    else:
        # Running in normal Python
        base_path = Path(__file__).parent
    return str(base_path / relative_path)


app = FastAPI()

# Mount static files (JS, CSS, Images)
app.mount("/static", StaticFiles(directory=get_resource_path("static")), name="static")
templates = Jinja2Templates(directory=get_resource_path("templates"))

# One cached LogFile per path, shared across requests.
_log_files: dict[str, LogFile] = {}
_log_files_lock = threading.Lock()

# One polling tailer per file, fanning new lines out to every watcher.
hub = TailHub()


def get_log_file(filepath: str) -> LogFile:
    with _log_files_lock:
        lf = _log_files.get(filepath)
        if lf is None:
            lf = LogFile(filepath)
            _log_files[filepath] = lf
        return lf


@app.get("/", response_class=HTMLResponse)
async def get_home(request: Request):
    """Serves the UI shell."""
    logs = load_tracked_logs()
    groups = group_logs_by_project(logs)
    return templates.TemplateResponse(request, "index.html", {
        "aliases_json": json.dumps(logs),
        "groups_json": json.dumps(groups),
        "initial_alias": "",
        "version": EZLOG_VERSION
    })


@app.get("/logs/{alias}", response_class=HTMLResponse)
async def get_log_page(request: Request, alias: str):
    """Serves the UI shell with an initial alias from route"""
    logs = load_tracked_logs()
    groups = group_logs_by_project(logs)
    initial_alias = alias if alias in logs else ""
    return templates.TemplateResponse(request, "index.html", {
        "aliases_json": json.dumps(logs),
        "groups_json": json.dumps(groups),
        "initial_alias": initial_alias,
        "version": EZLOG_VERSION
    })


@app.get("/api/logs/{alias}/history")
async def get_log_history(
    alias: str,
    direction: str = "up",
    before_line: int = 0,
    around_line: int = 0,
    after_line: int = 0,
    count: int = 500
):
    """Fetch historical log lines for pagination"""
    logs = load_tracked_logs()

    if alias not in logs:
        return {"error": "Log alias not found", "lines": []}

    filepath = logs[alias]

    if not os.path.exists(filepath):
        return {"error": "Log file not found", "lines": []}

    lf = get_log_file(filepath)
    count = max(1, min(count, 5000))
    total_lines = await asyncio.to_thread(lambda: lf.metadata()["lines"])

    if direction == "top":
        lines = await asyncio.to_thread(lf.read_range, 1, count)
        start_line = 1
        end_line = len(lines)
        has_more = end_line < total_lines
    elif direction == "around":
        if around_line <= 0:
            return {"error": "around_line is required", "lines": []}
        half = max(1, count // 2)
        start_line = max(1, around_line - half)
        lines = await asyncio.to_thread(lf.read_range, start_line, count)
        end_line = min(total_lines, start_line + len(lines) - 1)
        has_more = start_line > 1 or end_line < total_lines
    elif direction == "down":
        # The lines that come *after* after_line. This is what lets you scroll
        # back down after jumping to the top of a huge file — without it, the
        # window could only ever grow backwards.
        if total_lines and after_line >= total_lines:
            return {"lines": [], "start_line": after_line, "end_line": after_line,
                    "has_more": False, "total_lines": total_lines}
        start_line = max(1, after_line + 1)
        lines = await asyncio.to_thread(lf.read_range, start_line, count)
        end_line = start_line + len(lines) - 1 if lines else after_line
        has_more = end_line < total_lines
    else:  # direction == "up"
        if before_line <= 1:
            return {"lines": [], "start_line": 0, "end_line": 0, "has_more": False, "total_lines": total_lines}
        start_line = max(1, before_line - count)
        lines = await asyncio.to_thread(lf.read_range, start_line, before_line - start_line)
        end_line = before_line - 1
        has_more = start_line > 1

    return {
        "lines": lines,
        "start_line": start_line,
        "end_line": end_line,
        "has_more": has_more,
        "total_lines": total_lines
    }


@app.get("/api/logs/{alias}/search")
async def search_log(alias: str, q: str, limit: int = 200):
    """Search full log file content (not just currently loaded chunk)"""
    logs = load_tracked_logs()

    if alias not in logs:
        return {"error": "Log alias not found", "matches": []}

    filepath = logs[alias]

    if not os.path.exists(filepath):
        return {"error": "Log file not found", "matches": []}

    q = (q or "").strip()
    if not q:
        return {"error": "Search query cannot be empty", "matches": []}

    limit = max(1, min(limit, 1000))
    lf = get_log_file(filepath)
    matches = await asyncio.to_thread(lf.search, q, limit)

    return {
        "query": q,
        "matches": matches,
        "count": len(matches),
        "limit": limit,
        "truncated": len(matches) >= limit
    }


# --- Sidebar health / recent-level snapshot -------------------------------
STATUS_WINDOW = 64 * 1024  # bytes of tail scanned per alias

_LEVEL_ERROR_RE = re.compile(rb"\b(?:ERROR|ERR|CRITICAL|FATAL|PANIC)\b", re.IGNORECASE)
_LEVEL_WARN_RE = re.compile(rb"\b(?:WARN|WARNING)\b", re.IGNORECASE)


def _recent_level_counts(path: str, window: int = STATUS_WINDOW) -> tuple[int, int]:
    """Count ERROR/WARN markers in the last `window` bytes of a file.

    Reads a bounded tail window instead of scanning the whole file, so polling
    this stays cheap even for very large, actively written logs.
    """
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            start = max(0, size - window)
            f.seek(start)
            data = f.read()
    except OSError:
        return 0, 0
    if start > 0:
        nl = data.find(b"\n")
        data = data[nl + 1:] if nl != -1 else data
    return len(_LEVEL_ERROR_RE.findall(data)), len(_LEVEL_WARN_RE.findall(data))


@app.get("/api/status")
async def logs_status(sample_bytes: int = STATUS_WINDOW):
    """Per-alias health plus recent ERROR/WARN counts, for the sidebar."""
    logs = load_tracked_logs()
    window = max(4096, min(sample_bytes, 1 << 20))

    def build() -> dict:
        out = {}
        for alias, filepath in logs.items():
            rec = {"exists": False, "errors": 0, "warnings": 0}
            try:
                st = os.stat(filepath)
            except OSError:
                out[alias] = rec
                continue
            rec.update(
                exists=True,
                size=st.st_size,
                size_human=human_size(st.st_size),
                modified=int(st.st_mtime),
            )
            rec["errors"], rec["warnings"] = _recent_level_counts(filepath, window)
            out[alias] = rec
        return out

    return {"logs": await asyncio.to_thread(build)}


@app.get("/api/logs/{alias}/download")
async def download_log(alias: str, start: int = 0, end: int = 0):
    """Download the full monitored log, or a 1-indexed inclusive line range."""
    logs = load_tracked_logs()

    if alias not in logs:
        return {"error": "Log alias not found"}

    filepath = logs[alias]

    if not os.path.exists(filepath):
        return {"error": "Log file not found"}

    filename = Path(filepath).name or f"{alias}.log"

    # No range requested: stream the file as-is (unchanged behavior).
    if start <= 0 and end <= 0:
        return FileResponse(filepath, filename=filename, media_type="text/plain")

    lf = get_log_file(filepath)
    total = await asyncio.to_thread(lambda: lf.metadata()["lines"])
    start = max(1, start or 1)
    end = min(total, end or total)
    if end < start:
        return {"error": "Empty range"}

    # Cap a single ranged read so one request cannot load an unbounded slice.
    end = min(end, start + 50000 - 1)
    lines = await asyncio.to_thread(lf.read_range, start, end - start + 1)
    body = "".join(f"{line}\n" for line in lines)
    stem = Path(filepath).stem or alias
    ranged_name = f"{stem}_L{start}-{end}.log"
    return Response(
        content=body,
        media_type="text/plain",
        headers={"Content-Disposition": f'attachment; filename="{ranged_name}"'},
    )


@app.websocket("/ws/{alias}")
async def websocket_endpoint(ws: WebSocket, alias: str):
    await ws.accept()
    logs = load_tracked_logs()

    if alias not in logs:
        await ws.send_text(json.dumps({"type": "sys", "msg": f"Error: {alias} not found"}))
        await ws.close()
        return

    filepath = logs[alias]
    lf = get_log_file(filepath)

    try:
        # File metadata (cached; only scans new bytes)
        meta = await asyncio.to_thread(lf.metadata)
        await ws.send_text(json.dumps({
            "type": "metadata",
            "size": meta["size"],
            "lines": meta["lines"],
            "size_human": meta["size_human"],
            "missing": meta["missing"],
            "last_modified": meta["last_modified"]
        }))

        # Last 500 lines, in chunks (kept identical to the old contract)
        if not meta["missing"]:
            history = await asyncio.to_thread(lf.tail_lines, 500)
            history = [line.rstrip("\r\n") for line in history]
            for i in range(0, len(history), 200):
                await ws.send_text(json.dumps({"type": "log_batch", "data": history[i:i + 200]}))
                await asyncio.sleep(0)

        # Live tail: subscribe before announcing LIVE_START so that any line
        # written right after the client sees the marker is not missed.
        task, queue = hub.subscribe(filepath)
        try:
            await ws.send_text(json.dumps({"type": "sys", "msg": "__LIVE_START__"}))
            while True:
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=15)
                except asyncio.TimeoutError:
                    # Idle keepalive; also lets us notice a dropped client.
                    await ws.send_text(json.dumps({"type": "ping"}))
                    continue
                await ws.send_text(json.dumps(msg))
        finally:
            hub.unsubscribe(filepath, task, queue)

    except WebSocketDisconnect:
        print(f"Client disconnected: {alias}")
    except Exception as e:
        print(f"WebSocket error ({alias}): {e}")
        try:
            await ws.close()
        except Exception:
            pass


def start(port: int = 9200, host: str = "0.0.0.0"):
    import uvicorn
    uvicorn.run("ezlog:app", host=host, port=port, reload=False)
