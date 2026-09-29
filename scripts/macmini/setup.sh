#!/usr/bin/env bash
# 새 맥미니 1회 셋업. 여러 번 돌려도 안전하다(있는 건 건너뛴다).
#   사용: bash scripts/macmini/setup.sh
# 하는 일: 도구 설치 확인 -> 폴더 구조 -> npm ci -> Playwright 크롬 -> 서버용 전원 설정 안내.
# 하지 않는 일: 비밀값(.env) 생성, 로그인, launchd 등록(install-launchd.sh), sudo 실행.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ok(){ echo "  ✅ $*"; }; warn(){ echo "  ⚠️  $*"; }

echo "▶ 1/5 도구 확인"
if ! command -v brew >/dev/null; then
  warn "Homebrew 없음 -> https://brew.sh 의 설치 명령을 먼저 실행하세요."; exit 1
fi
eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)"
command -v git  >/dev/null || brew install git
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  brew install node@22 && brew link --overwrite --force node@22
fi
ok "node $(node -v), npm $(npm -v), git $(git --version | cut -d' ' -f3)"
if command -v claude >/dev/null || [ -x "$HOME/.local/bin/claude" ]; then ok "claude CLI 있음"
else warn "claude CLI 없음 -> 'curl -fsSL https://claude.ai/install.sh | bash' 후 'claude'로 로그인"; fi
if command -v codex >/dev/null || [ -x "$HOME/.local/bin/codex" ]; then ok "codex CLI 있음"
else warn "codex CLI 없음(선택) -> 위임 작업을 쓸 때만 필요"; fi

echo "▶ 2/5 폴더 구조"
ROOT="$(dirname "$REPO")"
mkdir -p "$ROOT/blog-manuscripts/whyissuenow" "$REPO/logs" "$REPO/.local"
ok "원고 보관함: $ROOT/blog-manuscripts/whyissuenow (코드 기본값과 일치)"

echo "▶ 3/5 npm ci"
(cd "$REPO" && npm ci --no-audit --no-fund) && ok "의존성 설치"

echo "▶ 4/5 Playwright 크롬"
(cd "$REPO" && npx playwright install chromium) && ok "chromium 설치"

echo "▶ 5/5 서버용 전원 설정(수동, sudo 필요 - 직접 실행하세요)"
cat <<'P'
  sudo pmset -a sleep 0 disksleep 0 displaysleep 10 autorestart 1 womp 1
  (sleep 0=잠들지 않음 / autorestart=정전 후 자동 켜짐 / womp=네트워크 깨우기)
  시스템 설정 > 사용자 및 그룹 > 자동 로그인 = 사용자 지정(브라우저 세션이 GUI 로그인에 묶임)
  시스템 설정 > 일반 > 공유 > 원격 로그인(SSH) 켜기 = 모니터 없이 관리
P
echo; echo "다음: .env 복사 -> 로그인 3종 -> bash scripts/macmini/doctor.sh -> bash scripts/macmini/install-launchd.sh"
