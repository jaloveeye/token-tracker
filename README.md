# token-tracker

`token-tracker`는 회사 내부에서 AI 코딩 도구의 토큰 사용량을 빠르게 확인하기 위한 경량 CLI와 HTML 대시보드입니다.

내부 배포가 쉬운 형태로 범위를 줄였습니다. Node.js 내장 모듈만 사용하므로 별도 의존성 설치 없이 실행할 수 있습니다.

## 지원 범위

- 기본 탐색 위치
  - Codex CLI: `~/.codex/sessions`, `~/.config/token-tracker/headless/codex`
  - Claude Code: `~/.claude/projects`, `~/.claude/transcripts`
  - OpenCode legacy JSON: `~/.local/share/opencode/storage/message`
  - Gemini CLI: `~/.gemini/tmp`
  - 내부 import: `~/.config/token-tracker/imports` 또는 `TOKEN_TRACKER_IMPORT_DIR`
- 입력, 출력, 캐시 읽기/쓰기, 추론 토큰 집계
- 클라이언트/모델/일자별 집계
- JSON export와 단일 HTML 대시보드
- 내부 가격표 기반 비용 추정

## 사용 방법

### 1. 사용 가능한 기록 위치 확인

먼저 `token-tracker`가 현재 PC에서 찾을 수 있는 AI 도구 기록 위치를 확인합니다.

```bash
npm run sources
```

직접 실행할 수도 있습니다.

```bash
node src/cli.js sources
```

출력 예시:

```text
Client    Status   Path
--------  -------  ----
codex     found    /Users/me/.codex/sessions
claude    missing  /Users/me/.claude/projects
```

`found`인 위치만 실제 스캔 대상입니다.

### 2. 전체 사용량 스캔

기본 위치에서 찾은 모든 기록을 스캔합니다.

```bash
npm run scan
```

직접 실행:

```bash
node src/cli.js scan
```

특정 도구만 보고 싶으면 `--client`를 사용합니다.

```bash
node src/cli.js scan --client codex
node src/cli.js scan --client codex --client claude
```

날짜 범위를 제한할 수도 있습니다.

```bash
node src/cli.js scan --since 2026-05-01 --until 2026-05-31
```

### 3. HTML 대시보드 만들기

브라우저에서 볼 수 있는 단일 HTML 파일을 생성합니다.

```bash
npm run dashboard
```

결과 파일:

```text
reports/token-dashboard.html
```

로컬 서버로 바로 확인하려면:

```bash
node src/cli.js dashboard --serve --port 4173
```

브라우저에서 아래 주소로 접속합니다.

```text
http://localhost:4173
```

### 3-1. 웹에서 실시간으로 보기

실시간 대시보드는 브라우저가 주기적으로 서버의 최신 집계 API를 호출합니다. 새 토큰 사용 기록이 파일에 추가되면 다음 새로고침 주기에 화면에 반영됩니다.

```bash
npm run live
```

직접 실행:

```bash
node src/cli.js live --port 4173
```

브라우저에서 아래 주소로 접속합니다.

```text
http://localhost:4173
```

기본 새로고침 주기는 10초입니다. 더 짧게 보려면 `--refresh`를 사용합니다.

```bash
node src/cli.js live --refresh 3
```

특정 도구나 경로만 실시간으로 보려면 기존 스캔 옵션을 그대로 붙이면 됩니다.

```bash
node src/cli.js live --client codex
node src/cli.js live --path ./exports --pricing config/pricing.example.json
```

같은 사내 네트워크의 다른 PC에서도 접속해야 한다면 host를 열 수 있습니다.

```bash
node src/cli.js live --host 0.0.0.0 --port 4173
```

이 경우 접속 주소는 실행한 PC의 내부 IP를 사용합니다.

```text
http://<실행한-PC의-내부-IP>:4173
```

### 3-2. 통계 필터

웹 대시보드 상단에서 통계 범위를 바로 바꿀 수 있습니다. 필터는 브라우저 안에서 즉시 재집계되며, live 대시보드에서도 선택 상태가 유지됩니다.

- `전체`: 현재 스캔된 전체 데이터
- `최근 한달`: 오늘 포함 최근 30일
- `최근 일주`: 오늘 포함 최근 7일
- `오늘`: 오늘 하루
- `년 기준`: 입력한 연도
- `월 기준`: 선택한 월

날짜와 오늘 기준은 모두 대한민국 시간(`Asia/Seoul`)입니다.

### 4. JSON으로 저장하기

다른 시스템에 업로드하거나 팀 집계용으로 보관하려면 JSON으로 저장합니다.

```bash
node src/cli.js scan --json --out reports/usage.json
```

가격표를 적용해 비용까지 계산하려면:

```bash
node src/cli.js scan --pricing config/pricing.example.json --json --out reports/usage.json
```

### 5. 팀원이 export한 파일 스캔하기

여러 팀원이 JSON/JSONL 파일을 공유하는 방식으로 운영하려면 파일을 한 폴더에 모은 뒤 `--path`로 지정합니다.

```bash
mkdir -p exports
node src/cli.js scan --path ./exports
node src/cli.js dashboard --path ./exports --out reports/token-dashboard.html
```

환경변수로 import 폴더를 고정할 수도 있습니다.

```bash
export TOKEN_TRACKER_IMPORT_DIR=/path/to/team-exports
node src/cli.js scan --client imports
```

### 6. 다른 프로젝트에서 사용하기

`token-tracker`를 전역 CLI처럼 연결해두면 다른 프로젝트 폴더에서도 바로 사용할 수 있습니다.

먼저 `token-tracker` 폴더에서 한 번만 실행합니다.

```bash
npm link
```

그 다음 다른 프로젝트로 이동해서 사용합니다.

```bash
cd /path/to/other-project
token-tracker sources
token-tracker scan
token-tracker dashboard
```

이 경우 대시보드는 현재 프로젝트의 아래 경로에 생성됩니다.

```text
reports/token-dashboard.html
```

전역 링크를 만들고 싶지 않다면 CLI 파일을 직접 실행할 수 있습니다.

```bash
node /home/herace/workspace/ideas/token-tracker/src/cli.js scan
node /home/herace/workspace/ideas/token-tracker/src/cli.js dashboard
```

특정 프로젝트의 export 폴더만 스캔하려면 `--path`를 사용합니다.

```bash
cd /path/to/other-project
token-tracker scan --path ./exports
token-tracker dashboard --path ./exports --out reports/token-dashboard.html
```

주의: 기본 스캔은 현재 프로젝트 폴더가 아니라 사용자 홈의 AI 도구 기록 위치를 봅니다. 예를 들어 `~/.codex/sessions`, `~/.claude/projects` 전체가 대상입니다. 프로젝트별로 정확히 분리하려면 해당 프로젝트에서 모은 JSON/JSONL 파일만 `--path`로 넘겨서 스캔하세요.

## 가격표

비용 추정은 기본 가격표인 `config/pricing.example.json`을 자동 적용합니다. 다른 가격표를 쓰려면 `--pricing`에 아래 형식의 JSON 파일을 넘기면 됩니다.

기본 예시는 OpenAI Codex credits 기준입니다. 모델을 임의로 GPT-5.5로 고정하지 않고, 로그에서 읽은 모델명이 가격표의 `match`와 맞을 때만 계산합니다. 대시보드에는 GPT-5.5 기준 단가가 적용되는 경우를 명확히 표시하고, credits와 대략적인 USD 환산을 함께 보여줍니다.

```json
{
  "currency": "credits",
  "unit": "per_1m_tokens",
  "usdPerCredit": 0.04,
  "label": "OpenAI Codex credits. GPT-5.5 기준 단가: input 125, cached input 12.5, output 750 credits / 1M tokens",
  "models": [
    {
      "match": "^gpt-5\\.5$",
      "input": 125,
      "cacheRead": 12.5,
      "output": 750,
      "reasoning": 750
    }
  ]
}
```

`config/pricing.example.json`에는 GPT-5.5, GPT-5.4, GPT-5.3-Codex 단가가 들어 있습니다. 실제 내부 정산에는 회사가 쓰는 모델/계약 단가로 별도 파일을 만들어 사용하세요.

`usdPerCredit`은 대략적인 달러 환산에 사용합니다. 기본값은 `1 credit ≈ $0.04`입니다.

## 명령어

```bash
token-tracker scan [options]
token-tracker sources [options]
token-tracker dashboard [options]
token-tracker live [options]
```

주요 옵션:

- `--client`, `-c`: `codex`, `claude`, `opencode`, `gemini`, `imports` 필터
- `--path`, `-p`: 기본 위치 대신 명시 경로 스캔
- `--since`, `--until`: 날짜 범위 필터
- `--pricing`: 가격표 JSON
- `--json`: JSON 출력
- `--out`, `-o`: 결과 파일 저장
- `--serve`: 대시보드 작성 후 로컬 서버 실행
- `--port`: 웹 서버 포트
- `--host`: 웹 서버 host, 기본값은 `localhost`
- `--refresh`: live 대시보드 새로고침 주기, 초 단위

## 테스트

```bash
npm test
```
