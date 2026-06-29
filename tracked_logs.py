import json
import os
import fnmatch
from pathlib import Path
from collections import defaultdict

# Always use hidden folder in user's home
APP_DIR = Path.home() / ".ezlog"
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


def parse_alias(alias: str):
    """Split an alias into (project, short_name).
    Format: 'project.shortname' or just 'shortname' for project-less.
    """
    if "." in alias:
        parts = alias.split(".", 1)
        return parts[0], parts[1]
    return None, alias


def group_logs_by_project(data: dict) -> dict:
    """Group tracked logs by project.
    Returns: { "project_name": { "short_alias": "/path", ... }, ... }
    Logs without a project group under None key.
    """
    groups = defaultdict(dict)
    for alias, path in data.items():
        project, short = parse_alias(alias)
        key = project if project else "_root"
        groups[key][short if project else alias] = {"alias": alias, "path": path}
    return dict(groups)


def add_folder(folder_path: str, project: str = None, pattern: str = "*.log", all_files: bool = False):
    """Add all matching files from a folder as tracked logs.
    
    Args:
        folder_path: Path to folder to scan
        project: Project name (uses folder name if None)
        pattern: Glob pattern to match files (default: *.log)
        all_files: If True, ignore pattern and add all files
    
    Returns:
        List of (alias, path) tuples that were added
    """
    folder = Path(folder_path)
    if not folder.is_dir():
        raise NotADirectoryError(f"Folder '{folder_path}' not found")
    
    resolved_project = project if project else folder.name
    data = load_tracked_logs()
    added = []
    
    # Determine files to add
    if all_files:
        files = list(folder.iterdir())
    else:
        files = []
        for f in folder.iterdir():
            if f.is_file() and fnmatch.fnmatch(f.name, pattern):
                files.append(f)
    
    for f in sorted(files):
        if not f.is_file():
            continue
        # Derive alias: project.filename_without_ext
        stem = f.stem
        alias = f"{resolved_project}.{stem}"
        if alias in data:
            continue  # skip duplicates
        data[alias] = str(f.resolve())
        added.append((alias, str(f.resolve())))
    
    save_tracked_logs(data)
    return added


def remove_tracked_logs_bulk(aliases: list):
    """Remove multiple tracked logs at once.
    Raises ValueError if any alias does not exist.
    """
    data = load_tracked_logs()
    missing = [a for a in aliases if a not in data]
    if missing:
        raise ValueError(f"Aliases not found: {', '.join(missing)}")
    for alias in aliases:
        del data[alias]
    save_tracked_logs(data)


def remove_project(project: str):
    """Remove all logs belonging to a project group.
    Returns the number of removed aliases.
    """
    data = load_tracked_logs()
    to_remove = [alias for alias in data if parse_alias(alias)[0] == project]
    if not to_remove:
        raise ValueError(f"Project '{project}' not found")
    for alias in to_remove:
        del data[alias]
    save_tracked_logs(data)
    return len(to_remove)
