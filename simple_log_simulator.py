import json
import time
from pathlib import Path
import random
from datetime import datetime

# Path to tracked_logs.json (same as in tracked_logs.py)
APP_DIR = Path.home() / ".ezviewer"
TRACKED_LOGS_FILE = APP_DIR / "tracked_logs.json"

def load_tracked_logs():
    if not TRACKED_LOGS_FILE.exists():
        return {}
    with open(TRACKED_LOGS_FILE, "r") as f:
        return json.load(f)

def simulate_logs(interval=1):
    print("Starting dummy log simulator...")
    while True:
        tracked = load_tracked_logs()
        if not tracked:
            print("No tracked logs found. Waiting...")
            time.sleep(interval)
            continue

        for alias, path in tracked.items():
            try:
                Path(path).parent.mkdir(parents=True, exist_ok=True)  # make sure folder exists
                with open(path, "a") as f:
                    log_line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {alias}: dummy log entry {random.randint(1,1000)}\n"
                    f.write(log_line)
            except Exception as e:
                print(f"Error writing to {alias}: {e}")
        time.sleep(interval)

if __name__ == "__main__":
    simulate_logs()
