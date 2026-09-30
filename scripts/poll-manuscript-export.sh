#!/usr/bin/env bash
# 텔레그램 [⬇️ 맥으로 내려받기] 요청을 집어 보관함에 내려받는다(launchd가 60초마다 부른다).
#
# 30분마다 도는 export-manuscripts.sh와 역할이 다르다. 그쪽은 **전체를 훑는** 정기 내보내기이고,
# 이건 사람이 버튼을 누른 한 건만 **지금** 받아 오는 빠른 길이다. 이 폴러가 멈춰도 원고는 늦어도
# 30분 안에 보관함에 들어온다.
#
# 대기열이 비어 있으면 아무것도 하지 않고 즉시 끝난다(Supabase 조회 한 번).

set -euo pipefail

# 이 스크립트가 놓인 워크트리를 스스로 찾는다 - 경로를 박아 두면 plist만 옮겼을 때 엉뚱한
# 워크트리의 코드가 돈다(poll-instagram-capture.sh의 2026-09-24 교훈).
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-export-poll.log"

# launchd는 로그인 셸 PATH를 물려받지 않는다 - node/npm 위치를 직접 넣는다.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO"
{
  echo "── $(date '+%Y-%m-%d %H:%M:%S')"
  npm run --silent job:export-poll 2>&1
} >> "$LOG" 2>&1

# 로그가 무한히 자라지 않게 최근 2000줄만 남긴다.
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
