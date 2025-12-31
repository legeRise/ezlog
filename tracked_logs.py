import json
import os
from pathlib import Path

# Always use hidden folder in user's home
APP_DIR = Path.home() / ".ezviewer"
TRACKED_LOGS_FILE = APP_DIR / "tracked_logs.json"


def ensure_storage():
    """Ensure the JSON file exists"""
    APP_DIR.mkdir(parents=True, exist_ok=True)
    if not TRACKED_LOGS_FILE.exists():
        TRACKED_LOGS_FILE.write_text("{}")


def load_tracked_logs():
    ensure_storage()
    with open(TRACKED_LOGS_FILE, "r") as f:
        return json.load(f)


def save_tracked_logs(data: dict):
    ensure_storage()
    with open(TRACKED_LOGS_FILE, "w") as f:
        json.dump(data, f, indent=2)


def exists_tracked_log(alias: str) -> bool:
    return alias in load_tracked_logs()


def add_tracked_log(alias: str, path: str):
    data = load_tracked_logs()
    if alias in data:
        raise ValueError(f"Alias '{alias}' already exists")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Log file '{path}' not found")
    data[alias] = os.path.abspath(path)
    save_tracked_logs(data)


def update_tracked_log(alias: str, path: str):
    data = load_tracked_logs()
    if alias not in data:
        raise ValueError(f"Alias '{alias}' does not exist")
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Log file '{path}' not found")
    data[alias] = os.path.abspath(path)
    save_tracked_logs(data)


def remove_tracked_log(alias: str):
    data = load_tracked_logs()
    if alias not in data:
        raise ValueError(f"Alias '{alias}' does not exist")
    del data[alias]
    save_tracked_logs(data)
