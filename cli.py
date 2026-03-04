import typer
import os
import sys
import signal
import subprocess
import hashlib
import tarfile
import tempfile
import urllib.request
import json
from pathlib import Path
from tracked_logs import (
    add_tracked_log, update_tracked_log, remove_tracked_log,
    load_tracked_logs, save_tracked_logs, TRACKED_LOGS_FILE, APP_DIR
)

cli = typer.Typer()
EZLOG_VERSION = "1.0.5"

# PID file for background process
PID_FILE = APP_DIR / "ezlog.pid"
RUN_CONFIG_FILE = APP_DIR / "runtime.json"
LATEST_RELEASE_URL = "https://github.com/legeRise/ezlog/releases/latest/download/ezlog-linux-x64.tar.gz"
SYSTEM_BINARY = Path("/usr/local/ezlog/ezlog")
SYSTEM_LINK = Path("/usr/local/bin/ezlog")


def get_pid():
    """Get PID if process is running"""
    if not PID_FILE.exists():
        return None
    try:
        pid = int(PID_FILE.read_text().strip())
        # Check if process exists
        os.kill(pid, 0)
        return pid
    except (ValueError, OSError):
        # PID file exists but process is dead
        PID_FILE.unlink(missing_ok=True)
        return None


def is_running():
    """Check if ezlog is running in background"""
    return get_pid() is not None


def sha256_file(path: Path):
    """Return SHA256 hash for a file path."""
    if not path.exists() or not path.is_file():
        return None

    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def find_extracted_package_dir(root: Path):
    """Find extracted release directory containing install.sh and binary."""
    if (root / "install.sh").exists() and (root / "ezlog").exists():
        return root

    for child in root.iterdir():
        if child.is_dir() and (child / "install.sh").exists() and (child / "ezlog").exists():
            return child

    return None


def save_run_config(port: int, host: str):
    APP_DIR.mkdir(parents=True, exist_ok=True)
    RUN_CONFIG_FILE.write_text(json.dumps({"port": port, "host": host}))


def load_run_config():
    if not RUN_CONFIG_FILE.exists():
        return None
    try:
        data = json.loads(RUN_CONFIG_FILE.read_text())
        port = int(data.get("port", 9200))
        host = str(data.get("host", "0.0.0.0"))
        return {"port": port, "host": host}
    except Exception:
        return None


@cli.command()
def add(alias: str, path: str):
    """Add a new log file to track"""
    try:
        add_tracked_log(alias, path)
        typer.echo(f"Added {alias} -> {path}")
    except Exception as e:
        typer.echo(f"[Error] {e}", err=True)
        raise typer.Exit(1)


@cli.command()
def update(alias: str, path: str):
    """Update an existing log alias to a new path"""
    try:
        update_tracked_log(alias, path)
        typer.echo(f"Updated {alias} -> {path}")
    except Exception as e:
        typer.echo(f"[Error] {e}", err=True)
        raise typer.Exit(1)


@cli.command()
def remove(alias: str):
    """Remove a tracked log"""
    try:
        remove_tracked_log(alias)
        typer.echo(f"Removed {alias}")
    except Exception as e:
        typer.echo(f"[Error] {e}", err=True)
        raise typer.Exit(1)


@cli.command()
def list():
    """List all tracked logs"""
    data = load_tracked_logs()
    if not data:
        typer.echo("No logs tracked")
        return
    for alias, path in data.items():
        typer.echo(f"{alias:15} {path}")


@cli.command()
def clear(yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt")):
    """Remove all tracked logs"""
    data = load_tracked_logs()
    if not data:
        typer.echo("No logs tracked")
        return

    if not yes:
        typer.confirm(f"Remove all {len(data)} tracked logs?", abort=True)

    save_tracked_logs({})
    typer.echo(f"✅ Removed {len(data)} tracked logs")


@cli.command()
def check(missing_only: bool = typer.Option(False, "--missing-only", help="Show only missing files")):
    """Check tracked logs and show whether each file exists"""
    data = load_tracked_logs()
    if not data:
        typer.echo("No logs tracked")
        return

    missing_count = 0
    for alias, path in data.items():
        exists = os.path.isfile(path)
        if not exists:
            missing_count += 1
        if missing_only and exists:
            continue

        status = "✅" if exists else "❌"
        typer.echo(f"{status} {alias:15} {path}")

    typer.echo(f"\nTotal: {len(data)} | Missing: {missing_count} | Healthy: {len(data) - missing_count}")


@cli.command()
def prune(yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompt")):
    """Remove tracked aliases whose files no longer exist"""
    data = load_tracked_logs()
    if not data:
        typer.echo("No logs tracked")
        return

    missing_aliases = [alias for alias, path in data.items() if not os.path.isfile(path)]
    if not missing_aliases:
        typer.echo("No missing log paths found")
        return

    typer.echo("Missing aliases:")
    for alias in missing_aliases:
        typer.echo(f"- {alias}")

    if not yes:
        typer.confirm(f"Remove {len(missing_aliases)} missing aliases?", abort=True)

    for alias in missing_aliases:
        del data[alias]

    save_tracked_logs(data)
    typer.echo(f"✅ Removed {len(missing_aliases)} missing aliases")


@cli.command()
def start(port: int = 9200, host: str = "0.0.0.0"):
    """Start ezlog in background"""
    if is_running():
        pid = get_pid()
        typer.echo(f"ezlog is already running (PID: {pid})")
        typer.echo(f"Visit http://{host}:{port}")
        return
    
    # Start in background
    APP_DIR.mkdir(parents=True, exist_ok=True)
    
    # Get current executable path
    if getattr(sys, 'frozen', False):
        # Running as compiled binary
        exe_path = [sys.executable]
    else:
        # Running as Python script
        exe_path = [sys.executable, __file__]
    
    # Start background process
    process = subprocess.Popen(
        exe_path + ["run", "--port", str(port), "--host", host],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True
    )
    
    # Save PID
    PID_FILE.write_text(str(process.pid))
    save_run_config(port, host)
    
    typer.echo(f"✅ Started ezlog in background (PID: {process.pid})")
    typer.echo(f"🌐 Visit http://{host}:{port}")
    typer.echo(f"⏹️  Stop with: ezlog stop")


@cli.command()
def stop():
    """Stop background ezlog process"""
    pid = get_pid()
    if not pid:
        typer.echo("ezlog is not running")
        return
    
    try:
        os.kill(pid, signal.SIGTERM)
        PID_FILE.unlink(missing_ok=True)
        typer.echo(f"✅ Stopped ezlog (PID: {pid})")
    except OSError:
        typer.echo("Failed to stop process (may already be dead)")
        PID_FILE.unlink(missing_ok=True)


@cli.command()
def status():
    """Show ezlog process status"""
    pid = get_pid()
    if pid:
        typer.echo(f"✅ ezlog is running (PID: {pid})")
        typer.echo("⏹️  Stop with: ezlog stop")
    else:
        typer.echo("❌ ezlog is not running")
        typer.echo("▶️  Start with: ezlog start")


@cli.command()
def run(port: int = 9200, host: str = "0.0.0.0"):
    """Run ezlog in foreground (for debugging)"""
    typer.echo(f"Starting ezlog on http://{host}:{port}")
    typer.echo("Press Ctrl+C to stop")
    save_run_config(port, host)
    from ezlog import start
    start(port, host)


@cli.command()
def version():
    """Show ezlog version and install details."""
    typer.echo(f"ezlog version {EZLOG_VERSION}")
    typer.echo(f"Executable: {sys.executable}")

    installed_hash = sha256_file(SYSTEM_BINARY)
    if installed_hash:
        typer.echo(f"Installed binary: {SYSTEM_BINARY}")
        typer.echo(f"Installed SHA256: {installed_hash[:16]}...")

    run_cfg = load_run_config()
    if run_cfg:
        typer.echo(f"Last runtime config: host={run_cfg['host']} port={run_cfg['port']}")


@cli.command("show-path")
def show_path():
    """Show the full path of the tracked logs JSON file"""
    typer.echo(f"Tracked logs file is at: {TRACKED_LOGS_FILE}")


@cli.command("show-dir")
def show_dir():
    """Show the folder where tracked logs are stored"""
    typer.echo(f"Tracked logs folder is at: {APP_DIR}")


@cli.command("upgrade")
def upgrade(
    url: str = typer.Option(LATEST_RELEASE_URL, "--url", help="Release tar.gz URL"),
    check_only: bool = typer.Option(False, "--check-only", help="Only check if update is available"),
    restart: bool = typer.Option(True, "--restart/--no-restart", help="Restart service if it was running"),
    port: int = typer.Option(0, "--port", help="Port to use on restart (default: last used)"),
    host: str = typer.Option("", "--host", help="Host to use on restart (default: last used)"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip confirmation prompts")
):
    """Download and install latest ezlog release automatically."""
    typer.echo("🔄 Starting ezlog upgrade...")

    current_hash = sha256_file(SYSTEM_BINARY)
    if current_hash:
        typer.echo(f"Current installed binary: {SYSTEM_BINARY}")
        typer.echo(f"Current SHA256: {current_hash[:16]}...")
    else:
        typer.echo("No existing system install detected in /usr/local/ezlog")

    was_running = is_running()
    if was_running:
        typer.echo("Service status: running")
    else:
        typer.echo("Service status: not running")

    if not yes and not check_only:
        typer.confirm("Continue with download and install?", abort=True)

    with tempfile.TemporaryDirectory(prefix="ezlog-upgrade-") as tmp:
        tmp_dir = Path(tmp)
        archive_path = tmp_dir / "ezlog-linux-x64.tar.gz"

        try:
            typer.echo(f"⬇️ Downloading: {url}")
            urllib.request.urlretrieve(url, archive_path)
        except Exception as e:
            typer.echo(f"[Error] Failed to download release: {e}", err=True)
            raise typer.Exit(1)

        try:
            typer.echo("📦 Extracting package...")
            with tarfile.open(archive_path, "r:gz") as tar:
                tar.extractall(tmp_dir)
        except Exception as e:
            typer.echo(f"[Error] Failed to extract package: {e}", err=True)
            raise typer.Exit(1)

        package_dir = find_extracted_package_dir(tmp_dir)
        if not package_dir:
            typer.echo("[Error] Invalid package layout: install.sh or ezlog binary missing", err=True)
            raise typer.Exit(1)

        new_binary = package_dir / "ezlog"
        new_hash = sha256_file(new_binary)
        typer.echo(f"Downloaded SHA256: {new_hash[:16] if new_hash else 'unknown'}...")

        if current_hash and new_hash and current_hash == new_hash:
            typer.echo("✅ Already up-to-date. Installed binary matches latest package.")
            return

        if check_only:
            typer.echo("🆕 Update available.")
            return

        if was_running:
            typer.echo("🛑 Stopping current ezlog service...")
            pid = get_pid()
            if pid:
                try:
                    os.kill(pid, signal.SIGTERM)
                except OSError:
                    pass
                PID_FILE.unlink(missing_ok=True)

        install_script = package_dir / "install.sh"
        install_cmd = ["bash", str(install_script)] if os.geteuid() == 0 else ["sudo", "bash", str(install_script)]

        typer.echo("🧩 Installing new release...")
        try:
            subprocess.run(install_cmd, check=True)
        except subprocess.CalledProcessError as e:
            typer.echo(f"[Error] Installation failed: {e}", err=True)
            raise typer.Exit(1)

        updated_hash = sha256_file(SYSTEM_BINARY)
        if updated_hash:
            typer.echo(f"Installed SHA256: {updated_hash[:16]}...")

        if was_running and restart:
            run_cfg = load_run_config() or {"port": 9200, "host": "0.0.0.0"}
            restart_port = port if port > 0 else run_cfg["port"]
            restart_host = host if host else run_cfg["host"]

            typer.echo(f"▶️ Restarting ezlog on http://{restart_host}:{restart_port}...")
            start_cmd = [str(SYSTEM_LINK if SYSTEM_LINK.exists() else SYSTEM_BINARY), "start", "--port", str(port), "--host", host]
            try:
                start_cmd = [
                    str(SYSTEM_LINK if SYSTEM_LINK.exists() else SYSTEM_BINARY),
                    "start",
                    "--port",
                    str(restart_port),
                    "--host",
                    restart_host
                ]
                subprocess.run(start_cmd, check=True)
            except subprocess.CalledProcessError as e:
                typer.echo(f"[Error] Restart failed: {e}", err=True)
                raise typer.Exit(1)

        typer.echo("✅ Upgrade complete!")


if __name__ == "__main__":
    cli()
