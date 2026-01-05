import os
import sys
import asyncio
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
import json
from collections import deque


def get_file_metadata(filepath):
    """Get file size and line count efficiently"""
    if not os.path.exists(filepath):
        return {"size": 0, "lines": 0, "size_human": "0 B"}
    
    file_size = os.path.getsize(filepath)
    
    # Count lines efficiently
    line_count = 0
    with open(filepath, 'rb') as f:
        for _ in f:
            line_count += 1
    
    # Human-readable size
    if file_size < 1024:
        size_human = f"{file_size} B"
    elif file_size < 1024 * 1024:
        size_human = f"{file_size / 1024:.1f} KB"
    elif file_size < 1024 * 1024 * 1024:
        size_human = f"{file_size / (1024 * 1024):.1f} MB"
    else:
        size_human = f"{file_size / (1024 * 1024 * 1024):.2f} GB"
    
    return {"size": file_size, "lines": line_count, "size_human": size_human}


def tail_file_lines(filepath, n=500):
    """Get the last N lines from a file efficiently"""
    try:
        with open(filepath, 'r', errors='replace') as f:
            return list(deque(f, n))
    except:
        return []


def get_lines_range(filepath, start_line, count):
    """Get a range of lines from a file (1-indexed)"""
    try:
        lines = []
        with open(filepath, 'r', errors='replace') as f:
            for i, line in enumerate(f, 1):
                if i >= start_line and i < start_line + count:
                    lines.append(line.rstrip())
                if i >= start_line + count:
                    break
        return lines
    except:
        return []


def get_resource_path(relative_path):
    """Get absolute path to resource - works for dev and PyInstaller"""
    if getattr(sys, 'frozen', False):
        # Running as compiled executable
        base_path = Path(sys._MEIPASS)
    else:
        # Running in normal Python
        base_path = Path(__file__).parent
    return str(base_path / relative_path)

# --- Load your logs logic ---
try:
    from tracked_logs import load_tracked_logs
except ImportError:
    # Dummy data for testing
    def load_tracked_logs():
        return {f"Project {i}": "test.log" for i in range(1, 50)}

app = FastAPI()

# Mount static files (JS, CSS, Images)
app.mount("/static", StaticFiles(directory=get_resource_path("static")), name="static")
templates = Jinja2Templates(directory=get_resource_path("templates"))

@app.get("/", response_class=HTMLResponse)
async def get_home(request: Request):
    """Serves the UI shell."""
    return templates.TemplateResponse("index.html", {
        "request": request, 
        "aliases_json": json.dumps(load_tracked_logs())
    })

@app.get("/api/logs/{alias}/history")
async def get_log_history(alias: str, direction: str = "up", before_line: int = 0, count: int = 500):
    """Fetch historical log lines for pagination"""
    logs = load_tracked_logs()
    
    if alias not in logs:
        return {"error": "Log alias not found", "lines": []}
    
    filepath = logs[alias]
    
    if not os.path.exists(filepath):
        return {"error": "Log file not found", "lines": []}
    
    metadata = get_file_metadata(filepath)
    total_lines = metadata["lines"]
    
    if direction == "top":
        # Fetch first N lines
        lines = get_lines_range(filepath, 1, count)
        start_line = 1
        end_line = min(count, total_lines)
        has_more = end_line < total_lines
    else:  # direction == "up"
        # Fetch lines before the given line
        if before_line <= 1:
            return {"lines": [], "start_line": 0, "end_line": 0, "has_more": False, "total_lines": total_lines}
        
        start_line = max(1, before_line - count)
        lines = get_lines_range(filepath, start_line, before_line - start_line)
        end_line = before_line - 1
        has_more = start_line > 1
    
    return {
        "lines": lines,
        "start_line": start_line,
        "end_line": end_line,
        "has_more": has_more,
        "total_lines": total_lines
    }

@app.websocket("/ws/{alias}")
async def websocket_endpoint(ws: WebSocket, alias: str):
    await ws.accept()
    logs = load_tracked_logs()
    
    if alias not in logs:
        await ws.send_text(json.dumps({"type": "sys", "msg": f"Error: {alias} not found"}))
        await ws.close()
        return

    filepath = logs[alias]
    
    # Generate dummy file if missing (for testing)
    if not os.path.exists(filepath):
        with open(filepath, "w") as f: f.write("[System] Log file created.\n")

    try:
        # Get file metadata
        metadata = get_file_metadata(filepath)
        await ws.send_text(json.dumps({
            "type": "metadata",
            "size": metadata["size"],
            "lines": metadata["lines"],
            "size_human": metadata["size_human"]
        }))
        
        # Get last 500 lines efficiently
        history_lines = tail_file_lines(filepath, n=500)
        history_lines = [line.rstrip() for line in history_lines]
        
        # Send history in chunks
        chunk_size = 200
        for i in range(0, len(history_lines), chunk_size):
            chunk = history_lines[i:i + chunk_size]
            await ws.send_text(json.dumps({"type": "log_batch", "data": chunk}))
            await asyncio.sleep(0)  # Yield control
        
        # Open file for live tailing
        with open(filepath, "r", errors='replace') as f:
            # Seek to end for live tailing
            f.seek(0, 2)

            # Marker
            await ws.send_text(json.dumps({"type": "sys", "msg": "__LIVE_START__"}))

            # Live Tailing with Batching
            live_buffer = []
            batch_interval = 0.3  # 300ms batching for better performance
            last_send = asyncio.get_event_loop().time()
            
            while True:
                line = f.readline()
                if line:
                    live_buffer.append(line.rstrip())
                    
                    # Send batch if buffer is large or time elapsed
                    current_time = asyncio.get_event_loop().time()
                    if len(live_buffer) >= 50 or (current_time - last_send) >= batch_interval:
                        await ws.send_text(json.dumps({"type": "log_batch", "data": live_buffer}))
                        live_buffer = []
                        last_send = current_time
                else:
                    # No new lines - send any pending buffer and wait
                    if live_buffer:
                        await ws.send_text(json.dumps({"type": "log_batch", "data": live_buffer}))
                        live_buffer = []
                        last_send = asyncio.get_event_loop().time()
                    await asyncio.sleep(0.1)

    except WebSocketDisconnect:
        print(f"Client disconnected: {alias}")

def start(port: int = 9200, host: str = "0.0.0.0"):
    import uvicorn
    uvicorn.run("ezlog:app", host=host, port=port, reload=False)
