#!/usr/bin/env bash
# 로컬 launchd 3종 등록/해제/상태. 사용: install-launchd.sh [install|uninstall|status]
#   naver-poll(60초)  instagram-capture-poll(60초)  export-poll(60초)  manuscript-export(30분)
# ⚠️ 옛 맥의 같은 job을 먼저 내려야 한다 - 둘이 동시에 돌면 네이버에 같은 글이 두 번 올라갈 수 있다.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENTS="$HOME/Library/LaunchAgents"; UID_="$(id -u)"; PFX="com.blogautomation"
# 이름 -> "스크립트|주기(초)"
JOBS=( "naver-poll|$REPO/scripts/macmini/poll-naver.sh|60"
       "instagram-capture-poll|$REPO/scripts/poll-instagram-capture.sh|60"
       "export-poll|$REPO/scripts/poll-manuscript-export.sh|60"
       "manuscript-export|$REPO/scripts/export-manuscripts.sh|1800" )

plist() { # name script interval
cat <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$PFX.$1</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$2</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StartInterval</key><integer>$3</integer>
  <key>RunAtLoad</key><true/>
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
      echo "✅ 등록: $PFX.$n (${i}초)"
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
