import os


def test_version_is_single_source():
    """The CLI and the version module must not drift apart."""
    import version
    from cli import EZLOG_VERSION

    assert version.__version__ == EZLOG_VERSION


def test_add_and_remove_roundtrip(isolated_store, sample_log):
    isolated_store.add_tracked_log("myapp", str(sample_log))

    assert isolated_store.exists_tracked_log("myapp")
    data = isolated_store.load_tracked_logs()
    assert data["myapp"] == os.path.abspath(str(sample_log))

    isolated_store.remove_tracked_log("myapp")
    assert not isolated_store.exists_tracked_log("myapp")


def test_grouping_by_project(isolated_store, tmp_path):
    a = tmp_path / "a.log"
    b = tmp_path / "b.log"
    a.write_text("x\n")
    b.write_text("y\n")

    isolated_store.add_tracked_log("svc.a", str(a))
    isolated_store.add_tracked_log("svc.b", str(b))
    isolated_store.add_tracked_log("standalone", str(a))

    groups = isolated_store.group_logs_by_project(isolated_store.load_tracked_logs())

    assert set(groups["svc"].keys()) == {"a", "b"}
    assert "standalone" in groups["_root"]
