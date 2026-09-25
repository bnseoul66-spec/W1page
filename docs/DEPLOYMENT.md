# 실행 및 배포 안내

## A. 독립 서버를 배포하는 가장 짧은 경로

1. 압축을 풀고 저장소 최상위에 `package.json`, `Dockerfile`, `render.yaml`이 오도록 GitHub에 올립니다. `.env`, `data/`, 실제 회원 DB는 올리지 않습니다.
2. `deploy.html`을 로컬 브라우저로 열어 GitHub 저장소 URL을 입력합니다.
3. Render 로그인 → 저장소 접근 허용 → 생성할 서비스·영구 디스크·요금을 검토 → 승인합니다.
4. Docker 빌드는 테스트와 프론트엔드 빌드를 수행합니다. 서버 실행 시 테이블이 자동 생성됩니다.
5. Render가 생성한 HTTPS 도메인에서 회원가입합니다.
6. Render의 서버 Shell에서 첫 관리자를 지정합니다.

```bash
node scripts/admin.js your-registered-email@example.com
```

`deploy.html`은 Render 공식 `https://render.com/deploy?repo=...` 흐름을 사용합니다. 실제 배포는 본인의 계정/저장소/승인이 필요하며 이 패키지를 생성한 환경에서 수행하지 않았습니다. Blueprint/Docker 구성도 원격 Render에서의 실행까지 검증한 것은 아닙니다.

**이 배포는 SQLite 모드이며 YouBase와 별개입니다.** YouBase가 필수인 경우 `YOUBASE.md` 절차로 이식한 후 YouWare에서 게시해야 합니다.

### 영구 저장 주의사항

- `render.yaml`은 `starter` 유료 웹 서비스와 1GB 영구 디스크를 요청합니다. 배포 전 현재 요금을 검토하세요.
- `/app/data`에 DB를 저장합니다. 이 영구 볼륨을 삭제하면 데이터도 사라집니다.
- 무료 임시 파일시스템에 SQLite를 저장하면 재배포 시 기록이 사라집니다. 정적 사이트/Vercel 함수에 그대로 배포하지 마세요.
- 단일 인스턴스 전제입니다. 여러 컨테이너에서 별도 로컬 DB를 사용하면 데이터가 분리되고 SSE도 공유되지 않습니다.
- 디스크를 갖는 배포는 무중단/수평 확장 제약이 있습니다. 재배포 시 짧은 중단이 있을 수 있습니다.
- `autoDeployTrigger: off`로 기본 자동 재배포를 껐습니다. 소스 변경 후 운영자가 검토하고 수동 배포하세요.

### Origin / HTTPS

Render가 제공하는 `RENDER_EXTERNAL_URL`이 기본 허용 Origin으로 사용됩니다. 커스텀 도메인을 쓰면 다음을 **서버 환경변수**로 지정하고 재배포하세요.

```text
APP_ORIGIN=https://your-writing-domain.example
TRUST_PROXY=1
```

끝에 `/`를 붙이지 마세요. 운영 모드는 HTTPS Origin 없이는 시작하지 않습니다. 쿠키는 HttpOnly + Secure + SameSite=Lax로 발급됩니다. HTTPS는 Render/리버스 프록시에서 종료합니다. 애플리케이션은 내부 HTTP 포트 3000으로 동작합니다. 커스텀 도메인 전환 후 기존 Render 도메인에서 변경 요청은 허용되지 않습니다.

`TRUST_PROXY=1`은 정확히 하나의 신뢰된 프록시 뒤에서만 사용하세요. 직접 공개하는 서버에서는 설정하지 마세요.

## B. Google OAuth 설정

1. Google Cloud Console에서 프로젝트와 OAuth 동의 화면을 구성합니다. 테스트 모드이면 사용할 테스트 사용자를 등록합니다.
2. 웹 애플리케이션용 OAuth 클라이언트를 생성합니다.
3. 승인된 리디렉션 URI에 **정확히** 다음을 추가합니다.

```text
https://YOUR_DEPLOYED_DOMAIN/api/auth/google/callback
```

로컬 테스트: `http://localhost:3000/api/auth/google/callback`

4. Render Environment 또는 로컬 `.env`에 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`를 입력합니다. 비밀키는 소스/프론트엔드/스크린샷에 넣지 마세요.
5. 서버 재시작 후 Google 버튼이 활성화됩니다. 새 Google 계정 로그인, 취소, 콜백 오류를 확인합니다.

코드는 Authorization Code + PKCE, state·nonce, Google 서명 키, issuer·audience·email_verified를 검사합니다. 같은 이메일의 기존 비밀번호 계정에는 Google 계정을 자동 연결하지 않습니다. 해당 계정은 이메일로 로그인하라는 메시지가 표시됩니다. Google 로그인은 **자격 증명이 제공되지 않아 실계정 E2E 검증하지 않았습니다.**

## C. 직접 Docker 운영

```bash
docker build -t writeon .
docker volume create writeon-data
docker run -d --name writeon \
  -p 127.0.0.1:3000:3000 \
  -e APP_ORIGIN=https://your-writing-domain.example \
  -e TRUST_PROXY=1 \
  -v writeon-data:/app/data \
  writeon
```

앞단에 HTTPS reverse proxy를 구성하세요. 기존 호스트 디렉터리를 bind mount하는 경우 컨테이너 `node` 사용자(UID 1000)가 `/app/data`를 읽고 쓸 권한이 있어야 합니다. Docker 설치 환경은 이번 작업에 없어 실제 컨테이너 빌드는 미검증입니다.

```bash
docker exec writeon node scripts/admin.js registered-email@example.com
```

## D. DB 백업 / 복원

실행 중인 DB를 `cp`로 복사하지 말고 SQLite의 일관된 온라인 backup API를 사용합니다.

```bash
node --env-file-if-exists=.env scripts/backup.js ./backups/writeon-backup.sqlite
```

- Render에서는 영구 디스크 안에 임시 백업을 생성하고 접근이 제한된 외부 암호화 저장소로 옮기세요. 같은 디스크의 백업만으로는 디스크 손실에 대비할 수 없습니다.
- 백업에는 개인 기록, 이메일, 비밀번호 해시, 세션 해시가 포함됩니다. 공개 저장소에 올리지 마세요.
- 정기 백업 스케줄·외부 복사·암호화는 운영자가 구성해야 합니다.
- 복원 시 서버를 정지 → 현재 DB 및 WAL/SHM을 별도 보관 → 일관된 백업을 `DATABASE_PATH`로 교체 → 이전 `-wal`, `-shm` 제거 → 서버 시작 → 무결성과 사용자 기록 확인 순서입니다. 잘못된 WAL 파일을 새 DB에 결합하지 마세요.
- 복원 후 기존 세션을 무효화하려면 신뢰된 서버 운영 환경에서 `sessions`를 비우세요.

## E. 공개 운영 전

- 이메일 확인/비밀번호 복구 흐름 또는 YouBase 관리 인증으로 전환
- 개인정보 처리방침, 데이터 보존·탈퇴·계정 삭제 정책
- HTTPS, 프록시 설정, 접근 제어, Google 실제 계정 테스트
- 암호화된 백업·복원 테스트 및 디스크 사용량 모니터링
- 로그인 제한은 현재 단일 프로세스 메모리 기반. 여러 서버일 경우 공유 rate-limit 저장소 필요
- SSE를 통과시키는 프록시 설정, 재연결/15초 폴링 확인
- 장기 대규모 운영은 관리형 DB, 회원/기록 서버 측 페이징, 이메일 전송 서비스를 추가 검토

참고: https://render.com/docs/deploy-to-render
