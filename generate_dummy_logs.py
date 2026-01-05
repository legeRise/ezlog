#!/usr/bin/env python3

import time
import random
import string
from datetime import datetime

LOG_FILE = "dummy.log"

# ---- CONFIG ----
LINES_PER_SECOND = 200      # increase for faster growth
MESSAGE_SIZE = 200           # characters per log message
FLUSH_EVERY = 1000            # flush to disk every N lines
# ----------------

LEVELS = ["INFO", "DEBUG", "WARNING", "ERROR", "CRITICAL"]
SERVICES = ["auth", "api", "worker", "db", "cache"]

def random_message(size):
    return ''.join(random.choices(string.ascii_letters + string.digits + " ", k=size))

def generate_log_line():
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S,%f")[:-3]
    level = random.choice(LEVELS)
    service = random.choice(SERVICES)
    msg = random_message(MESSAGE_SIZE)
    return f"{ts} [{level}] [{service}] {msg}\n"

def main():
    print(f"Writing logs to {LOG_FILE} (Ctrl+C to stop)")
    line_count = 0

    with open(LOG_FILE, "a", buffering=1) as f:
        while True:
            start = time.time()

            for _ in range(LINES_PER_SECOND):
                f.write(generate_log_line())
                line_count += 1

                if line_count % FLUSH_EVERY == 0:
                    f.flush()

            elapsed = time.time() - start
            sleep_time = max(0, 1 - elapsed)
            time.sleep(sleep_time)

if __name__ == "__main__":
    main()
