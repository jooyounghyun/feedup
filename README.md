# FeedUp — feedback upgrade

코칭을 기록으로, 성장을 데이터로.
강사·학생·학부모를 연결하는 성장 관리 플랫폼 (현재 분야: GOLF)

## 구성

| 폴더/파일 | 역할 |
|---|---|
| `public/index.html` | 앱 화면 (인트로, 로그인, 연습 체크, 라운드, 리포트, 코치 기능) |
| `functions/api/[[path]].js` | 서버 API (로그인, 권한 검사, 데이터 저장, AI 정리) |
| `schema.sql` | D1 데이터베이스 표 만들기 |

Cloudflare Pages가 `public`을 화면으로, `functions`를 서버로 자동 배포해요.

## 배포 순서 (처음 한 번)

### 1. GitHub에 올리기
1. github.com → 오른쪽 위 `+` → **New repository** → 이름 `feedup` → **Private** 권장 → Create.
2. **uploading an existing file** 을 눌러 압축을 푼 폴더 안의 내용(`public`, `functions`, `schema.sql`, `README.md`, `.gitignore`)을 폴더째 끌어다 놓고 **Commit changes**.
   - `functions/api/[[path]].js` 처럼 폴더 구조가 그대로 올라갔는지 꼭 확인하세요.

### 2. 데이터베이스(D1) 만들기
1. Cloudflare 대시보드 → **Storage & Databases → D1** → **Create** → 이름 `feedup-db`.
2. 만든 데이터베이스 → **Console** 탭 → `schema.sql` 내용을 전부 붙여넣고 **Execute**.

### 3. Pages 프로젝트 만들기
1. **Workers & Pages → Create → Pages → Connect to Git** → `feedup` 저장소 선택.
2. 빌드 설정
   - Framework preset: **None**
   - Build command: **비워두기**
   - Build output directory: **public**
3. **Save and Deploy**.

### 4. 데이터베이스 연결
프로젝트 → **Settings → Bindings → Add → D1 database**
- Variable name: **DB** (대문자 그대로)
- D1 database: **feedup-db**

### 5. AI 정리 (지금은 무료 데모, 설정 불필요)
지금은 요금이 나가지 않도록 AI 호출을 꺼두었어요. 리포트의 'AI 코칭 정리'는 기록을 바탕으로 한 **데모 정리**가 기기 안에서 만들어져요(요금 0원).

정식 오픈 때 실제 AI로 바꾸려면:
1. `public/index.html`에서 `const AI_LIVE=false;` 를 `true`로 바꿔 커밋
2. console.anthropic.com 에서 API 키 발급 (사용한 만큼 과금, 월 한도 설정 권장)
3. 프로젝트 → **Settings → Variables and Secrets**
   - Secret `ANTHROPIC_API_KEY` = 발급받은 키
   - Text `AI_ENABLED` = `true`
   - (선택) `AI_DAILY_LIMIT` 하루 횟수 제한(기본 20), `ANTHROPIC_MODEL` 모델 이름(기본 `claude-sonnet-5-5`)

### 6. 다시 배포
설정은 새 배포부터 적용돼요. **Deployments** 탭 → 최신 배포의 `...` → **Retry deployment**.
`https://feedup.pages.dev` 같은 주소로 접속해 회원가입이 되면 완료예요.

### 7. (선택) 내 도메인 연결
프로젝트 → **Custom domains** → 도메인 입력.

## 수정하고 다시 올리기
GitHub에서 파일을 고쳐 Commit 하면 Cloudflare가 자동으로 다시 배포해요.

## 보안 구조
- 비밀번호는 PBKDF2(10만 회)로 해시해서 저장, 원문은 저장하지 않아요.
- 로그인은 HttpOnly 쿠키 세션(30일).
- 모든 읽기·쓰기는 서버에서 권한을 검사해요. 연결되지 않은 사람의 기록은 볼 수도, 쓸 수도 없어요.
- Claude API 키는 서버 비밀값에만 있고 화면 코드에는 없어요.
- 다른 사이트에서 보내는 요청은 차단해요.

## 정식 오픈 전에 챙길 것
- **비밀번호 재설정**: 이메일 발송 서비스(예: Resend) 연결이 필요해요. 지금은 비밀번호를 잊으면 관리자가 직접 처리해야 해요.
- **개인정보처리방침·이용약관**: 학생 기록을 다루므로 필수. 만 14세 미만 가입자는 법정대리인 동의가 필요해요.
- **회원 탈퇴** 기능.
- **학부모 연결**: 소개 문구에 있지만 아직 기능은 없어요.
- **백업**: D1의 Time Travel(시점 복구)을 확인해 두세요.
