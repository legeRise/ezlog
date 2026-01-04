import os
import sys
import asyncio
from pathlib import Path
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse
import json


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
        with open(filepath, "r", errors='replace') as f:
            # 1. Send History (Last 5MB)
            f.seek(0, 2)
            size = f.tell()
            start_pos = max(0, size - (5 * 1024 * 1024))
            f.seek(start_pos)
            if start_pos > 0: f.readline() # Discard partial line

            # Read history in chunks
            chunk = []
            while True:
                pos = f.tell()
                line = f.readline()
                if not line:
                    f.seek(pos)
                    break
                chunk.append(line.rstrip())
                if len(chunk) >= 200:
                    await ws.send_text(json.dumps({"type": "log_batch", "data": chunk}))
                    chunk = []
                    await asyncio.sleep(0) # Yield control
            
            if chunk:
                await ws.send_text(json.dumps({"type": "log_batch", "data": chunk}))

            # Marker
            await ws.send_text(json.dumps({"type": "sys", "msg": "__LIVE_START__"}))

            # 2. Live Tailing with Batching
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
