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
# 원고 규격 통일(2026-09-30): 클라우드(GitHub Actions)는 moai-marketer 플러그인을 설치해 쓴다. 맥에도 같은 것이 있어야 로컬 헤드리스가 같은 결과를 낸다.
CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"
if [ -x "$CLAUDE_BIN" ]; then
  "$CLAUDE_BIN" plugin list 2>/dev/null | grep -q "moai-marketer" && pass "moai-marketer 플러그인(클라우드와 동일)" \
    || soft "moai-marketer 없음 -> claude plugin marketplace add https://github.com/modu-ai/moai-cowork.git && claude plugin install moai-marketer@moai-cowork -y"
fi
# GITHUB_TOKEN이 있으면 인스타 등 맥에서 만든 job도 자료조사·집필을 클라우드로 보낸다(없으면 맥에서 직접 돈다).
grep -qE '^GITHUB_TOKEN=.+' .env 2>/dev/null && pass "GITHUB_TOKEN 있음(조사·집필을 클라우드로 발화)" || soft "GITHUB_TOKEN 없음 -> 조사·집필이 맥 로컬 claude로 돈다(클라우드와 모델·플러그인이 같아야 한다)"
grep -qE '^CLAUDE_MODEL=.+' .env 2>/dev/null && pass "CLAUDE_MODEL 고정됨" || soft "CLAUDE_MODEL 미설정 -> 환경마다 기본 모델이 다를 수 있음(.env와 GitHub Actions env에 같은 값을 넣는다)"
[ -d "$HOME/Library/Caches/ms-playwright" ] && pass "Playwright 브라우저" || fail "npx playwright install chromium"
# 프로필 경로는 셸 환경이 아니라 .env에 있으므로 거기서 읽는다(코드 기본값과 같은 우선순위).
N="$(grep -E '^NAVER_PUBLISH_PROFILE_DIR=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'")"
N="${N:-.local/naver-publish-profile}"; N="${N/#\~/$HOME}"
 [ -d "$N" ] && pass "네이버 세션 프로필 폴더 ($N)" || soft "네이버 세션 없음 -> npm run setup:naver-publish 로 로그인"
# Creator Advisor는 클라우드에서 못 도는 유일한 수집 소스라 이 맥에만 있다. 프로필이 없으면
# 매일 07:30 수집이 조용히 빈손으로 끝나고, 08:00 클라우드 job은 그 사실을 모른 채 진행한다.
C="$(grep -E '^CREATOR_ADVISOR_PROFILE_DIR=' .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'")"
C="${C:-.local/creator-advisor-profile}"; C="${C/#\~/$HOME}"
[ -d "$C" ] && pass "Creator Advisor 세션 프로필 폴더 ($C)" || soft "Creator Advisor 세션 없음 -> npm run debug:creator-advisor 로 로그인"
grep -qE "^CREATOR_ADVISOR_BLOG_ID=.+" .env 2>/dev/null && pass "CREATOR_ADVISOR_BLOG_ID" || soft "CREATOR_ADVISOR_BLOG_ID 없음(Creator Advisor 수집에 필요)"
pmset -g | grep -E "^\s*sleep\s+0" >/dev/null && pass "절전 꺼짐(sleep 0)" || soft "pmset sleep 0 아님 - 서버로 쓰려면 setup.sh 안내 참고"
pass "빌드 검사는 'npm run build'로 별도 실행"
exit $FAIL
