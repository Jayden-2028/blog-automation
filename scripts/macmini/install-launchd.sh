#!/usr/bin/env bash
# 로컬 launchd 5종 등록/해제/상태. 사용: install-launchd.sh [install|uninstall|status]
#   naver-poll(60초)  instagram-capture-poll(60초)  export-poll(60초)  manuscript-export(30분)
#   creator-advisor(매일 07:30)
# ⚠️ 옛 맥의 같은 job을 먼저 내려야 한다 - 둘이 동시에 돌면 네이버에 같은 글이 두 번 올라갈 수 있다.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"; UID_="$(id -u)"; PFX="com.blogautomation"
# 이름 -> "스크립트|주기". 주기는 두 형태를 받는다:
#   숫자      -> StartInterval(초 단위 반복). 폴러용.
#   "HH:MM"   -> StartCalendarInterval(매일 그 시각 1회). 하루 한 번 도는 수집용.
#
# creator-advisor가 07:30인 이유: 클라우드 social-issue job이 08:00에 trend_candidates를 읽는다.
# 그 전에 오늘자 행이 들어가 있어야 한다(collect-creator-advisor.sh 상단 주석 참고).
JOBS=( "naver-poll|$REPO/scripts/macmini/poll-naver.sh|60"
       "instagram-capture-poll|$REPO/scripts/poll-instagram-capture.sh|60"
       "export-poll|$REPO/scripts/poll-manuscript-export.sh|60"
       "manuscript-export|$REPO/scripts/export-manuscripts.sh|1800"
       "creator-advisor|$REPO/scripts/macmini/collect-creator-advisor.sh|07:30" )

# 주기 문자열 -> plist 스케줄 항목. RunAtLoad도 여기서 갈린다:
# 폴러는 등록 즉시 한 번 도는 게 맞지만, 하루 1회 수집을 등록할 때마다 돌리면 불필요한
# 브라우저 실행과 중복 upsert가 생긴다.
schedule_keys() { # interval
  if [[ "$1" =~ ^([0-9]{1,2}):([0-9]{2})$ ]]; then
    printf '  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>%d</integer><key>Minute</key><integer>%d</integer></dict>\n' \
      "$((10#${BASH_REMATCH[1]}))" "$((10#${BASH_REMATCH[2]}))"
    printf '  <key>RunAtLoad</key><false/>\n'
  else
    printf '  <key>StartInterval</key><integer>%d</integer>\n' "$1"
    printf '  <key>RunAtLoad</key><true/>\n'
  fi
}

plist() { # name script interval
cat <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PFX.$1</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
$(schedule_keys "$3")
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
P
}

case "${1:-status}" in
  install)
    bash "$REPO/scripts/macmini/doctor.sh" --quiet || { echo "❌ doctor 실패 - 먼저 고치세요."; exit 1; }
    mkdir -p "$AGENTS" "$HOME/Library/Logs"
    for j in "${JOBS[@]}"; do IFS='|' read -r n s i <<<"$j"
      f="$AGENTS/$PFX.$n.plist"
      launchctl bootout "gui/$UID_/$PFX.$n" 2>/dev/null || true
      plist "$n" "$s" "$i" > "$f"
      launchctl bootstrap "gui/$UID_" "$f"; launchctl enable "gui/$UID_/$PFX.$n"
      # 주기 표기는 형태에 맞춰 쓴다 - "07:30초" 같은 출력은 사람이 잘못 읽는다.
      if [[ "$i" =~ ^[0-9]{1,2}:[0-9]{2}$ ]]; then echo "✅ 등록: $PFX.$n (매일 $i)"
      else echo "✅ 등록: $PFX.$n (${i}초마다)"; fi
    done ;;
  uninstall)
    for j in "${JOBS[@]}"; do IFS='|' read -r n _ _ <<<"$j"
      launchctl bootout "gui/$UID_/$PFX.$n" 2>/dev/null || true
      launchctl disable "gui/$UID_/$PFX.$n" 2>/dev/null || true
      rm -f "$AGENTS/$PFX.$n.plist"; echo "🗑  해제: $PFX.$n"
    done ;;
  status)
    for j in "${JOBS[@]}"; do IFS='|' read -r n _ _ <<<"$j"
      if launchctl print "gui/$UID_/$PFX.$n" >/dev/null 2>&1; then
        echo "🟢 $n  $(launchctl print "gui/$UID_/$PFX.$n" | grep -E 'last exit code|runs =' | tr -s ' ' | tr '\n' ' ')"
      else echo "⚪ $n  (미등록)"; fi
    done ;;
  *) echo "사용: $0 [install|uninstall|status]"; exit 2 ;;
esac
