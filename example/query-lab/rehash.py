"""Compare the two migration budgets with matching HTTP workloads."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.client import HTTPConnection
import json
import math
from pathlib import Path
from shutil import copyfile, which
from subprocess import check_call, check_output
import sys
from tempfile import TemporaryDirectory
from threading import Barrier
from time import perf_counter_ns, sleep, time_ns

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))
from support import ROOT, Server

SEED_COUNT = 49152
INSERTS = 64
CLIENTS = 8
READS_PER_CLIENT = 300
READ_INTERVAL_MS = 4
WINDOW = (-15, 40)
BINARY = ROOT / "build/mini-redis"


def request(connection, method, key, value=None):
    body = None if value is None else json.dumps({"value": value})
    connection.request(method, f"/keys/{key}", body, {"Content-Type": "application/json"})
    response = connection.getresponse()
    return response.status, response.read()


def seed(directory, count=SEED_COUNT):
    server = Server(BINARY, directory)
    try:
        with closing(HTTPConnection("127.0.0.1", server.port, timeout=4)) as connection:
            for index in range(count):
                assert request(connection, "PUT", f"existing-{index}", "probe")[0] == 204
        return server.aof
    finally:
        server.close()


def read_trace(log):
    return [
        line.split()[1:] for line in log.read_text().splitlines()
        if line.startswith("rehash_trace ")
    ]


def measure(server, all_at_once):
    barrier = Barrier(CLIENTS + 1, timeout=8)
    origin_ns = perf_counter_ns() + 100_000_000

    def wait_at(offset_ms):
        delay = origin_ns + offset_ms * 1_000_000 - perf_counter_ns()
        if delay > 0:
            sleep(delay / 1_000_000_000)

    def reader(client):
        points = []
        with closing(HTTPConnection("127.0.0.1", server.port, timeout=4)) as connection:
            assert request(connection, "GET", "existing-0")[0] == 200
            barrier.wait()
            for index in range(READS_PER_CLIENT):
                wait_at(index * READ_INTERVAL_MS)
                key = (client * READS_PER_CLIENT + index) % SEED_COUNT
                start = time_ns()
                monotonic_start = perf_counter_ns()
                status, body = request(connection, "GET", f"existing-{key}")
                ms = (perf_counter_ns() - monotonic_start) / 1_000_000
                ok = status == 200 and json.loads(body)["value"] == "probe"
                points.append((start, ms, ok))
        return points

    with ThreadPoolExecutor(CLIENTS) as workers:
        readers = [workers.submit(reader, index) for index in range(CLIENTS)]
        barrier.wait()
        with closing(HTTPConnection("127.0.0.1", server.port, timeout=4)) as writer:
            assert request(writer, "GET", "existing-0")[0] == 200
            for index in range(INSERTS):
                wait_at(50 + index)
                assert request(writer, "PUT", f"new-{index}", "insert")[0] == 204
            readings = [point for future in readers for point in future.result()]
            # Finish a slow migration even if the scheduled workload already ended.
            for _ in range(32):
                if len(read_trace(server.log)) >= 2:
                    break
                for _ in range(256):
                    assert request(writer, "GET", "existing-0")[0] == 200

    start, end = read_trace(server.log)
    assert start[0] == "start" and end[0] == "end"
    start_ns, end_ns = int(start[1]), int(end[1])
    assert start_ns < end_ns
    moved = int(end[2]) - int(start[2])
    max_nodes = int(end[3])
    assert moved == SEED_COUNT
    assert 0 < max_nodes <= (SEED_COUNT if all_at_once else 4)
    assert not all_at_once or max_nodes == SEED_COUNT

    points = []
    for sent, ms, ok in readings:
        at = (sent - start_ns) / 1_000_000
        if WINDOW[0] <= at <= WINDOW[1]:
            points.append({"at": at, "ms": ms, "ok": ok})
    points.sort(key=lambda point: point["at"])
    assert any(point["at"] < 0 for point in points) and any(point["at"] >= 0 for point in points)
    latencies = sorted(point["ms"] for point in points)
    assert all(point[2] for point in readings)
    duration = (end_ns - start_ns) / 1_000_000
    overlapping = [
        point["ms"] for point in points
        if point["at"] < duration and point["at"] + point["ms"] >= 0
    ]
    return {
        "points": points, "resizeMs": duration, "moved": moved, "maxNodes": max_nodes,
        "p99": latencies[math.ceil(.99 * len(latencies)) - 1], "maxMs": latencies[-1],
        "overlapping": len(overlapping), "overlapMaxMs": max(overlapping, default=None),
    }


if __name__ == "__main__":
    compiler = which("clang++") or which("c++") or "clang++"
    check_call(
        ["make", "-s", f"CXX={compiler}", "build/mini-redis", "build/engine-bench"],
        cwd=ROOT, stdout=sys.stderr, timeout=25,
    )
    comparison = json.loads(check_output(
        [str(ROOT / "build/engine-bench"), "--compare-rehash"], timeout=15,
    ))
    with TemporaryDirectory(prefix="mini-redis-rehash-") as directory:
        root = Path(directory)
        source = seed(root)
        modes = {}
        for name in ("incremental", "allAtOnce"):
            target = root / name
            target.mkdir()
            aof = target / "seed.aof"
            copyfile(source, aof)
            flags = ["--trace-rehash"]
            if name == "allAtOnce":
                flags.append("--rehash-all")
            server = Server(BINARY, target, *flags, aof=aof)
            try:
                modes[name] = measure(server, name == "allAtOnce")
            finally:
                server.close()
    print(json.dumps({
        "comparison": comparison, "modes": modes, "window": WINDOW,
        "keys": SEED_COUNT, "inserts": INSERTS, "clients": CLIENTS,
    }))
