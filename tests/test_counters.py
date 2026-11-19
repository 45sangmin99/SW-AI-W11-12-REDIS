"""Atomic durable counters, global event dedupe, retries, and failure boundaries."""
import concurrent.futures
import json
from pathlib import Path
import sys
import tempfile

from support import ROOT, Server, http, wait_for

BINARY = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / 'build/mini-redis').resolve()


def increment(server, event, delta=1, key='downloads'):
    status, body, _ = http(server.port, 'POST', '/counters/' + key + '/incrbyonce',
                            {'event_id': f'{event:064x}', 'delta': delta})
    return status, json.loads(body)


with tempfile.TemporaryDirectory() as folder:
    server = Server(BINARY, folder)
    try:
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda _: increment(server, 1), range(24)))
        assert all(status == 200 for status, _ in results)
        assert sum(result['applied'] for _, result in results) == 1
        assert increment(server, 1, 2)[0] == 409
        assert increment(server, 1, key='other')[0] == 409
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda event: increment(server, event), range(2, 102)))
        assert all(status == 200 and result['applied'] for status, result in results)
        assert json.loads(http(server.port, 'GET', '/counters/downloads')[1]) == {'value': '101'}
        assert server.event('sync_done'), 'Counter ACK must follow fsync'
        size = server.aof.stat().st_size
        for delta in [0, -1, True, 1.5, '1', 9223372036854775808]:
            assert increment(server, 200, delta)[0] == 400
        for body in ['{}', '{"event_id":"a","delta":1}',
                     '{"event_id":"' + 'a'*64 + '","delta":01}',
                     '{"event_id":"' + 'a'*64 + '","delta":1,"delta":2}',
                     '{"event_id":"' + 'a'*64 + '","delta":1,}']:
            assert http(server.port, 'POST', '/counters/downloads/incrbyonce', raw=body.encode())[0] == 400
        assert server.call('PUT', '%40counter%3Adownloads', {'value': '999'})[0] == 400
        assert server.call('DELETE', '%40event%3A' + f'{1:064x}')[0] == 400
        assert server.aof.stat().st_size == size
        server.close(kill=True)
        server = Server(BINARY, folder)
        assert increment(server, 1) == (200, {'value': '1', 'applied': False})
        assert json.loads(http(server.port, 'GET', '/counters/downloads')[1])['value'] == '101'
        assert increment(server, 300, 9223372036854775807 - 101)[0] == 200
        assert increment(server, 301)[0] == 400
    finally:
        server.close()

# The counter ACK and both entries wait for fsync, while independent GETs run.
with tempfile.TemporaryDirectory() as folder:
    server = Server(BINARY, folder, '--sync-delay-ms', '600')
    try:
        assert server.call('PUT', 'seed', {'value': 'available'})[0] == 204
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            writing = pool.submit(increment, server, 1)
            wait_for(lambda: server.event('sync_start 2'))
            assert server.call('GET', 'seed')[0] == 200
            assert http(server.port, 'GET', '/counters/downloads')[0] == 404
            assert not writing.done(), 'ACK must wait for the counter fsync'
            assert writing.result() == (200, {'value': '1', 'applied': True})
            assert server.event('sync_done 2')
        assert increment(server, 1) == (200, {'value': '1', 'applied': False})
    finally:
        server.close()

for args in [('--memory-limit', '220'), ('--fail-prepare', '1'),
             ('--fail-write-after', '10'), ('--fail-sync', '1')]:
    with tempfile.TemporaryDirectory() as folder:
        server = Server(BINARY, folder, *args)
        try:
            assert increment(server, 1)[0] == 503, args
            assert http(server.port, 'GET', '/counters/downloads')[0] == 404, args
        finally:
            server.close(kill=True)
        server = Server(BINARY, folder)
        try:
            assert increment(server, 1)[0] == 200
            assert json.loads(http(server.port, 'GET', '/counters/downloads')[1])['value'] == '1'
        finally:
            server.close()

print('PASS counters: concurrent dedupe/increments, conflicts, validation, fsync, SIGKILL replay, memory/write/sync failures')
