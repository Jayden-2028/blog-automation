#!/usr/bin/env bash
# 인스타 포스팅 변환기 봇 폴링(launchd가 60초마다 부른다).
#
# 아직 feat/instagram-keyword-source worktree(ig-dev)를 직접 가리킨다 - main 병합 전이라
# prod에는 이 코드가 없다. main에 병합되면 REPO를 prod로 옮기고 이 파일도 prod/scripts로
# 복사해야 한다.

set -euo pipefail

REPO="/Users/wooahpapa/blog-automation/ig-dev"
LOG="$HOME/Library/Logs/blog-automation-instagram-capture-poll.log"

# launchd는 로그인 셸 PATH를 물려받지 않는다 - node/npm 위치를 직접 넣는다.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO"
{
  echo "── $(date '+%Y-%m-%d %H:%M:%S')"
  npm run --silent job:ig-capture-poll 2>&1
} >> "$LOG" 2>&1

# 로그가 무한히 자라지 않게 최근 2000줄만 남긴다.
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
