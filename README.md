# 🏢 마이오피스 (my-office)

Claude Code 에이전트들이 일하는 사무실.
여러 프로젝트에서 돌아가는 Claude Code 세션이 아이소메트릭 3D 사무실의 직원으로 나타난다.
프로젝트 = 층, 폴더 = 팀 책상. 도구를 쓰면 자료실·서버실·창가로 걸어가고, 결재가 필요하면 손을 든다.

- **결재·지휘**: 지시하기·대표실(비서)·칸반으로 일을 시키면 먼저 계획을 세워 결재함에 올리고, 승인해야 실행한다.
- **회의실**: 안건을 주면 팀 대표·고정 직원·공용 역할(`personas/*.md`)이 조사(읽기 전용) → 토론 → 회의록을 만든다.
  할 일은 칸반 초안이 되고, 회의록은 설정의 `meetingNotesDir`에 저장된다. 회의는 파일을 바꾸지 않는다.
- **아침 루틴**: 평일 아침(기본 09:00) 층마다 스탠드업을 열어 "오늘 할 일"을 결재함에 묶음으로 올린다.
  그 시각에 서버가 꺼져 있었으면 그날 처음 켜질 때 연다. 바뀐 것도 남은 일도 없는 층은 건너뛴다.
- **휴대폰**: 같은 3D 사무실을 휴대폰에서 보고 결재·지시·회의까지 (웹 앱 설치 + 푸시 알림).
  서버는 인터넷에 공개하지 않고 [Tailscale](https://tailscale.com)로 연결된 내 기기만 들어온다. PC 화면 📱에서 QR로 기기를 연결한다.

## 요구 사항
- Windows, Node.js 24 이상, Claude Code

## 처음 설정
1. `npm install`
2. `myoffice.config.example.json`을 `myoffice.config.json`으로 복사하고 **내 프로젝트 폴더 경로**로 고친다
   (처음 실행할 때 없으면 예시로 자동 생성된다). 이 파일은 내 PC 경로가 들어가므로 **git에 올라가지 않는다.**
3. `npm run hooks:install` — Claude Code 훅 연결
4. `npm run office` — 사무실 열기

## 명령

| 명령 | 하는 일 |
|---|---|
| **`npm run office`** | **마이오피스 열기** — 서버를 백그라운드로 띄우고 앱 창을 연다 (처음엔 화면 빌드 포함) |
| `npm run office:stop` | 백그라운드 서버 끄기 |
| `node scripts/office.mjs --restart` | 코드가 바뀐 뒤 다시 빌드·재시작해서 열기 |
| `npm run demo` | 가짜 세션으로 사무실 움직여 보기 (`-- --count 25 --floor 1`, DB엔 안 남음) |
| `npm run build` | 화면 빌드 (`web/dist`) |
| `npm install` | 의존성 설치 |
| `npm run server` | 이벤트 서버 실행 (`http://127.0.0.1:7777`) |
| `npm run dev` | 서버 실행 (코드 바뀌면 자동 재시작) |
| `npm test` | 테스트 |
| `npm run typecheck` | 타입 검사 |
| `npm run hooks:status` | 훅 설치 여부와 서버 상태 |
| `npm run hooks:install` | `~/.claude/settings.json`에 마이오피스 훅 추가 (자동 백업, 기존 훅 유지) |
| `npm run hooks:uninstall` | 마이오피스 훅만 제거 (자동 백업) |
| `npm run rules:sync` | 설정의 `rulesSync`대로 한 프로젝트 규칙 파일을 다른 작업 공간에 복사 (`-- --dry-run`으로 미리보기) |
| `npm run autostart:install` | 윈도우 로그인 시 서버를 창 없이 자동 실행 (시작프로그램 바로가기, 아침 루틴에 필요) |
| `npm run autostart:uninstall` | 자동 실행 끄기 |
| `npm run autostart:status` | 자동 실행 여부 |
| `npm run phone:status` | 휴대폰 연결 준비 상태 (Tailscale·HTTPS 인증서·연결) |
| `npm run phone:serve` | Tailscale serve로 `https://<내PC>.ts.net`을 마이오피스에 연결 (내 Tailscale 기기에서만 열림) |
| `npm run phone:off` | 휴대폰 연결 끄기 |

## 구조
- `myoffice.config.json` — 내 설정: 층·팀(폴더)·회의록 경로·공통 금지 목록·알림·아침 루틴 (git 제외)
- `personas/` — 회의 공용 역할(기획자·아키텍트·QA·보안 검토자·서기). 고쳐 쓰면 다음 회의부터 반영
- `myoffice.config.example.json` — 예시 설정 (테스트도 이걸로 돈다)
- `shared/` — 서버와 웹이 함께 쓰는 타입, 직원 이름 규칙
- `web/` — React + React Three Fiber 사무실 화면. 3D 에셋은 Kenney(CC0) — `web/public/assets/*/License.txt`
- `server/` — 훅 수신(`POST /hook`), 실시간 전송(`/ws`), API(`/api/*`), SQLite(`data/myoffice.db`)
- `hooks/` — 훅 설치/제거 스크립트
- `scripts/` — 사무실 열기·자동 실행·규칙 동기화·데모
- `회의록/` — 회의록 (git 제외)
- `prototypes/` — 그래픽 시안·벤치마크

## 훅이 하는 일
Claude Code가 세션 시작·도구 사용·결재 요청 같은 이벤트마다 `http://127.0.0.1:7777/hook`으로 JSON을 보낸다.
- 등록된 프로젝트 폴더의 이벤트만 저장하고, 나머지는 버린다.
- 서버가 꺼져 있으면 연결이 즉시 실패하고 Claude Code는 평소대로 진행한다.
- 평소엔 관전만 한다(빈 응답). 결재함 토글을 켰을 때만 Paseo·터미널의 권한 요청을 결재함에서 받아 결정을 돌려준다.
- 공통 금지 목록(`guard`)은 서버 없이 도는 별도 훅(`hooks/guard.mjs`)이 검사한다.
- 모든 데이터는 내 PC(`data/`)에만 저장된다.
