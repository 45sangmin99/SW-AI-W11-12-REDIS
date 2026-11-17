import assert from "node:assert/strict";

const base = process.argv[2] || "http://127.0.0.1:13010";
for (const [path, content] of [["/", "Redis / DBMS"], ["/engine/component.js", "FunctionComponent"]]) {
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, 200);
  assert.ok((await response.text()).includes(content));
}

for (const [name, rows] of [["id", 1], ["top", 20]]) {
  const response = await fetch(new URL(`/api/compare/${name}`, base), {
    method: "POST", headers: { "X-Query-Lab": "1" },
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.equal(result.result.rows.length, rows);
  assert.deepEqual([result.direct.dbCalls, result.miss.dbCalls, result.hit.dbCalls], [50, 1, 0]);
  assert.deepEqual([result.direct.samples, result.miss.samples, result.hit.samples], [50, 1, 50]);
  console.log(name, { direct: result.direct, miss: result.miss, hit: result.hit });
}

const response = await fetch(new URL("/api/compare/rehash", base), {
  method: "POST", headers: { "X-Query-Lab": "1" },
});
const result = await response.json();
assert.equal(response.status, 200, JSON.stringify(result));
assert.equal(result.keys, 49152);
assert.deepEqual(result.window, [-15, 40]);
assert.ok(result.modes.incremental.maxNodes <= 4);
assert.equal(result.modes.allAtOnce.maxNodes, result.keys);
for (const mode of Object.values(result.modes)) {
  assert.equal(mode.moved, result.keys);
  assert.ok(mode.resizeMs > 0 && mode.maxMs >= mode.p99);
  assert.ok(mode.points.every(point => point.ok));
  assert.ok(mode.points.some(point => point.at < 0));
  assert.ok(mode.points.some(point => point.at >= 0));
}
assert.equal(result.comparison.repeats, 11);
assert.deepEqual(result.comparison.sizes.map(size => size.nodes), [384, 49152]);
for (const { incremental, allAtOnce } of result.comparison.sizes) {
  for (const measurement of [incremental, allAtOnce]) {
    assert.ok(measurement.peakNs > 0);
    assert.ok(measurement.totalNs >= measurement.peakNs);
  }
}
console.log("rehash", JSON.stringify({
  modes: Object.fromEntries(Object.entries(result.modes).map(([name, { points, ...metrics }]) =>
    [name, { ...metrics, samples: points.length }])),
}));

const ttlResponse = await fetch(new URL("/api/compare/ttl", base), {
  method: "POST", headers: { "X-Query-Lab": "1" },
});
const ttl = await ttlResponse.json();
assert.equal(ttlResponse.status, 200, JSON.stringify(ttl));
assert.deepEqual([ttl.comparison.keys, ttl.comparison.ttlKeys, ttl.comparison.repeats], [50000, 2, 11]);
assert.deepEqual([ttl.comparison.scan.checks, ttl.comparison.heap.checks], [50000, 1]);
assert.deepEqual(ttl.timeline.filter(event => event.kind === "put").map(event => [event.ttl, event.root, event.size]),
  [[1, "A", 1], [5, "A", 2], [null, "A", 2], [5, "B", 2]]);
assert.deepEqual(ttl.timeline.filter(event => event.kind === "expire").map(event => [event.key, event.root]),
  [["B", "A"], ["A", null]]);
assert.deepEqual(ttl.timeline.filter(event => event.kind === "get").map(event => [event.key, event.status]),
  [["A", 200], ["B", 404], ["A", 404], ["C", 200]]);
console.log("ttl", JSON.stringify(ttl.timeline));
