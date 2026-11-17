"""Run the TTL scenario against an isolated Mini Redis process."""

import json
from pathlib import Path
from shutil import which
from subprocess import check_call, check_output
import sys
from tempfile import TemporaryDirectory
from time import sleep, time_ns

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tests"))
from support import ROOT, Server, wait_for


def now_ms():
    return time_ns() // 1_000_000


def measure(server):
    timeline = []

    def snapshots():
        return [
            json.loads(line.removeprefix("ttl_heap "))
            for line in server.log.read_text().splitlines()
            if line.startswith("ttl_heap ") and line.endswith("}")
        ]

    def put(key, seconds):
        data = {"value": key}
        if seconds is not None:
            data["ttl_seconds"] = seconds
        assert server.call("PUT", key, data)[0] == 204
        event = snapshots()[-1]
        assert not event["expired"]
        timeline.append({**event, "kind": "put", "key": key, "ttl": seconds})
        return event

    def read(key, expected):
        status, body, _ = server.call("GET", key)
        assert status == expected
        if status == 200:
            assert json.loads(body)["value"] == key
        timeline.append({"at": now_ms(), "kind": "get", "key": key, "status": status})

    def wait_until(deadline):
        sleep(max(0, (deadline - now_ms()) / 1000))

    def expiry(key, previous_root, deadline, number):
        wait_until(deadline)
        wait_for(lambda: sum(bool(event["expired"]) for event in snapshots()) >= number, timeout=4)
        event = [event for event in snapshots() if event["expired"]][number - 1]
        assert event["expired"] == 1 and event["root"] == previous_root
        timeline.append({**event, "kind": "expire", "key": key})
        # This GET follows the logged active cleanup.
        read(key, 404)
        return event

    initial = put("A", 1)
    origin = initial["at"]
    assert initial["root"] == "A"
    assert put("B", 5)["size"] == 2
    permanent = put("C", None)
    assert permanent["root"] == "A" and permanent["size"] == 2

    wait_until(initial["at"] + 500)
    updated = put("A", 5)
    assert updated["root"] == "B" and updated["size"] == 2
    wait_until(initial["expiry"] + 20)
    read("A", 200)

    next_root = expiry("B", "A", updated["expiry"], 1)
    expiry("A", None, next_root["expiry"], 2)
    read("C", 200)
    for event in timeline:
        event["at"] -= origin
        if event.get("expiry") is not None:
            event["expiry"] -= origin
    return {"timeline": timeline}


if __name__ == "__main__":
    compiler = which("clang++") or which("c++") or "clang++"
    check_call(
        ["make", "-s", f"CXX={compiler}", "build/mini-redis", "build/engine-bench"],
        cwd=ROOT, stdout=sys.stderr, timeout=20,
    )
    comparison = json.loads(check_output(
        [str(ROOT / "build/engine-bench"), "--compare-ttl-lookup"], timeout=15,
    ))
    with TemporaryDirectory(prefix="mini-redis-ttl-") as directory:
        server = Server(ROOT / "build/mini-redis", directory, "--trace-ttl")
        try:
            result = measure(server)
        finally:
            server.close()
    print(json.dumps({**result, "comparison": comparison}))
