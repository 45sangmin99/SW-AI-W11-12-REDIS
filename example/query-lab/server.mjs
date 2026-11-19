import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const cases = {
  id: "SELECT id, name, attack FROM characters WHERE id = 42;",
  top: "SELECT id, name, attack FROM characters WHERE attack >= 100 ORDER BY attack DESC, id ASC LIMIT 20;",
};
const engine = new URL("./engine/", import.meta.url);
const assets = new Map([
  ["/", [new URL("index.html", import.meta.url), "text/html"]],
  ["/app.mjs", [new URL("app.mjs", import.meta.url), "text/javascript"]],
  ["/style.css", [new URL("style.css", import.meta.url), "text/css"]],
  ...["component", "diff", "patch", "props", "vdom"].map(name =>
    [`/engine/${name}.js`, [new URL(`${name}.js`, engine), "text/javascript"]]),
]);

function summarize(times, dbCalls) {
  const sorted = times.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    samples: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    dbCalls,
  };
}

export async function compare(sql, query, cache, samples = 50) {
  const key = `/keys/query-lab:${randomUUID()}`;
  let dbCalls = 0;
  let filled = false;
  const direct = async () => {
    dbCalls++;
    return query(sql);
  };
  const cached = async () => {
    const response = await cache("GET", key);
    if (response.ok) return { source: "hit", data: JSON.parse((await response.json()).value) };
    if (response.status !== 404) throw new Error(`Redis GET failed (${response.status})`);
    await response.text();
    const data = await direct();
    const put = await cache("PUT", key, { value: JSON.stringify(data), ttl_seconds: 120 });
    if (put.status !== 204) throw new Error(`Redis PUT failed (${put.status})`);
    filled = true;
    return { source: "miss", data };
  };
  const measure = async operation => {
    const start = performance.now();
    const result = await operation();
    return { result, ms: performance.now() - start };
  };

  try {
    let expected;
    for (let i = 0; i < 5; i++) expected = await direct();
    if (!expected.rows.length) throw new Error("실습 데이터가 비어 있습니다. seed.mjs로 생성한 DB를 사용하세요.");

    dbCalls = 0;
    const miss = await measure(cached);
    assert.equal(miss.result.source, "miss");
    assert.deepEqual(miss.result.data, expected);
    const missStats = summarize([miss.ms], dbCalls);

    async function verifyHit() {
      const hit = await measure(cached);
      assert.equal(hit.result.source, "hit");
      assert.deepEqual(hit.result.data, expected);
      return hit.ms;
    }
    for (let i = 0; i < 5; i++) await verifyHit();
    dbCalls = 0;
    const directTimes = [];
    const hitTimes = [];
    const recordDirect = async () => {
      const sample = await measure(direct);
      assert.deepEqual(sample.result, expected);
      directTimes.push(sample.ms);
    };
    const recordHit = async () => hitTimes.push(await verifyHit());
    for (let i = 0; i < samples; i++) {
      // Alternate the order so neither path always runs first.
      const pair = i % 2 ? [recordHit, recordDirect] : [recordDirect, recordHit];
      for (const record of pair) await record();
    }
    assert.equal(dbCalls, samples);
    return {
      result: expected,
      direct: summarize(directTimes, dbCalls),
      miss: missStats,
      hit: summarize(hitTimes, dbCalls - directTimes.length),
    };
  } finally {
    // TTL also removes the key if cleanup cannot reach Redis.
    if (filled) await cache("DELETE", key).then(response => response.text()).catch(() => {});
  }
}

async function runEngineLab(name) {
  const script = `example/query-lab/${name}.py`;
  const [command, ...args] = process.platform === "win32"
    ? ["wsl", "--exec", "python3", script]
    : ["python3", script];
  const { stdout } = await promisify(execFile)(command, args, {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    windowsHide: true,
    timeout: 50_000,
  });
  return JSON.parse(stdout);
}

export function webServer(query, cache) {
  let running = false;
  return createServer(async (req, res) => {
    function send(status, type, body) {
      res.writeHead(status, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
      res.end(body);
    }
    const json = (status, data) => send(status, "application/json", JSON.stringify(data));
    try {
      if (req.method === "GET" && req.url === "/api/queries") return json(200, cases);
      const match = req.method === "POST" && /^\/api\/compare\/(id|top|rehash|ttl)$/.exec(req.url);
      if (match && req.headers["x-query-lab"] === "1") {
        if (running) return json(409, { error: "다른 측정이 진행 중입니다." });
        running = true;
        try {
          if (match[1] === "rehash" || match[1] === "ttl") return json(200, await runEngineLab(match[1]));
          return json(200, await compare(cases[match[1]], query, cache));
        } finally {
          running = false;
        }
      }
      const asset = req.method === "GET" && assets.get(req.url);
      if (!asset) return json(404, { error: "경로를 찾을 수 없습니다." });
      return send(200, asset[1], await readFile(asset[0]));
    } catch (error) {
      console.error(error);
      const message = ["/api/compare/rehash", "/api/compare/ttl"].includes(req.url)
        ? "Redis 실습을 실행하지 못했습니다. Python 3, Make, C++ 컴파일러를 확인하세요. Windows에서는 WSL을 사용합니다."
        : "측정에 실패했습니다. 두 엔진, 실습 데이터, 토큰을 확인하세요.";
      json(503, { error: message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const token = process.env.MINIDB_TOKEN;
  if (!token) throw new Error("Set MINIDB_TOKEN to the DBMS server token");
  const dbUrl = process.env.MINIDB_URL || "http://127.0.0.1:18080";
  const redisUrl = process.env.MINIREDIS_URL || "http://127.0.0.1:16380";
  async function query(sql) {
    const response = await fetch(new URL("/query", dbUrl), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sql }),
      signal: AbortSignal.timeout(4000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`DBMS query failed (${response.status})`);
    return { columns: result.columns.map(column => column.name), rows: result.rows };
  }
  const cache = (method, path, data) => fetch(new URL(path, redisUrl), {
    method,
    headers: data ? { "Content-Type": "application/json" } : undefined,
    body: data ? JSON.stringify(data) : undefined,
    signal: AbortSignal.timeout(4000),
  });
  const port = Number(process.env.QUERY_LAB_PORT || 13010);
  webServer(query, cache).listen(port, "127.0.0.1", () => {
    console.log(`Query Lab · http://127.0.0.1:${port}`);
  });
}
