import typer
from tracked_logs import (
    add_tracked_log, update_tracked_log, remove_tracked_log,
    load_tracked_logs, TRACKED_LOGS_FILE, APP_DIR
)

cli = typer.Typer()


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
def run(port: int = 9200):
    """Start the ezviewer server"""
    typer.echo(f"Starting ezviewer on http://localhost:{port}")
    from ezviewer import start
    start(port)


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
