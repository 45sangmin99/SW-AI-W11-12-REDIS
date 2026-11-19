# HTTP·AOF 상세 동작

## 공개 HTTP 계약

### 영구 카운터와 중복 없는 증가

```sh
curl -s -X POST http://127.0.0.1:6380/counters/downloads/incrbyonce \
  -H 'Content-Type: application/json' \
  --data-binary '{"event_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","delta":1}'
# 200 {"value":"1","applied":true}
# 같은 요청 재시도: 200 {"value":"1","applied":false}
curl -s http://127.0.0.1:6380/counters/downloads
# 200 {"value":"1"}; 없는 카운터는 404
```

`event_id`는 64자리 소문자 16진수이며 전체 카운터에 걸쳐 한 증가에 귀속됩니다. 같은 ID의 다른 키·증가량은 409입니다. `delta`는 1..INT64_MAX 정수이며 합계 오버플로는 400입니다. 값은 정밀도 손실을 막기 위해 JSON 문자열로 응답합니다. 중복 요청에는 그 이벤트가 처음 생성했던 결과값을 반환하며, 현재 누계는 GET으로 조회합니다.

카운터와 처리한 ID는 TTL 없이 보존합니다. 내부 `@counter:`·`@event:` 키는 일반 `/keys` API로 읽거나 덮어쓰거나 삭제할 수 없습니다. 두 노드의 메모리 한도와 할당을 함께 준비하고, **단일 `I` AOF 레코드의 append+fsync 후** 둘을 할당 없이 게시합니다. fsync 실패 시 성공 응답을 하지 않으며 추가 쓰기를 차단합니다. 결과를 확인하지 못한 클라이언트는 같은 ID로 재시도합니다. 완전한 `I` 레코드는 재시작 시 두 상태를 함께 복원하고 불완전한 마지막 레코드는 기존 tail 복구 규칙을 적용합니다. 기존 `P`/`D` AOF와 호환됩니다. 카운터의 append와 fsync는 AOF 스레드에서 실행합니다. 그 사이 다른 연결의 GET은 마지막으로 반영된 값을 읽습니다.

`make test` 및 CTest의 `counters`는 동시 중복 요청, 여러 이벤트 증가, 전역 ID 충돌, 오버플로·JSON 검증, ACK 후 SIGKILL 복구, 메모리 한도/준비/부분 쓰기/fsync 실패를 실제 서버로 검사합니다. 중복 제거 ID와 AOF 정리는 구현하지 않았으므로 저장량은 계속 증가합니다. 이 카운터는 원본 이벤트 DB에서 재구축할 수 있는 집계용입니다.

### 노래방 DB UNIQUE 연동 정책 (2026-11-17)

노래방 서버는 같은 C DBMS의 `download_events.download_id`와 `counter_outbox.download_id`에 UNIQUE 인덱스를 생성합니다. 승인 기록과 outbox는 하나의 DB 트랜잭션이며, Redis 반영은 outbox 작업자가 같은 다운로드 ID를 `event_id`로 전달합니다. Redis에서 증가+중복 제거 ID를 단일 AOF 레코드로 fsync한 응답을 받은 뒤 DB 작업을 완료 표시합니다.

DB UNIQUE와 Redis INCRBYONCE는 각각 원본 중복과 재전달 중복을 막습니다. DB 커밋 후 Redis 반영까지의 지연을 허용하는 최종 일관성이며 두 저장소의 원자적 동시 커밋은 아닙니다. Redis 응답을 잃으면 같은 ID로 재전달하고, 원본 DB 커밋 결과를 모를 때는 INSERT를 무조건 재실행하지 않습니다. 통합 검사에서 Redis의 이벤트 중복 제거와 재시작 복구를 검증합니다.

### 문자열과 TTL

```sh
curl -i -X PUT http://127.0.0.1:6380/keys/keyboard \
  -H 'Content-Type: application/json' \
  --data-binary '{"value":"keyboard","ttl_seconds":60}'
# 204, 본문 없음
curl -i http://127.0.0.1:6380/keys/keyboard
# 200 {"value":"keyboard"}
curl -i http://127.0.0.1:6380/keys/keyboard/ttl
# 200 {"ttl_seconds":60} (실제 남은 시간에 따라 감소)
curl -i -X DELETE http://127.0.0.1:6380/keys/keyboard
# 204, 본문 없음
curl -i http://127.0.0.1:6380/keys/keyboard
# 404 {"error":"key not found"}
```

| 동작 | 성공 | 없는/만료된 키 |
|---|---|---|
| `PUT /keys/{key}` | 204 | 생성 가능 |
| `GET /keys/{key}` | 200 `{"value":"..."}` | 404 |
| `GET /keys/{key}/ttl` | 200 `{"ttl_seconds":정수 또는 null}` | 404 |
| `DELETE /keys/{key}` | 204 | 404 |

`value`는 필수 JSON 문자열이며 빈 문자열도 값이다. TTL은 생략 가능한 양의 JSON 정수다. 0·음수·소수·지수 표기·문자열·null·bool·정수/만료 시각 오버플로는 400이다. 중복/알 수 없는 필드, trailing comma, 잘못된 UTF-8/Unicode escape/짝 없는 surrogate도 400이다. TTL 생략 덮어쓰기는 기존 TTL을 제거한다. TTL은 남은 양의 ms를 초로 올림하며 만료 시각과 같아지는 순간 404다.

경로 segment를 **먼저 분리하고 한 번만** percent-decode한다. `a/ttl` 키는 `/keys/a%2Fttl`, 이 키의 TTL은 `/keys/a%2Fttl/ttl`이다. `+`는 그대로 `+`다. 빈 키, 512바이트 초과, 잘못된 encoding, ASCII/C1 제어문자와 유효하지 않은 UTF-8 키를 거부한다. 쿼리/fragment는 지원하지 않으며 필요한 문자 자체는 percent-encode한다. RESP/redis-cli 호환은 없다.

잘못된 요청은 `{"error":"..."}` 형태다. 미지원 메서드 405, 경로 없음 404, JSON/HTTP 구문 오류 400, 명시한 Content-Type이 JSON이 아니면 415, 본문 초과 413, 헤더 초과 431, Expect 미지원 417, 쓰기/자원 실패 503이다. Content-Type 생략은 허용한다. JSON은 `application/json` 또는 `application/json; charset=utf-8`을 받는다. 상세 저장 장치 오류는 stderr에 기록한다. 204 응답 본문은 비어 있다.

## 구조와 스레드

| 파일 | 책임 |
|---|---|
| `src/engine.hpp` | 키/값 소유, FNV-1a, chaining, 점진적 재배치, indexed heap, validate |
| `src/aof.hpp` | 바이너리 레코드, 잠금, replay/repair, 백그라운드 append와 fsync |
| `src/http.hpp`, `src/text.hpp` | 스트리밍 HTTP/엄격한 JSON/UTF-8 검증과 직렬화 |
| `src/main.cpp` | CLI, 소켓 RAII, poll 연결 루프, HTTP→명령 매핑 |
| `tests/` | 단위/실제 프로세스 통합/실패 주입 및 실행 결과 |
| `example/` | 한 번 로드한 상품 데이터와 별도 HTTP API |
| `benchmarks/` | 재현 스크립트, 직접 GET 측정, 관측 결과/타임라인 |

키 공간은 이벤트 루프만 수정한다. AOF 스레드는 로그를 쓰고 동기화하며, 완료를 파이프로 알려 `poll()`을 깨운다. 변경 명령은 한 건씩 처리한다. 대기 중인 연결은 후속 명령을 실행하지 않으며, 다른 연결의 GET은 마지막으로 반영된 유효한 값을 읽는다. 다른 연결에 대기 중인 변경이 있으면 연결당 요청 하나를 보류해 응답 순서를 유지한다. DELETE 204 완료 후 새 PUT 없이 시작한 GET은 404다.

리스닝/연결 소켓은 non-blocking이고 poll()을 사용한다. 부분 recv/send, 연속 요청, Keep-Alive와 pipeline을 지원하며 같은 연결 응답은 FIFO다. 매 연결 read/write는 반복당 각각 최대 64KiB, 명령은 연결당 4개/전체 64개, accept는 16개다. 연결 처리 시작점을 회전한다. TTL active 정리는 반복당 64개다. 기본 poll 대기는 10ms다.

동일 Content-Length 중복도 보수적으로 400으로 거부한다. Transfer-Encoding은 chunked를 포함해 전부 거부한다. Host가 필수다. framing 오류는 그 연결에 오류 응답 후 닫는다. 짧은 본문은 추가 바이트를 기다리며, write-half-close로 부족함이 확정되면 400, 유휴 타임아웃이면 연결을 닫는다. 클라이언트가 선언한 길이보다 뒤에 보낸 바이트는 HTTP/1.1의 다음 요청으로 해석한다. 이 경우 임의로 길이를 추정하지 않는다.

기본 한도는 헤더 16KiB, 본문 1MiB, 누적 입력 1,100,000바이트, 연결 256개, 무활동 10초다. 출력 2MiB 도달 시 추가 읽기/명령 실행을 멈추므로, 마지막 단일 응답까지 포함하면 약 3.1MiB 미만의 문자열이 연결별로 대기할 수 있다(allocator capacity 제외). 연결 한도를 넘으면 새 연결을 닫는다. 느린 수신자에게 다른 연결의 진행을 맡기지 않는다. 전체 프로세스 RSS 제한은 제공하지 않는다.

CLI: `--host`(IPv4, 기본 127.0.0.1), `--port`(6380), `--aof-path`(appendonly.aof), `--memory-limit`(67108864), `--max-connections`(256), `--idle-seconds`(10). 메모리 한도는 **엔트리 구조체+키+값 논리 바이트**의 한도이며 버킷/heap capacity/문자열 여유 용량/네트워크 버퍼/AOF 임시 문자열은 포함하지 않는다. 이 한도 초과 시 데이터를 축출하지 않고 PUT을 503으로 거부한다. 배열/노드 실제 할당 실패도 성공으로 처리하지 않는다. 불변식 오류/복구 불가능 예외는 fail-stop 처리한다.

인증/TLS는 없다. 기본은 loopback이며, 외부 바인딩은 신뢰할 수 있는 환경에서만 명시적으로 선택해야 한다. 소켓과 영속화의 POSIX 코드는 각각 main/aof 모듈에 모여 있다. Windows는 지원하지 않는다.

## AOF와 성공 응답의 의미

PUT은 JSON/TTL/논리 한도 검사 → 문자열·노드·heap capacity·필요한 버킷 배열 준비 → 레코드 문자열 준비 → 전체 append → 예외 없는 메모리 commit → 204 순서다. UPDATE commit은 문자열 swap과 heap/pointer 연산만 한다. DELETE도 엔트리 확인 → append → 해당 포인터 제거 → 204다. 없는/만료된 키 DELETE는 404이며 DEL 레코드를 추가하지 않는다. 실제 allocator 실패 주입과 commit 중 allocator 차단으로 이 경계를 검사했다.

레코드는 고정 폭 **little endian**이다. `MRD1`이 버전 1을 나타낸다.

| 오프셋 | 크기 | 필드 |
|---|---|---|
| 0 | 4 | ASCII `MRD1` |
| 4 | 4 | 레코드 전체 바이트 수 = 41+key_length+value_length |
| 8 | 4 | 헤더 CRC32: bytes [0,8)+[12,37) |
| 12 | 8 | sequence (1부터 연속) |
| 20 | 1 | `P` PUT / `D` DELETE / `I` 카운터 증가 |
| 21 | 8 | epoch ms 만료 시각 (0은 무기한) |
| 29 | 4 | key_length |
| 33 | 4 | value_length (DELETE는 0) |
| 37 | 가변 | key, value 바이트 |
| 끝-4 | 4 | 앞의 전체 레코드에 대한 CRC32 |

CRC32는 표준 IEEE 다항식 0xEDB88320이다. 레코드 최대 1,100,000바이트, 키 최대 512바이트, 값 최대 1MiB다. 헤더 자체 CRC가 길이 필드 손상을 검출하므로 중간 길이 손상을 잘린 꼬리로 오인해 지우지 않는다. CRC는 악의적 변조를 인증하지 않는다.

카운터의 `I` 레코드는 `event_id`, 양의 증가량, 증가 후 값을 줄바꿈으로 구분해 값 영역에 저장하며 TTL은 0입니다. 복구 시 앞선 값과 증가량으로 결과를 검증해 값과 이벤트 ID를 함께 복원합니다.

append는 EINTR/짧은 write를 반복하며 전체 레코드 성공 후에만 `appended_seq`를 게시한다. I/O 실패 시 해당 변경을 메모리에 반영하지 않고 이후 변경을 차단한다. 부분 레코드는 남을 수 있으며 다음 시작에서 규칙에 맞는 꼬리만 절단한다. 읽기/TTL은 계속 제공한다. 성공한 append는 연결이 끊겨도 반영한다. append 성공 후 메모리 반영 시점에 fsync 실패를 관측하면 503을 보낼 수 있다. **실패 응답이나 끊긴 연결은 rollback을 뜻하지 않는다.** 일반 키 명령에는 요청 ID가 없으며, 카운터 경로는 `event_id`로 같은 증가의 중복 적용을 막습니다.

백그라운드 스레드는 약 1초 주기로 dirty 여부를 확인하고, 새 append가 있을 때만 `fsync(fd)`를 실행한다. 같은 스레드에서 두 I/O를 직렬화하므로 fsync 도중 제출된 append는 동기화가 끝난 뒤 실행된다. 그동안 GET/TTL을 계속 처리한다. fsync 실패는 stderr/시험 이벤트/이후 변경 요청 503으로 드러난다.

시작 시 flock(LOCK_EX|LOCK_NB) → 파일 크기/각 헤더·레코드 CRC/길이·type·sequence·텍스트·만료 의미 검사 → 동일 keyspace 변경 경로로 replay → 복구 파일 fsync/워터마크 초기화 → 만료 제거/validate → 부모 디렉터리 fsync → listen 순서다. 복구된 완전한 레코드도 시작 시 fsync한 다음 synced watermark를 설정한다. 같은 AOF 파일을 두 프로세스가 동시에 소유할 수 없다. 잠금은 같은 inode를 대상으로 하므로 운영 중 AOF를 외부에서 교체/수정/삭제해서는 안 된다.

끝의 잘린 헤더(올바른 magic prefix/가능한 길이) 또는 유효한 헤더 뒤 부족한 본문만 마지막 완전 오프셋으로 ftruncate하고 fsync한다. 완전 레코드 CRC 오류, 헤더 CRC 오류, 불가능한 명령/길이/sequence는 시작 실패다. 손상 로그를 빈 파일로 초기화하지 않는다. ftruncate 직후/fsync 전에 SIGKILL 후 재시작하는 idempotence도 검증했다. CRC로도 구분할 수 없는 일부 짧은 마지막 헤더 prefix 손상은 잘린 꼬리와 구별할 수 없다.

**204는 append+메모리 반영 성공이며 해당 쓰기의 fsync 완료를 의미하지 않는다.** 전원/OS/저장 장치 장애로 미동기화 append가 사라지면 이미 204를 받은 쓰기도 유실될 수 있다. 1초는 호출 주기이며 데이터 손실 시간의 엄격한 상한이 아니다. 지연 주입 시 주기는 완료 후 다음 1초를 기다리므로 더 길어진다. SIGKILL은 OS 페이지 캐시를 지우지 않는다. 이번 검증은 실제 프로세스 강제 종료이며 전원 장애 재현이 아니다. macOS에서도 요청된 fsync를 사용하며 F_FULLFSYNC나 저장 장치 내부 캐시/하드웨어 보장은 검증하지 않았다.

## TTL과 기록 중인 엔트리

만료 시각은 벽시계의 절대 시각입니다. 벽시계가 뒤로 가면 아직 정리되지 않은 키의 수명이 길어질 수 있고 앞으로 뛰면 빨리 만료될 수 있습니다. 벽시계 역행 뒤 재시작하면 이전에 만료된 AOF 레코드가 다시 유효한 시각으로 해석될 수 있습니다.

기록 중인 갱신이나 삭제가 기존 엔트리를 가리키면 완료까지 해당 엔트리를 해제하지 않습니다. 그 사이 만료된 값은 GET에서 숨기며, 그 엔트리가 힙의 맨 위에 있을 때는 다른 만료 엔트리의 능동 정리가 밀릴 수 있습니다.

## append 측정 재현

통합 Redis 저장소 루트에서 C++20 환경으로 실행합니다. 이전과 현재 서버를 같은 옵션으로 빌드하고, 실행 순서를 번갈아 바꿉니다. 아래 명령은 `build/append-comparison.json`에 HTTP GET/PUT 타임라인을 저장합니다.

```sh
make build/mini-redis
mkdir -p build/benchmark-before
git archive c4f3b9e src | tar -x -C build/benchmark-before
clang++ -std=c++20 -O2 -g -Wall -Wextra -Wpedantic -pthread \
  build/benchmark-before/src/main.cpp -o build/mini-redis-before
PYTHONPATH=benchmarks python3 - <<'PY'
import json
from pathlib import Path
import run

modes = [('before', 'mini-redis-before'), ('integrated', 'mini-redis')]
results = []
for repeat in range(3):
    for name, binary in (modes if repeat % 2 == 0 else modes[::-1]):
        run.BINARY = Path('build', binary).resolve()
        results.append(dict(mode=name, repeat=repeat + 1, rows=run.engine_bench()))
Path('build/append-comparison.json').write_text(json.dumps(results, indent=2) + '\n')
PY
```
