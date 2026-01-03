import typer
import os
import sys
import signal
import subprocess
from pathlib import Path
from tracked_logs import (
    add_tracked_log, update_tracked_log, remove_tracked_log,
    load_tracked_logs, TRACKED_LOGS_FILE, APP_DIR
)

cli = typer.Typer()

# PID file for background process
PID_FILE = APP_DIR / "ezlog.pid"


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
    from ezlog import start
    start(port, host)


@cli.command("show-path")
def show_path():
    """Show the full path of the tracked logs JSON file"""
    typer.echo(f"Tracked logs file is at: {TRACKED_LOGS_FILE}")


@cli.command("show-dir")
def show_dir():
    """Show the folder where tracked logs are stored"""
    typer.echo(f"Tracked logs folder is at: {APP_DIR}")


if __name__ == "__main__":
    cli()
