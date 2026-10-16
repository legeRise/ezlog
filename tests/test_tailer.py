import asyncio
import os

from tailer import LogFile, TailHub


def make(path, text):
    path.write_text(text)
    return LogFile(str(path))


def test_line_count_and_ranges(tmp_path):
    lf = make(tmp_path / "a.log", "l1\nl2\nl3\nl4\nl5\n")
    assert lf.metadata()["lines"] == 5

    assert lf.read_range(1, 2) == ["l1", "l2"]
    assert lf.read_range(3, 2) == ["l3", "l4"]
    assert lf.read_range(4, 10) == ["l4", "l5"]
    assert lf.read_range(6, 1) == []


def test_tail_lines(tmp_path):
    lf = make(tmp_path / "a.log", "".join(f"l{i}\n" for i in range(1, 21)))
    assert lf.tail_lines(3) == ["l18", "l19", "l20"]
    assert lf.tail_lines(1) == ["l20"]


def test_no_trailing_newline(tmp_path):
    lf = make(tmp_path / "a.log", "one\ntwo\nthree")
    assert lf.metadata()["lines"] == 3
    assert lf.tail_lines(2) == ["two", "three"]


def test_incremental_append(tmp_path):
    p = tmp_path / "a.log"
    lf = make(p, "a\nb\n")
    assert lf.metadata()["lines"] == 2

    with open(p, "a") as f:
        f.write("c\nd\n")

    assert lf.metadata()["lines"] == 4
    assert lf.read_range(3, 2) == ["c", "d"]


def test_truncation_resets(tmp_path):
    p = tmp_path / "a.log"
    lf = make(p, "a\nb\nc\nd\n")
    assert lf.metadata()["lines"] == 4

    # simulate copytruncate log rotation
    p.write_text("fresh\n")

    assert lf.metadata()["lines"] == 1
    assert lf.read_range(1, 1) == ["fresh"]


def test_search(tmp_path):
    lf = make(tmp_path / "a.log", "INFO ok\nERROR boom\ninfo again\n")
    hits = lf.search("error")
    assert hits == [{"line": 2, "text": "ERROR boom"}]
    assert lf.search("info", limit=1) == [{"line": 1, "text": "INFO ok"}]
    assert lf.search("") == []


def test_missing_file(tmp_path):
    lf = LogFile(str(tmp_path / "nope.log"))
    meta = lf.metadata()
    assert meta["missing"] is True
    assert meta["lines"] == 0
    assert lf.read_range(1, 10) == []


def test_hub_delivers_live_lines(tmp_path):
    p = tmp_path / "live.log"
    p.write_text("one\n")

    async def scenario():
        hub = TailHub(interval=0.05)
        task, queue = hub.subscribe(str(p))
        try:
            await asyncio.sleep(0.2)  # let the tailer record the initial offset
            with open(p, "a") as f:
                f.write("two\nthree\n")

            batches = []
            for _ in range(50):
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue
                if msg.get("type") == "log_batch":
                    batches.extend(msg["data"])
                    break
            return batches
        finally:
            hub.unsubscribe(str(p), task, queue)

    assert asyncio.run(scenario()) == ["two", "three"]


def test_hub_survives_rotation(tmp_path):
    """Default logrotate mode: rename the file away, create a fresh one."""
    p = tmp_path / "rot.log"
    p.write_text("orig\n")

    async def scenario():
        hub = TailHub(interval=0.05)
        task, queue = hub.subscribe(str(p))
        try:
            await asyncio.sleep(0.2)
            os.rename(p, tmp_path / "rot.log.1")
            p.write_text("rotated\n")

            notices, lines = [], []
            for _ in range(60):
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue
                if msg.get("type") == "notice":
                    notices.append(msg["msg"])
                elif msg.get("type") == "log_batch":
                    lines.extend(msg["data"])
                    if "rotated" in lines:
                        break
            return notices, lines
        finally:
            hub.unsubscribe(str(p), task, queue)

    notices, lines = asyncio.run(scenario())
    assert "rotated" in notices
    assert "rotated" in lines


def test_hub_detects_truncation(tmp_path):
    """copytruncate mode: same inode, file shrinks."""
    p = tmp_path / "trunc.log"
    p.write_text("a long original line\n")

    async def scenario():
        hub = TailHub(interval=0.05)
        task, queue = hub.subscribe(str(p))
        try:
            await asyncio.sleep(0.2)
            p.write_text("short\n")

            notices, lines = [], []
            for _ in range(60):
                try:
                    msg = await asyncio.wait_for(queue.get(), timeout=0.2)
                except asyncio.TimeoutError:
                    continue
                if msg.get("type") == "notice":
                    notices.append(msg["msg"])
                elif msg.get("type") == "log_batch":
                    lines.extend(msg["data"])
                    if "short" in lines:
                        break
            return notices, lines
        finally:
            hub.unsubscribe(str(p), task, queue)

    notices, lines = asyncio.run(scenario())
    assert "rotated" in notices
    assert "short" in lines
