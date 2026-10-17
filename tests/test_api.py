import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(isolated_store, sample_log):
    isolated_store.add_tracked_log("app", str(sample_log))
    import ezlog
    return TestClient(ezlog.app)


def test_home_and_offline_static(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "/static/tailwind.css" in r.text
    assert "cdn.tailwindcss.com" not in r.text
    assert client.get("/static/tailwind.css").status_code == 200


def test_history_top(client):
    data = client.get("/api/logs/app/history", params={"direction": "top", "count": 2}).json()
    assert data["lines"] == [
        "2026-01-01 10:00:00 INFO  started",
        "2026-01-01 10:00:01 WARN  slow query",
    ]
    assert data["start_line"] == 1
    assert data["total_lines"] == 3


def test_history_up(client):
    data = client.get(
        "/api/logs/app/history", params={"direction": "up", "before_line": 3, "count": 1}
    ).json()
    assert data["lines"] == ["2026-01-01 10:00:01 WARN  slow query"]
    assert data["start_line"] == 2
    assert data["end_line"] == 2


def test_history_down(client):
    # Forward pagination — the counterpart to `up`, and the only way back down
    # after jumping to the top of a file.
    data = client.get(
        "/api/logs/app/history", params={"direction": "down", "after_line": 1, "count": 2}
    ).json()
    assert data["lines"] == [
        "2026-01-01 10:00:01 WARN  slow query",
        "2026-01-01 10:00:02 ERROR boom",
    ]
    assert data["start_line"] == 2
    assert data["end_line"] == 3
    assert data["has_more"] is False
    assert data["total_lines"] == 3


def test_history_down_at_end_is_empty(client):
    data = client.get(
        "/api/logs/app/history", params={"direction": "down", "after_line": 3, "count": 2}
    ).json()
    assert data["lines"] == []
    assert data["has_more"] is False
    assert data["total_lines"] == 3


def test_search_fields(client):
    data = client.get("/api/logs/app/search", params={"q": "error"}).json()
    assert data["count"] == 1
    assert data["matches"] == [{"line": 3, "text": "2026-01-01 10:00:02 ERROR boom"}]
    assert data["truncated"] is False


def test_download(client):
    r = client.get("/api/logs/app/download")
    assert r.status_code == 200
    assert "started" in r.text


def test_download_range(client):
    r = client.get("/api/logs/app/download", params={"start": 2, "end": 3})
    assert r.status_code == 200
    assert r.text.splitlines() == [
        "2026-01-01 10:00:01 WARN  slow query",
        "2026-01-01 10:00:02 ERROR boom",
    ]
    assert "app_L2-3.log" in r.headers.get("content-disposition", "")


def test_status_endpoint(client):
    data = client.get("/api/status").json()
    assert "app" in data["logs"]
    rec = data["logs"]["app"]
    assert rec["exists"] is True
    assert rec["errors"] == 1      # the sample log has one ERROR line
    assert rec["warnings"] == 1    # ... and one WARN line
    assert "size_human" in rec


def test_websocket_metadata_history_and_live(client, sample_log):
    with client.websocket_connect("/ws/app") as ws:
        meta = ws.receive_json()
        assert meta["type"] == "metadata"
        assert meta["lines"] == 3
        assert "size_human" in meta

        got_live_start = False
        for _ in range(10):
            msg = ws.receive_json()
            if msg.get("type") == "sys" and msg.get("msg") == "__LIVE_START__":
                got_live_start = True
                break
        assert got_live_start

        with open(sample_log, "a") as f:
            f.write("2026-01-01 10:00:03 ERROR live line\n")

        found = False
        for _ in range(20):
            msg = ws.receive_json()
            if msg.get("type") == "log_batch" and any("live line" in l for l in msg["data"]):
                found = True
                break
        assert found
