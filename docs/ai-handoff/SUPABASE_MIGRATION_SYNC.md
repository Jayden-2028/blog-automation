# Supabase 마이그레이션 히스토리 동기화

기준일: 2026-08-28

## 문제

`supabase/migrations/`에 파일 9개가 있는데, 이들은 전부 **Dashboard SQL Editor에서 손으로**
적용됐다(로드맵 §1, CURRENT_STATE.md 2026-08-26 세션). 그래서:

- 원격 `supabase_migrations.schema_migrations` 테이블이 **비어 있다** - CLI는 "아무 마이그레이션도
  적용 안 됨"으로 본다.
- `supabase db push`를 그냥 실행하면 이미 존재하는 테이블에 `create table` 등을 다시 돌려 **충돌**한다.
- 로컬 파일과 원격 실제 스키마는 **일치**하지만 CLI가 그걸 모른다.

이 어긋남 때문에 지금까지 CLI를 아예 안 썼고, 마이그레이션은 계속 수작업이었다.

## 해결 방법: `migration repair`

`supabase migration repair --status applied <version>`은 **SQL을 실행하지 않는다.**
`schema_migrations` 추적 테이블에 "이 버전은 적용됨"이라는 행만 넣는다. 파일이 idempotent하고
(전부 `create table if not exists` / `add column if not exists` 형태) 원격 스키마가 이미 그
상태이므로, 9개를 전부 `applied`로 표시하면 히스토리와 실제가 맞아떨어진다.

이후부터는 새 마이그레이션을 `supabase db push`로 정상 적용할 수 있다.

## Claude가 이미 한 것

- `supabase` CLI 설치 (`brew install supabase/tap/supabase`, v2.116.0).
- `supabase init` - `supabase/config.toml` 생성(로컬 개발 포트 설정만, 비밀값 없음. 커밋 대상).
- `scripts/supabase-repair.sh` 작성 - 링크 후 실행하면 9개 버전을 순서대로 `applied` 표시.

## 사용자 개입 필요

CLI 로그인과 프로젝트 링크는 계정 자격증명이 필요해 Claude가 못 한다.

### 1. 로그인

```bash
supabase login
```

브라우저가 열리고 Supabase 계정으로 인증한다. (CI가 아니면 이 방식. 토큰을 직접 쓰려면
`export SUPABASE_ACCESS_TOKEN=...`.)

### 2. 프로젝트 링크

프로젝트 ref는 Supabase 대시보드 URL에서 확인한다:
`https://supabase.com/dashboard/project/<여기가-ref>`

```bash
supabase link --project-ref <ref>
```

DB 비밀번호를 물어본다(대시보드 Settings → Database에서 확인/재설정). `.env`에는 없다.

### 3. 현재 상태 확인 (SQL 실행 안 함, 읽기만)

```bash
supabase migration list
```

기대 출력: `LOCAL` 열엔 9개 버전 전부, `REMOTE` 열은 비어 있음.

### 4. 리페어 실행

```bash
./scripts/supabase-repair.sh
```

또는 수동으로 9개를 하나씩:

```bash
supabase migration repair --status applied 20260824120000
supabase migration repair --status applied 20260825090000
supabase migration repair --status applied 20260825120000
supabase migration repair --status applied 20260825130000
supabase migration repair --status applied 20260825140000
supabase migration repair --status applied 20260825150000
supabase migration repair --status applied 20260826024112
supabase migration repair --status applied 20260827014817
supabase migration repair --status applied 20260827090344
```

> ⚠️ `20260825150000_trend_candidates.sql`와 `20260826024112_upgrade_legacy_trend_candidates.sql`는
> 로드맵 §1에서 "기능적으로 동일한 idempotent 스크립트"로 확인됐다. 원격은 후자 형태로 적용돼
> 있지만 전자도 `if not exists` 기반이라 `applied`로 표시해도 실제 스키마와 모순되지 않는다.
> (걱정되면 이 버전만 빼도 된다 - 그러면 다음 `db push` 때 전자가 실행되는데, idempotent라
> 무해하다. 표시하는 쪽이 히스토리가 더 깔끔하다.)

### 5. 검증

```bash
supabase migration list      # LOCAL/REMOTE 두 열이 9개로 일치하면 성공
```

> `supabase db diff --linked`는 shadow DB를 위해 **Docker Desktop이 필요**하다. Docker가 없으면
> `failed to run docker`로 끝나는데, 리페어 검증에는 필수가 아니다 - 위 `migration list`의
> LOCAL/REMOTE 일치가 곧 검증이다. Docker를 쓸 수 있으면 `db diff --linked`가 "No schema changes
> found"를 내는지 추가 확인하면 되고, 뭔가 뱉으면 로컬 파일과 원격 스키마가 실제로 다르다는
> 뜻이므로 멈추고 확인한다.

**2026-08-28 실행 결과**: 9개 전부 LOCAL/REMOTE 일치 확인. `db diff --linked`는 Docker 미설치로
건너뜀(무해).

## 이후 워크플로우

새 스키마 변경은:

```bash
supabase migration new <이름>     # supabase/migrations/에 타임스탬프 파일 생성
# ... SQL 작성 ...
supabase db push                 # 원격에 적용 (CLAUDE.md: 사용자 승인 필수)
```

Dashboard SQL Editor 수작업은 이제 그만. CLAUDE.md의 "Supabase migration 적용" 승인 게이트는
그대로 유효하다 - `db push`도 승인 대상이다.
