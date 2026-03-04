import json
import time
from pathlib import Path
import random
from datetime import datetime
import argparse
import uuid
from itertools import count

# Path to tracked_logs.json (same as in tracked_logs.py)
APP_DIR = Path.home() / ".ezlog"
TRACKED_LOGS_FILE = APP_DIR / "tracked_logs.json"

LEVELS = ["INFO", "WARN", "ERROR", "DEBUG", "SUCCESS", "CRITICAL"]
SERVICES = ["auth", "payments", "orders", "search", "inventory", "gateway"]
REGIONS = ["us-east-1", "eu-west-1", "ap-south-1"]

def load_tracked_logs():
    if not TRACKED_LOGS_FILE.exists():
        return {}
    with open(TRACKED_LOGS_FILE, "r") as f:
        return json.load(f)

def build_unique_log_line(alias, sequence, run_id):
    now = datetime.now()
    level = random.choice(LEVELS)
    service = random.choice(SERVICES)
    region = random.choice(REGIONS)
    request_id = uuid.uuid4().hex[:12]
    user_id = random.randint(1000, 999999)
    latency_ms = random.randint(1, 5000)
    payload_size = random.randint(128, 65536)
    keyword = f"SEARCH_TOKEN_{run_id}_{sequence}"

    return (
        f"[{now.strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]}] "
        f"level={level} alias={alias} service={service} region={region} "
        f"seq={sequence} run={run_id} req={request_id} user={user_id} "
        f"latency_ms={latency_ms} payload_bytes={payload_size} "
        f"message=simulated-event unique={keyword}\n"
    )


def simulate_logs(interval=0.2, lines_per_file=200, flush_every=2000):
    run_id = datetime.now().strftime("%Y%m%d%H%M%S")
    sequence_counter = count(1)
    total_written = 0

    print("Starting high-volume unique log simulator...")
    print(f"run_id={run_id} | interval={interval}s | lines_per_file={lines_per_file}")
    print("Tip: Search with term: SEARCH_TOKEN_<run_id>_<sequence>")

    while True:
        tracked = load_tracked_logs()
        if not tracked:
            print("No tracked logs found. Waiting...")
            time.sleep(interval)
            continue

        for alias, path in tracked.items():
            try:
                Path(path).parent.mkdir(parents=True, exist_ok=True)  # make sure folder exists
                with open(path, "a") as f:
                    batch = []
                    for _ in range(lines_per_file):
                        sequence = next(sequence_counter)
                        batch.append(build_unique_log_line(alias, sequence, run_id))

                    f.writelines(batch)
                    total_written += len(batch)

                    if flush_every > 0 and total_written % flush_every < len(batch):
                        print(
                            f"[{datetime.now().strftime('%H:%M:%S')}] "
                            f"wrote={total_written} total logs | "
                            f"last_token=SEARCH_TOKEN_{run_id}_{sequence}"
                        )
            except Exception as e:
                print(f"Error writing to {alias}: {e}")
        time.sleep(interval)


def parse_args():
    parser = argparse.ArgumentParser(description="High-volume unique log simulator for EZLog")
    parser.add_argument("--interval", type=float, default=0.2, help="Sleep between write cycles in seconds")
    parser.add_argument("--lines-per-file", type=int, default=200, help="Lines written per tracked file per cycle")
    parser.add_argument("--flush-every", type=int, default=2000, help="Print progress every N total written lines")
    return parser.parse_args()

if __name__ == "__main__":
    args = parse_args()
    simulate_logs(
        interval=max(0.01, args.interval),
        lines_per_file=max(1, args.lines_per_file),
        flush_every=max(0, args.flush_every)
    )
