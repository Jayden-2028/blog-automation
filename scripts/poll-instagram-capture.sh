#!/usr/bin/env bash
# 인스타 포스팅 변환기 봇 폴링(launchd가 60초마다 부른다).
#

set -euo pipefail

# 이 스크립트가 놓인 워크트리를 스스로 찾는다(2026-09-24).
#
# 예전에는 ig-dev 절대경로를 박아 뒀다. main 병합 뒤 plist만 prod로 바꾸면 **prod 스크립트가
# ig-dev 코드를 돌리는** 상태가 되는데, 겉으로는 정상으로 보여 알아채기 어렵다. 경로를
# 스스로 구하면 어느 워크트리에 놓든 그 워크트리의 코드를 돌린다.
# (2026-09-24: 병합이 끝나 ig-dev 워크트리는 제거했다. plist는 prod를 가리킨다.)
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="$HOME/Library/Logs/blog-automation-instagram-capture-poll.log"

# launchd는 로그인 셸 PATH를 물려받지 않는다 - node/npm 위치를 직접 넣는다.
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO"
# 캐러셀 캡처 + 모델 판정이 건당 수십 초다. 그 사이 유휴 절전으로 들어가면 브라우저가 끊기므로
# caffeinate -i로 이 실행 동안만 잠들지 못하게 막는다(naver-poll과 같은 방식).
{
  echo "── $(date '+%Y-%m-%d %H:%M:%S')"
  /usr/bin/caffeinate -i npm run --silent job:ig-capture-poll 2>&1
} >> "$LOG" 2>&1

# 로그가 무한히 자라지 않게 최근 2000줄만 남긴다.
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
