#!/usr/bin/env bash
# Supabase 마이그레이션 히스토리 리페어.
#
# 배경: docs/ai-handoff/SUPABASE_MIGRATION_SYNC.md
# supabase/migrations/의 9개 파일은 전부 Dashboard SQL Editor에서 수작업 적용됐고, 원격
# schema_migrations 추적 테이블은 비어 있다. 이 스크립트는 각 버전을 'applied'로 표시만 한다
# (SQL을 실행하지 않는다).
#
# 선행 조건:
#   supabase login
#   supabase link --project-ref <ref>
#
# 실행:
#   ./scripts/supabase-repair.sh

set -euo pipefail

if ! command -v supabase >/dev/null 2>&1; then
  echo "supabase CLI가 없습니다. brew install supabase/tap/supabase" >&2
  exit 1
fi

# migrations 디렉터리에서 실제 버전 목록을 읽는다(파일이 추가돼도 자동 반영).
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$ROOT/supabase/migrations"

versions=()
for f in "$MIGRATIONS_DIR"/*.sql; do
  base="$(basename "$f")"
  versions+=("${base%%_*}")
done

echo "리페어 대상 버전 ${#versions[@]}개:"
printf '  %s\n' "${versions[@]}"
echo

echo "현재 원격 상태:"
supabase migration list
echo

read -r -p "위 ${#versions[@]}개를 전부 'applied'로 표시합니다. 계속? [y/N] " reply
case "$reply" in
  y|Y) ;;
  *) echo "중단."; exit 0 ;;
esac

for v in "${versions[@]}"; do
  echo "→ $v"
  supabase migration repair --status applied "$v"
done

echo
echo "완료. 검증:"
supabase migration list
echo
echo "다음: supabase db diff --linked  → 'No schema changes found' 확인"
