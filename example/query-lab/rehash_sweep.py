"""Measure independent GET arrivals around a single resize-triggering PUT."""

import argparse
import asyncio
from contextlib import asynccontextmanager
import json
import math
from pathlib import Path
from shutil import copyfile, which
from statistics import median
from subprocess import check_call
import sys
from tempfile import TemporaryDirectory
from time import time_ns

from rehash import BINARY, CLIENTS, ROOT, Server, WINDOW, read_trace, seed

DURATION = 0.250
PUT_AT = 0.100
BASELINE = (-70, -15)
MODES = ("incremental", "allAtOnce")


def quantile(values, fraction):
    ordered = sorted(values)
    return ordered[math.ceil(fraction * len(ordered)) - 1]


@asynccontextmanager
async def connect(port):
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        yield reader, writer
    finally:
        writer.close()
        await writer.wait_closed()


def send(writer, method, key, body=b""):
    headers = f"{method} /keys/{key} HTTP/1.1\r\nHost: localhost\r\n"
    if body:
        headers += f"Content-Type: application/json\r\nContent-Length: {len(body)}\r\n"
    writer.write(headers.encode("ascii") + b"\r\n" + body)


async def receive(reader):
    status, *headers = (await reader.readuntil(b"\r\n\r\n")).rstrip().split(b"\r\n")
    fields = dict(header.lower().split(b":", 1) for header in headers)
    body = await reader.readexactly(int(fields.get(b"content-length", b"0")))
    return int(status.split()[1]), body


async def traffic(port, keys, rate):
    loop = asyncio.get_running_loop()
    origin = loop.time() + .050
    wall_origin = time_ns() + int((origin - loop.time()) * 1e9)

    async def wait_at(when):
        await asyncio.sleep(max(0, when - loop.time()))

    async def client(index):
        slots = range(index, math.floor(rate * DURATION), CLIENTS)
        async with connect(port) as (reader, writer):
            send(writer, "GET", "existing-0")
            assert (await receive(reader))[0] == 200
            dispatches = asyncio.Queue()

            async def produce():
                for slot in slots:
                    scheduled = origin + slot / rate
                    await wait_at(scheduled)
                    actual = loop.time()
                    send(writer, "GET", f"existing-{slot % keys}")
                    dispatches.put_nowait((slot, scheduled, actual))
                    await writer.drain()

            async def collect():
                points = []
                for _ in slots:
                    slot, scheduled, actual = await dispatches.get()
                    status, body = await receive(reader)
                    done = loop.time()
                    assert status == 200 and json.loads(body)["value"] == "probe"
                    points.append((wall_origin + int(slot / rate * 1e9),
                                   (done - scheduled) * 1000, (actual - scheduled) * 1000))
                return points

            async with asyncio.TaskGroup() as tasks:
                tasks.create_task(produce())
                results = tasks.create_task(collect())
            return results.result()

    async def trigger():
        async with connect(port) as (reader, writer):
            await wait_at(origin + PUT_AT)
            send(writer, "PUT", "trigger-resize", b'{"value":"trigger"}')
            await writer.drain()
            assert (await receive(reader))[0] == 204

    async with asyncio.TaskGroup() as tasks:
        clients = [tasks.create_task(client(index)) for index in range(CLIENTS)]
        tasks.create_task(trigger())
    return [point for task in clients for point in task.result()]


def measure(server, keys, rate, limit):
    async def run():
        return await asyncio.wait_for(traffic(server.port, keys, rate), timeout=8)

    readings = asyncio.run(run())
    trace = read_trace(server.log)
    assert trace and trace[0][0] == "start" and len(trace) <= 2
    start = int(trace[0][1])
    duration = None
    if len(trace) == 2:
        _, end, moved, _ = trace[1]
        assert int(moved) - int(trace[0][2]) == keys
        duration = (int(end) - start) / 1e6

    windows = {}
    for name, (left, right) in (("baseline", BASELINE), ("resize", WINDOW)):
        selected = [(ms, lag) for at, ms, lag in readings if left <= (at - start) / 1e6 < right]
        if not selected:
            raise RuntimeError(f"No scheduled GETs in the {name} window")
        latencies, lags = zip(*selected)
        windows[name] = {
            "samples": len(selected),
            "p99Ms": quantile(latencies, .99),
            "overLimit": sum(ms > limit for ms in latencies),
            "dispatchP99Ms": quantile(lags, .99),
        }
    return {"windows": windows, "completedResizeMs": duration}


def summarize(pairs):
    result = {}
    for mode in MODES:
        runs = [pair[mode] for pair in pairs]
        result[mode] = {}
        for window in ("baseline", "resize"):
            samples = [run["windows"][window] for run in runs]
            count = sum(row["samples"] for row in samples)
            result[mode][window] = {
                "samples": count,
                "medianRunP99Ms": median(row["p99Ms"] for row in samples),
                "overLimitPct": 100 * sum(row["overLimit"] for row in samples) / count,
                "medianDispatchP99Ms": median(row["dispatchP99Ms"] for row in samples),
            }
        completed = [run["completedResizeMs"] for run in runs if run["completedResizeMs"] is not None]
        result[mode]["completedRuns"] = len(completed)
        result[mode]["medianCompletedResizeMs"] = median(completed) if completed else None

    differences = [
        pair["incremental"]["windows"]["resize"]["p99Ms"] - pair["allAtOnce"]["windows"]["resize"]["p99Ms"]
        for pair in pairs
    ]
    result["pairedP99DeltaMs"] = median(differences)
    result["pairsWithLowerIncrementalP99"] = sum(delta < 0 for delta in differences)
    return result


def sweep(args, root):
    cases = []
    for keys in args.keys:
        directory = root / str(keys)
        directory.mkdir()
        print(f"Preparing {keys:,} keys", file=sys.stderr, flush=True)
        source = seed(directory, keys)
        for rate in args.rates:
            pairs = []
            for repeat in range(args.pairs):
                order = MODES if repeat % 2 == 0 else MODES[::-1]
                pair = {}
                for mode in order:
                    with TemporaryDirectory(dir=directory) as run_path:
                        run = Path(run_path)
                        aof = run / "seed.aof"
                        copyfile(source, aof)
                        flags = ["--trace-rehash"]
                        if mode == "allAtOnce":
                            flags.append("--rehash-all")
                        server = Server(BINARY, run, *flags, aof=aof)
                        try:
                            pair[mode] = measure(server, keys, rate, args.limit)
                        finally:
                            server.close()
                pairs.append(pair)
            summary = summarize(pairs)
            cases.append({"keys": keys, "getsPerSecond": rate, "summary": summary, "pairs": pairs})
            print(f"{keys:,} keys at {rate:,} GET/s: {json.dumps(summary)}", file=sys.stderr, flush=True)
    return cases


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--keys", nargs="+", type=int, choices=[12288, 49152, 196608],
                        default=[12288, 49152, 196608])
    parser.add_argument("--rates", nargs="+", type=int, choices=[500, 2000, 4000], default=[2000])
    parser.add_argument("--pairs", type=int, default=7)
    parser.add_argument("--limit", type=float, default=5, help="GET latency threshold in ms")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.pairs < 1 or not math.isfinite(args.limit) or args.limit <= 0:
        parser.error("--pairs and --limit must be positive")
    if args.output and args.output.exists():
        parser.error(f"output already exists: {args.output}")

    compiler = which("clang++") or which("c++") or "clang++"
    check_call(["make", "-s", f"CXX={compiler}", "build/mini-redis"], cwd=ROOT)
    with TemporaryDirectory(prefix="mini-redis-rehash-sweep-") as directory:
        cases = sweep(args, Path(directory))
    result = json.dumps({"limitMs": args.limit, "clients": CLIENTS, "resizeWindowMs": WINDOW,
                         "baselineWindowMs": BASELINE, "durationMs": int(DURATION * 1000),
                         "cases": cases}, indent=2)
    if args.output:
        with args.output.open("x") as output:
            output.write(result + "\n")
    else:
        print(result)


if __name__ == "__main__":
    main()
