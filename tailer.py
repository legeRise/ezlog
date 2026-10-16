"""Efficient, rotation-aware access to log files.

Keeps a cached line index per file so the web layer can:

* report metadata (size, line count) without re-scanning the whole file on
  every request,
* read arbitrary line ranges in O(lines) instead of O(file),
* tail the file live from the end, surviving log rotation / truncation.

The on-disk file is always the source of truth; state is rebuilt automatically
when the file is rotated (inode change) or truncated (size shrink).
"""

from __future__ import annotations

import asyncio
import os
import threading

CHUNK = 1 << 20            # scan in 1 MiB chunks
MAX_OFFSETS = 2_000_000    # cap the in-memory line index (~16 MB worst case)
QUEUE_MAXSIZE = 1000       # live batches buffered per subscriber
MAX_READ = 4 << 20         # cap bytes read per live poll (bounds loop stall)


def human_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{n / (1024 * 1024 * 1024):.2f} GB"


class LogFile:
    """Cached, append-aware view of a single log file."""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.Lock()
        self._inode = None
        self._scanned = 0          # bytes scanned for newlines
        self._offsets: list[int] = []  # byte offset of the start of each line
        self._counted_lines = 0    # newlines seen (complete lines)
        self._last_byte_nl = True
        self._capped = False
        self._size = 0
        self._mtime = 0.0
        self._missing = False

    # -- metadata -------------------------------------------------------
    def refresh(self) -> None:
        try:
            st = os.stat(self.path)
        except OSError:
            self._missing = True
            self._size = 0
            return

        self._missing = False
        self._size = st.st_size
        self._mtime = st.st_mtime

        with self._lock:
            if self._inode != st.st_ino or st.st_size < self._scanned:
                # rotated (new inode) or truncated (smaller): start over
                self._inode = st.st_ino
                self._scanned = 0
                self._offsets = []
                self._counted_lines = 0
                self._last_byte_nl = True
                self._capped = False

            if st.st_size > self._scanned:
                self._scan(st.st_size)

    def _scan(self, end: int) -> None:
        start = self._scanned
        if start >= end:
            return

        last = None
        with open(self.path, "rb") as f:
            f.seek(start)
            while start < end:
                data = f.read(min(CHUNK, end - start))
                if not data:
                    break

                self._counted_lines += data.count(b"\n")

                if not self._capped:
                    if not self._offsets:
                        self._offsets.append(0)  # first line starts at 0
                    idx = 0
                    while True:
                        nl = data.find(b"\n", idx)
                        if nl == -1:
                            break
                        self._offsets.append(start + nl + 1)
                        idx = nl + 1

                last = data[-1:]
                start += len(data)

                if not self._capped and len(self._offsets) > MAX_OFFSETS:
                    # Too many lines to index in memory: keep counting only.
                    self._capped = True
                    self._offsets = []

        if not self._capped and not self._offsets and end > 0:
            self._offsets.append(0)

        self._scanned = end
        if last is not None:
            self._last_byte_nl = last == b"\n"

    @property
    def line_count(self) -> int:
        if self._missing or self._size == 0:
            return 0
        n = self._counted_lines
        if not self._last_byte_nl:
            n += 1  # trailing line without a newline
        return n

    def metadata(self) -> dict:
        self.refresh()
        return {
            "size": self._size,
            "lines": self.line_count,
            "size_human": human_size(self._size),
            "missing": self._missing,
            "last_modified": self._mtime,
        }

    def exists(self) -> bool:
        self.refresh()
        return not self._missing

    # -- reads ----------------------------------------------------------
    def read_range(self, start_line: int, count: int) -> list[str]:
        """Return `count` lines starting at 1-indexed `start_line`."""
        self.refresh()
        if self._missing or count <= 0:
            return []
        start_line = max(1, start_line)

        if self._capped:
            return self._read_range_linear(start_line, count)

        with self._lock:
            if start_line - 1 >= len(self._offsets):
                return []
            start_off = self._offsets[start_line - 1]
            end_idx = start_line - 1 + count
            end_off = self._offsets[end_idx] if end_idx < len(self._offsets) else self._size

        if end_off <= start_off:
            return []

        with open(self.path, "rb") as f:
            f.seek(start_off)
            data = f.read(end_off - start_off)

        lines = data.decode("utf-8", errors="replace").splitlines()
        return lines[:count]

    def _read_range_linear(self, start_line: int, count: int) -> list[str]:
        """Fallback for files too large to index: stream to the window."""
        out: list[str] = []
        n = 0
        with open(self.path, "rb") as f:
            for raw in f:
                n += 1
                if n < start_line:
                    continue
                if n >= start_line + count:
                    break
                out.append(raw.decode("utf-8", errors="replace").rstrip("\r\n"))
        return out

    def tail_lines(self, n: int) -> list[str]:
        """Return the last `n` lines."""
        self.refresh()
        total = self.line_count
        if total == 0:
            return []
        start = max(1, total - n + 1)
        return self.read_range(start, total - start + 1)

    def search(self, term: str, limit: int = 200) -> list[dict]:
        """Return up to `limit` matching lines with their 1-indexed numbers."""
        if not term:
            return []
        term_lower = term.lower()
        matches: list[dict] = []
        try:
            with open(self.path, "rb") as f:
                for i, raw in enumerate(f, 1):
                    text = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                    if term_lower in text.lower():
                        matches.append({"line": i, "text": text})
                        if len(matches) >= limit:
                            break
        except OSError:
            return []
        return matches


class TailHub:
    """One polling task per file, fanning new lines out to all subscribers."""

    def __init__(self, interval: float = 0.25):
        self.interval = interval
        self._tasks: dict[str, _TailTask] = {}

    def subscribe(self, path: str):
        task = self._tasks.get(path)
        if task is None:
            task = _TailTask(path, self.interval)
            task.task = asyncio.create_task(task.run())
            self._tasks[path] = task
        queue = task.subscribe()
        return task, queue

    def unsubscribe(self, path: str, task: "_TailTask", queue: asyncio.Queue) -> None:
        task.unsubscribe(queue)
        if task.empty():
            task.stop()
            if self._tasks.get(path) is task:
                del self._tasks[path]


class _TailTask:
    def __init__(self, path: str, interval: float):
        self.path = path
        self.interval = interval
        self.subscribers: set[asyncio.Queue] = set()
        self.task: asyncio.Task | None = None
        self._offset: int | None = None
        self._inode: int | None = None
        self._remainder = b""
        self._started = False
        self._stopped = False

    def subscribe(self) -> asyncio.Queue:
        if not self._started:
            self._prime()
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_MAXSIZE)
        self.subscribers.add(queue)
        return queue

    def _prime(self) -> None:
        """Record the start offset immediately on subscribe (not on first poll),
        so lines written in the first poll interval are not lost."""
        try:
            st = os.stat(self.path)
        except OSError:
            return
        self._inode = st.st_ino
        self._offset = st.st_size
        self._started = True

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self.subscribers.discard(queue)

    def empty(self) -> bool:
        return not self.subscribers

    def stop(self) -> None:
        self._stopped = True
        if self.task is not None:
            self.task.cancel()

    def _emit(self, msg: dict) -> None:
        for queue in list(self.subscribers):
            try:
                queue.put_nowait(msg)
            except asyncio.QueueFull:
                # Slow client: drop the oldest batch to make room.
                try:
                    queue.get_nowait()
                except asyncio.QueueEmpty:
                    pass
                try:
                    queue.put_nowait(msg)
                except asyncio.QueueFull:
                    pass

    async def run(self) -> None:
        try:
            while not self._stopped:
                await asyncio.sleep(self.interval)
                # Poll inline: only the *delta* since the last offset is read,
                # bounded by MAX_READ, so this does not stall the loop the way
                # a whole-file scan would.
                for msg in self._poll_sync():
                    self._emit(msg)
        except asyncio.CancelledError:
            pass

    def _poll_sync(self) -> list[dict]:
        """Poll the file for new bytes / rotation and return messages to emit."""
        try:
            st = os.stat(self.path)
        except OSError:
            if self._inode is not None:
                self._inode = None
                self._offset = None
                self._remainder = b""
                return [{"type": "notice", "msg": "missing"}]
            return []

        messages: list[dict] = []

        if self._inode is None:
            # First appearance -> start at the end. Reappearance after the file
            # went away (rename + create) -> treat as rotation and read it all.
            self._inode = st.st_ino
            if self._started:
                self._offset = 0
                self._remainder = b""
                messages.append({"type": "notice", "msg": "rotated"})
            else:
                self._offset = st.st_size
                self._started = True
            return messages

        if st.st_ino != self._inode or st.st_size < (self._offset or 0):
            self._inode = st.st_ino
            self._offset = 0
            self._remainder = b""
            messages.append({"type": "notice", "msg": "rotated"})

        if st.st_size > (self._offset or 0):
            to_read = min(st.st_size - self._offset, MAX_READ)
            with open(self.path, "rb") as f:
                f.seek(self._offset)
                data = f.read(to_read)
            self._offset += len(data)
            lines, self._remainder = self._split(self._remainder + data)
            if lines:
                messages.append({"type": "log_batch", "data": lines})

        return messages

    @staticmethod
    def _split(buf: bytes):
        parts = buf.split(b"\n")
        *complete, tail = parts
        lines = [p.decode("utf-8", errors="replace").rstrip("\r") for p in complete]
        return lines, tail
