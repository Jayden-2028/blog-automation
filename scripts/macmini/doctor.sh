#!/usr/bin/env bash
# 이 맥이 로컬 서버 역할을 할 준비가 됐는지 점검한다(읽기 전용, 비밀값은 출력하지 않는다).
#   사용: doctor.sh [--quiet]   실패가 하나라도 있으면 종료코드 1
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; cd "$REPO"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
FAIL=0; Q="${1:-}"
pass(){ [ "$Q" = "--quiet" ] || echo "  ✅ $*"; }
fail(){ echo "  ❌ $*"; FAIL=1; }
soft(){ [ "$Q" = "--quiet" ] || echo "  ⚠️  $*"; }

[ "$(uname)" = "Darwin" ] && pass "macOS $(sw_vers -productVersion)" || fail "macOS가 아님"
command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] && pass "node $(node -v)" || fail "node 22+ 필요"
[ -d node_modules ] && pass "node_modules" || fail "npm ci 필요"
[ -f .env ] && pass ".env 있음" || fail ".env 없음 (옛 맥에서 복사)"

# .env는 값을 출력하지 않고 '채워졌는지'만 본다.
if [ -f .env ]; then
  for k in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID; do
    grep -qE "^$k=.+" .env && pass "$k" || fail "$k 비어 있음"
  done
  for k in BLOGGER_REFRESH_TOKEN NAVER_PUBLISH_BLOG_ID GITHUB_TOKEN GITHUB_REPOSITORY OPENAI_API_KEY IG_BROWSER_PROFILE; do
    grep -qE "^$k=.+" .env && pass "$k" || soft "$k 없음(쓰는 기능만 필요)"
  done
  # 절대경로가 옛 맥 사용자 홈을 가리키면 깨진다.
  if grep -E "^(IG_BROWSER_PROFILE|NAVER_PUBLISH_PROFILE_DIR|CREATOR_ADVISOR_PROFILE_DIR|MANUSCRIPT_EXPORT_ROOT)=/Users/" .env | grep -v "=$HOME" | grep -q .; then
    fail ".env의 프로필/경로가 다른 사용자 홈(/Users/…)을 가리킴 -> 새 경로로 수정"
  fi
fi

{ command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ]; } && pass "claude CLI" || soft "claude CLI 없음(로컬 헤드리스 사용 시 필요)"
[ -d "$HOME/Library/Caches/ms-playwright" ] && pass "Playwright 브라우저" || fail "npx playwright install chromium"
N="${NAVER_PUBLISH_PROFILE_DIR:-.local/naver-publish-profile}"; [ -d "$N" ] && pass "네이버 세션 프로필 폴더" || soft "네이버 세션 없음 -> npm run setup:naver-publish 로 로그인"
pmset -g | grep -E "^\s*sleep\s+0" >/dev/null && pass "절전 꺼짐(sleep 0)" || soft "pmset sleep 0 아님 - 서버로 쓰려면 setup.sh 안내 참고"
pass "빌드 검사는 'npm run build'로 별도 실행"
exit $FAIL
