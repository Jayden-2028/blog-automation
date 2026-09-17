#!/usr/bin/env bash
# 승인된 원고와 이미지를 맥 로컬 보관함으로 내려받는다(launchd가 30분마다 부른다).
#
# 왜 launchd인가: 파이프라인은 GitHub Actions에서 돌아 맥 디스크에 직접 쓸 수 없다. 맥이 주기적으로
# 당겨오는 수밖에 없다. 2026-09-14에 폐기한 launchd는 **파이프라인 실행**용이었고(클라우드로 이전),
# 이건 결과물을 내려받는 **로컬 미러링**이라 목적이 다르다 - 실패해도 파이프라인엔 영향이 없다.
#
# 이미 받은 이미지는 건너뛰므로(exportManuscript의 skip) 자주 돌아도 네트워크를 거의 안 쓴다.

set -euo pipefail

REPO="/Users/wooahpapa/blog-automation/prod"
LOG="$HOME/Library/Logs/blog-automation-export.log"

# launchd는 로그인 셸 PATH를 물려받지 않는다 - node/npm 위치를 직접 넣는다(2026-08-27 실측과 같은 함정).
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

cd "$REPO"
{
  echo "── $(date '+%Y-%m-%d %H:%M:%S')"
  # --all: 날짜를 가리지 않고 manifest 전체를 훑는다. 뒤늦게 승인된 옛 날짜 원고도 받는다.
  npm run --silent manuscript:export -- --all 2>&1
} >> "$LOG" 2>&1

# 로그가 무한히 자라지 않게 최근 2000줄만 남긴다.
tail -n 2000 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
