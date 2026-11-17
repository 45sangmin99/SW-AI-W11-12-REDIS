# Redis / DBMS 조회 실습

Mini DBMS의 기본 키 조회와 조건 검색·정렬 결과를 Mini Redis에 캐시합니다. Mini React 화면에서 SQL을 고르고 **비교 실행**을 누르면 DBMS 직접 조회, 첫 MISS, 이후 HIT의 지연과 DBMS 호출 수를 볼 수 있습니다. 두 엔진은 기존 HTTP API를 사용합니다.

## 실행

Windows에서는 **PowerShell 두 용도(데이터 생성, 웹 서버)**와 **WSL Bash 두 개(DBMS, Redis)**를 사용합니다. 명령은 모두 `example/`과 `Makefile`이 보이는 **안쪽 Redis 저장소 루트**를 기준으로 합니다. Windows에 Node.js 20 이상이 있으면 WSL에 Node.js를 따로 설치할 필요가 없습니다. Linux·macOS에서는 PowerShell 단계의 `node` 명령도 일반 셸에서 실행할 수 있습니다.

1. **Windows PowerShell**에서 실습 데이터를 생성합니다. 이미 만든 `query-lab-data-*` 폴더가 있으면 이 단계는 건너뛰세요.

   ```powershell
   node ./example/query-lab/seed.mjs
   ```

   출력 경로의 마지막 폴더 이름을 2단계의 `query-lab-data-XXXXXX` 자리에 넣으세요.

2. **첫 번째 WSL Bash**에서 Mini DBMS를 실행합니다. PowerShell을 새로 열었다면 안쪽 저장소 루트에서 `wsl -- bash`를 입력해 전환한 뒤 아래 블록을 붙여넣으세요. DBMS 데이터는 WSL의 Linux 파일시스템에 둡니다.

   ```sh
   make -C ../../SW-AI-W11-12-DBMS/reliable build/mini-db-server
   db_dir=$(mktemp -d)
   cp ./query-lab-data-XXXXXX/characters.{schema,csv} "$db_dir/"
   MINIDB_TOKEN=query-lab-local ../../SW-AI-W11-12-DBMS/reliable/build/mini-db-server \
     --data-dir "$db_dir" --port 18080 --threads 4
   ```

   DBMS가 포트 `18080`에서 대기하면 이 터미널을 켜 두세요.

3. **두 번째 WSL Bash**에서 Mini Redis를 실행합니다. 이 터미널도 켜 두세요.

   ```sh
   make build/mini-redis
   redis_dir=$(mktemp -d)
   ./build/mini-redis --port 16380 --aof-path "$redis_dir/lab.aof"
   ```

4. **Windows PowerShell**에서 웹 서버를 실행합니다. 1단계의 PowerShell을 그대로 써도 됩니다.

   ```powershell
   $env:MINIDB_TOKEN = 'query-lab-local'
   node ./example/query-lab/server.mjs
   ```

   [실습 페이지](http://127.0.0.1:13010/)를 엽니다. 포트가 겹치면 `MINIDB_URL`, `MINIREDIS_URL`, `QUERY_LAB_PORT`를 조정하세요.

   Linux·macOS에서는 `MINIDB_TOKEN=query-lab-local node ./example/query-lab/server.mjs`로 웹 서버를 실행합니다.

## 측정 방식

- 데이터는 고정 규칙으로 생성한 캐릭터 5만 행입니다. 엔진별 지연을 인위적으로 추가하지 않습니다.
- DBMS 5회 워밍업 뒤 새 캐시 키의 첫 MISS를 한 번 측정합니다. 최초 Redis 연결 비용이 포함될 수 있습니다.
- Redis HIT 5회 워밍업 뒤 DBMS 직접 조회와 HIT를 50회씩 실행합니다. 각 쌍의 실행 순서를 교대로 바꿉니다. 워밍업과 캐시 키 정리는 표시된 수치에서 제외합니다.
- 웹 서버에서 각 조회를 호출하고 결과를 파싱할 때까지 잽니다. 쿼리 결과 일치 검사는 측정 밖에서 수행합니다. Mini DBMS와 Mini Redis 각각의 현재 HTTP 연결 동작이 결과에 포함됩니다.
- 비교할 때마다 120초 TTL의 별도 키를 쓰고 끝나면 삭제합니다. 실행 중 다른 클라이언트에서 실습 DB 데이터를 수정하면 결과 일치 검사가 실패할 수 있습니다.

## 점진적 재해싱

**점진적 재해싱 → 재해싱 실습 실행**을 누릅니다. Python 3, Make, C++ 컴파일러가 필요합니다. Windows에서는 기본 WSL 배포판을 사용합니다. 필요한 바이너리는 실습 실행 시 빌드합니다.

탭은 보이는데 **경로를 찾을 수 없습니다**가 뜨면 웹 서버를 실행한 PowerShell에서 `Ctrl+C`를 누르고 `node ./example/query-lab/server.mjs`를 다시 실행한 뒤 브라우저를 새로고침하세요. 같은 PowerShell에서는 기존 포트와 토큰 환경 변수가 유지됩니다.

**HTTP 조회 그래프**는 같은 49,152개 키를 담은 임시 AOF로 두 Redis 프로세스를 차례로 실행합니다. 두 실행에서 각각 8개 HTTP 연결로 같은 GET을 연결당 4ms 간격을 목표로 보내고 새 키 64개를 삽입합니다. 첫 삽입이 65,536개 버킷을 131,072개로 늘립니다. 한 서버는 평소의 단계 예산을 사용하고, 다른 서버는 `--rehash-all`로 한 단계에 기존 키를 모두 옮깁니다. `--rehash-all`과 시점을 기록하는 `--trace-rehash`는 모두 `--test-hooks`를 요구합니다.

두 그래프는 각 서버의 노드 이동 시작점을 0ms로 맞춥니다. 같은 가로·세로축에 이동 시작 15ms 전부터 40ms 후 사이에 출발한 GET을 표시합니다. 점의 높이는 HTTP 응답을 다 받기까지 걸린 시간입니다. 이 구간의 p99·최대값은 연결과 스케줄링 영향을 받으며, 매번 점진적 방식이 더 빠르다는 보장은 없습니다. 실습을 마치면 임시 프로세스와 AOF를 정리합니다.

**엔진 내부 이동 방식 비교**는 같은 C++ 엔진과 키에 기본 단계 예산(노드 4개, 버킷 8개)과 전체를 한 번에 옮길 수 있는 예산을 적용합니다. 노드 384개와 49,152개에서 방식을 번갈아 각각 11회 실행하고, 가장 긴 단일 단계 및 전체 이동 시간의 중앙값을 표시합니다. 새 버킷 배열 할당과 HTTP·AOF 비용은 이 측정에서 제외합니다.

## TTL 힙

**TTL 힙 → TTL 실습 실행**을 누릅니다. 약 5.5초가 걸립니다. Python 3와 Make, C++ 컴파일러가 필요하며 Windows에서는 WSL에서 실행합니다.

먼저 키 50,000개 중 2개에만 TTL을 설정한 상태에서 **다음 만료 키를 찾는 비용**을 비교합니다. 전체 키를 순회하는 기준 방식과 실제 엔진의 힙 맨 위를 읽는 방식이 같은 답을 내는지 확인하고, 검사한 키 개수와 11회 탐색 시간의 중앙값을 표시합니다. TTL 변경과 키 삭제, HTTP 처리 시간은 비교 시간에 포함되지 않습니다.

실습은 새 Redis 프로세스에서 A(1초), B(5초), C(만료 없음)를 저장하고, 0.5초 뒤 A에 TTL 5초를 다시 줍니다. 결과표에서 실제 엔진의 힙 맨 위, 힙에 있는 키 수, 이벤트 루프가 키를 정리한 시각과 GET 응답을 볼 수 있습니다. B와 A의 만료를 확인하는 GET은 엔진이 먼저 해당 키를 정리한 뒤 보냅니다. 실습용 `--trace-ttl` 로그는 `--test-hooks`를 함께 지정한 프로세스에서만 켤 수 있습니다.

## 검증

두 엔진과 웹 서버가 실행 중일 때 별도 PowerShell에서 아래 명령으로 두 쿼리의 반환 행 수·DBMS 호출 횟수, 재해싱 결과, TTL 힙의 순서와 GET 결과를 검증할 수 있습니다.

```powershell
node ./example/query-lab/verify.mjs
```
