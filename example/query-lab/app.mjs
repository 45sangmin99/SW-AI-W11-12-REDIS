import { FunctionComponent, useState } from "/engine/component.js";

const h = (type, props, ...children) => ({ type, props, children });
const queries = await fetch("/api/queries").then(response => response.json());
const labels = { id: "기본 키로 한 행 조회", top: "조건 검색 후 상위 20행", rehash: "점진적 재해싱", ttl: "TTL 힙" };
const engineLabs = {
  rehash: {
    intro: "버킷을 확장하는 순간 도착한 GET은 얼마나 기다릴까요? 기존 키 49,152개를 점진적으로 옮길 때와 한꺼번에 옮길 때를 같은 HTTP 부하로 비교합니다.",
    button: "재해싱 실습 실행",
    status: "임시 Redis에 실습 데이터를 채우고 두 방식의 GET 지연을 측정하는 중…",
  },
  ttl: {
    intro: "키 5만 개에서 다음 만료 대상을 찾으려면 몇 개를 확인해야 할까요? 전체 훑기와 TTL 힙을 비교한 뒤, TTL을 바꾸면 다음 대상이 어떻게 바뀌는지 봅니다.",
    button: "TTL 실습 실행",
    status: "다음 만료 키를 찾는 비용을 비교하고, 실제 만료를 기다리는 중… 약 5.5초 소요",
  },
};
const paths = [
  ["direct", "DBMS 직접 조회", "Mini DBMS → 결과"],
  ["miss", "Redis MISS", "Redis → Mini DBMS → Redis 저장 → 결과"],
  ["hit", "Redis HIT", "Redis → 결과"],
];
const format = ms => ms.toFixed(3);

function TtlComparison({ comparison }) {
  const number = value => value.toLocaleString("ko-KR");
  return h("section", { class: "panel", "aria-labelledby": "ttl-comparison" },
    h("h2", { id: "ttl-comparison" }, "다음 만료 키를 찾는 데 몇 개를 확인할까?"),
    h("p", {}, `전체 키 ${number(comparison.keys)}개 중 TTL이 있는 키는 ${comparison.ttlKeys}개입니다. 두 방식 모두 같은 다음 만료 키를 찾았습니다.`),
    h("div", { class: "paths phase-stats" },
      ...[["scan", "전체 키 훑기"], ["heap", "TTL 힙의 맨 위 보기"]].map(([key, label]) =>
        h("article", { key, class: `path ${key === "heap" ? "hit" : "direct"}` },
          h("h3", {}, label),
          h("div", { class: "value" }, number(comparison[key].checks), h("span", {}, "개 확인")),
          h("p", { class: "metric" }, `탐색 중앙값 ${(comparison[key].ns / 1000).toFixed(3)} µs · ${comparison.repeats}회`)))),
    h("p", { class: "note" }, "Redis는 힙 맨 위의 만료 시각이 아직 오지 않았으면 이번 정리를 끝냅니다. 이 측정은 다음 대상 찾기만 포함합니다. TTL을 설정하거나 갱신할 때는 힙의 순서를 유지하는 작업이 들어갑니다."));
}

function TtlResults({ result }) {
  const seconds = ms => `${(ms / 1000).toFixed(3)}초`;
  function describe(event) {
    if (event.kind === "expire") return `이벤트 루프가 ${event.key} 정리`;
    if (event.kind === "get") return `GET ${event.key} · ${event.status === 200 ? "200 값 반환" : "404 만료됨"}`;
    if (event.ttl === null) return `PUT ${event.key} · 만료 없음`;
    return `PUT ${event.key} · TTL ${event.ttl}초`;
  }
  return h("section", { class: "panel", "aria-labelledby": "ttl-results" },
    h("h2", { id: "ttl-results" }, "TTL 갱신과 만료 순서"),
    h("p", {}, "A를 갱신하자 힙의 맨 위가 A에서 B로 바뀌었습니다. A는 원래 만료 시각을 지나서도 읽혔고, 이벤트 루프가 B와 A를 차례로 정리했습니다."),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, ...["경과", "동작", "가장 먼저 만료될 키", "힙 안의 키 수"].map(title =>
        h("th", { key: title, scope: "col" }, title)))),
      h("tbody", {}, ...result.timeline.map((event, index) =>
        h("tr", { key: index },
          h("td", {}, seconds(event.at)),
          h("td", {}, describe(event)),
          h("td", {}, event.kind === "get" ? "—" : event.root
            ? h("strong", { class: "ttl-root" }, `${event.root} · ${seconds(event.expiry)}에 만료 예정`)
            : "비어 있음"),
          h("td", {}, event.size === undefined ? "—" : String(event.size))))))),
    h("p", { class: "note" }, "힙 값은 PUT 반영 직후와 이벤트 루프의 정리 직후에 찍은 엔진 로그입니다. 만료된 키의 404는 정리 로그를 확인한 뒤 요청한 결과입니다."));
}

function MigrationComparison({ comparison }) {
  const time = ns => `${(ns / 1000).toFixed(3)} µs`;
  const count = value => value.toLocaleString("ko-KR");
  return h("section", { class: "panel", "aria-labelledby": "migration-title" },
    h("h2", { id: "migration-title" }, "점진적 이동과 한 번에 이동 비교"),
    h("p", { class: "note" },
      `같은 엔진과 키로 각각 ${comparison.repeats}회 실행한 중앙값입니다. 버킷 할당 이후 노드를 옮기는 구간만 잽니다.`),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {},
        ...["이동할 노드", "지표", "점진적", "한 번에", "한 번에 ÷ 점진적"].map(title =>
          h("th", { key: title, scope: "col" }, title)))),
      h("tbody", {}, ...comparison.sizes.flatMap(({ nodes, incremental, allAtOnce }) =>
        [["peakNs", "가장 긴 단일 이동 단계"], ["totalNs", "전체 이동 시간"]].map(([key, label]) =>
          h("tr", { key: `${nodes}-${key}` },
            h("td", {}, count(nodes)),
            h("th", { scope: "row" }, label),
            h("td", {}, time(incremental[key])),
            h("td", {}, time(allAtOnce[key])),
            h("td", {}, `${(allAtOnce[key] / incremental[key]).toFixed(2)}배`))))))),
    h("p", { class: "note" },
      "가장 긴 단계는 이동 작업이 한 번에 다른 요청 처리를 막을 수 있는 시간을 비교합니다. 전체 이동 시간에는 각 단계를 호출하는 비용도 들어갑니다."));
}

function RehashResults({ result }) {
  const maxMs = Math.max(1, ...Object.values(result.modes).map(mode => mode.maxMs));
  const [left, right] = result.window;
  const x = ms => (ms - left) / (right - left) * 100;
  return h("section", { class: "panel", "aria-labelledby": "rehash-results" },
    h("h2", { id: "rehash-results" }, "확장 순간의 GET 지연 비교"),
    h("p", {}, `같은 기존 키 ${result.keys.toLocaleString("ko-KR")}개, 새 키 ${result.inserts}개, GET 연결 ${result.clients}개로 실행했습니다.`),
    h("p", { class: "note" }, "한꺼번에 옮기면 이벤트 루프가 이동을 마칠 때까지 GET이 기다립니다. 점진적 방식은 이동 단계 사이에도 GET을 처리할 수 있습니다."),
    h("p", { class: "note" }, "가로축 0ms는 각 서버가 노드 이동을 시작한 시점입니다. 같은 눈금 위에 이동 구간을 색으로 표시했습니다."),
    ...[["incremental", "점진적 재해싱"], ["allAtOnce", "한 번에 재해싱"]].map(([key, label]) => {
      const mode = result.modes[key];
      return h("article", { key, class: `rehash-mode ${key}` },
        h("h3", {}, label),
        h("p", {}, `p99 ${format(mode.p99)} ms · 최대 ${format(mode.maxMs)} ms`),
        h("p", { class: "note" },
          `표시된 GET ${mode.points.length}회 중 ${mode.overlapping}회가 이동 시간과 겹쳤습니다. 이동 완료까지 ${format(mode.resizeMs)} ms.`),
        h("p", { class: "note" }, mode.overlapMaxMs === null
          ? "이동과 겹친 GET은 이번 실행에서 관측되지 않았습니다."
          : `이동과 겹친 GET 중 최대 ${format(mode.overlapMaxMs)} ms`),
        h("div", { class: "chart", "aria-hidden": "true" },
          h("span", { class: "chart-axis chart-top" }, `${format(maxMs)} ms`),
          h("span", { class: "chart-axis chart-bottom" }, "0 ms"),
          h("div", { class: "plot" },
            h("i", { class: "resize-window", style: `left:${x(0)}%;right:${100 - x(Math.min(right, mode.resizeMs))}%` }),
            h("i", { class: "resize-marker", style: `left:${x(0)}%` }),
            ...mode.points.map((point, index) => h("i", {
              key: index, class: "dot",
              style: `left:${x(point.at)}%;bottom:${point.ms / maxMs * 100}%`,
            }))),
          h("span", { class: "chart-axis chart-start" }, `${left} ms`),
          h("span", { class: "chart-axis chart-end" }, `+${right} ms`)));
    }),
    h("p", { class: "note" },
      "p99와 최대값은 그래프에 표시된 같은 시간 범위의 GET을 비교합니다. HTTP 통신과 운영체제 스케줄링이 포함되므로 차이의 크기는 실행마다 달라질 수 있습니다."));
}

function Results({ result }) {
  const max = Math.max(result.direct.median, result.miss.median, result.hit.median);
  return h("div", {},
    h("section", { class: "panel", "aria-labelledby": "measurements" },
      h("h2", { id: "measurements" }, "경로별 측정"),
      h("div", { class: "paths" }, ...paths.map(([key, title, path]) => {
        const { median, p95, dbCalls, samples } = result[key];
        return h("article", { key, class: `path ${key}` },
          h("h3", {}, title),
          h("p", { class: "route" }, path),
          h("div", { class: "value" }, format(median), h("span", {}, " ms")),
          h("p", { class: "metric" }, samples === 1 ? "첫 요청 1회" : `중앙값 · ${samples}회`),
          h("div", { class: "track", "aria-hidden": "true" },
            h("div", { class: "bar", style: `width:${max ? median / max * 100 : 0}%` })),
          h("dl", {},
            h("div", {}, h("dt", {}, "p95"), h("dd", {}, samples > 1 ? `${format(p95)} ms` : "—")),
            h("div", {}, h("dt", {}, "DBMS 호출"), h("dd", {}, `${dbCalls}회`))));
      })),
      h("p", { class: "note" }, "웹 서버가 요청을 보내고 응답을 읽는 데 걸린 시간입니다. 워밍업 5회씩은 집계에서 제외합니다.")),
    h("section", { class: "panel" },
      h("h2", {}, "세 경로의 응답 일치"),
      h("p", { class: "note" }, `모든 측정에서 같은 ${result.result.rows.length}행을 반환했습니다.`),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, ...result.result.columns.map(name => h("th", { key: name, scope: "col" }, name)))),
        h("tbody", {}, ...result.result.rows.map(row =>
          h("tr", { key: row[0] }, ...row.map((cell, index) => h("td", { key: index }, cell)))))))));
}

function Lab() {
  const [selected, setSelected] = useState("id");
  const [view, setView] = useState({ running: false, status: "", result: null });
  const engineLab = engineLabs[selected];

  async function run() {
    setView({
      running: true,
      status: engineLab?.status ?? "직접 조회와 캐시 경유 조회를 측정하는 중…",
      result: null,
    });
    try {
      const response = await fetch(`/api/compare/${selected}`, {
        method: "POST", headers: { "X-Query-Lab": "1" },
      });
      if (engineLab && response.status === 404) {
        throw new Error("웹 서버가 이전 버전입니다. PowerShell에서 웹 서버를 Ctrl+C로 종료하고 node ./example/query-lab/server.mjs를 다시 실행한 뒤 새로고침하세요.");
      }
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setView({ running: false, status: "측정 완료", result: data });
    } catch (error) {
      setView({ running: false, status: error.message, result: null });
    }
  }

  return h("div", {},
    h("header", { class: "hero" },
      h("h1", {}, "Redis / DBMS 조회 실습"),
      h("p", {}, "DBMS와 캐시의 조회 경로를 비교하고, 키가 늘어날 때 Redis 내부에서 일어나는 일을 확인합니다.")),
    h("section", { class: "panel", "aria-labelledby": "query-title" },
      h("h2", { id: "query-title" }, "실습 선택"),
      h("div", { class: "choices" }, ...Object.entries(labels).map(([key, label]) =>
        h("button", {
          key, type: "button", "aria-pressed": String(selected === key), disabled: view.running,
          onClick: () => {
            setSelected(key);
            setView({ running: false, status: "", result: null });
          },
        }, label))),
      engineLab
        ? h("p", { class: "experiment-intro" }, engineLab.intro)
        : h("pre", {}, h("code", {}, queries[selected])),
      h("div", { class: "actions" },
        h("button", { class: "run", type: "button", onClick: run, disabled: view.running },
          view.running ? "실행 중…" : engineLab?.button ?? "비교 실행"),
        h("span", { role: "status" }, view.status))),
    ...(view.result ? (selected === "rehash"
      ? [RehashResults({ result: view.result }), MigrationComparison({ comparison: view.result.comparison })]
      : selected === "ttl" ? [TtlComparison({ comparison: view.result.comparison }), TtlResults({ result: view.result })]
      : [Results({ result: view.result })]) : []));
}

new FunctionComponent(Lab, {}, document.querySelector("#lab")).mount();
