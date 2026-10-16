import os

import pytest


@pytest.fixture
def isolated_store(tmp_path, monkeypatch):
    """Point the tracked-logs store at a temp dir for the duration of a test."""
    import tracked_logs

    store_dir = tmp_path / ".ezlog"
    monkeypatch.setattr(tracked_logs, "APP_DIR", store_dir)
    monkeypatch.setattr(tracked_logs, "TRACKED_LOGS_FILE", store_dir / "tracked_logs.json")
    return tracked_logs


@pytest.fixture
def sample_log(tmp_path):
    """A small log file to track."""
    log = tmp_path / "app.log"
    log.write_text(
        "2026-01-01 10:00:00 INFO  started\n"
        "2026-01-01 10:00:01 WARN  slow query\n"
        "2026-01-01 10:00:02 ERROR boom\n"
    )
    return log
