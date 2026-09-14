-- 채널별 원고 페이지(manuscripts/index.html)가 읽는 목록을 로컬 파일(manuscripts/manifest.json)
-- 대신 여기(Supabase)에 보관한다.
--
-- 배경(2026-09-14/15 클라우드 이전 Phase 4 사고): job-publish-prepare.yml이 GitHub Actions에서
-- 도는데, 이 러너는 매번 새로 체크아웃되는 일회용 컴퓨터라 manuscripts/manifest.json(gitignore
-- 대상, 로컬 디스크에만 있던 파일)이 매 실행마다 없는 상태로 시작했다. 그 결과 새로 승인된 job만
-- 담긴 "거의 빈" 목록으로 페이지를 통째로 다시 배포해, 이전에 이미 준비된 다른 job들의 원고가
-- 배포에서 통째로 사라지는 사고가 실제로 4건 발생했다(docs/ai-handoff/CURRENT_STATE.md 참고).
-- telegram_offsets를 DB로 옮긴 이유("수신기를 짧게 반복 실행해서 파일/메모리에 못 둔다")와 같은
-- 근본 원인이다.
--
-- job 1건 = row 1건(job_id로 upsert, manuscriptManifest.ts의 upsertTopicEntry와 동일한 의미).
-- 어느 환경(이 맥이든 GitHub Actions든)에서 처리하든 이 테이블 하나만 보고 쓰면, 서로 다른 실행이
-- 서로의 row를 지우지 않는다(각자 자기 job_id 행만 upsert하고 다른 행은 건드리지 않으므로 "전체
-- 겹어쓰기"로 인한 유실이 구조적으로 불가능해진다).
--
-- article_jobs를 FK로 참조하지 않는 이유: article_jobs_and_telegram_offsets.sql의 같은 결정과
-- 동일(원고 열람 목적의 스냅샷이라, job이 나중에 정리돼도 이 행은 독립적으로 남아 있어야 한다).
--
-- 주의: 이 migration은 파일 작성 후 사용자 승인을 받아 `supabase db push`로 적용한다.

create table if not exists public.manuscript_manifest_topics (
  job_id uuid primary key,

  keyword text not null,
  category text,
  -- Asia/Seoul 기준 YYYY-MM-DD (원고 페이지 좌측 날짜 그룹 키).
  date text not null,
  -- 이 job의 채널 원고가 준비 완료된 시각(ISO). article_jobs.metadata.channelManuscriptsReadyAt과
  -- 같은 값을 중복 보관한다 - 페이지 정렬(readyAt desc)에 article_jobs 조회를 매번 안 하려는 목적.
  ready_at timestamptz not null,

  -- ManuscriptChannelEntry[] 그대로(channel/title/searchDescription/slug/tags/body/imagePrompts/
  -- filePath) - manuscriptManifest.ts의 타입과 1:1 대응, 코드 쪽 변환 없이 그대로 저장·복원한다.
  channels jsonb not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_manuscript_manifest_topics_date
  on public.manuscript_manifest_topics (date desc, ready_at desc);

comment on table public.manuscript_manifest_topics is
  '채널별 원고 페이지(manuscripts/index.html)의 날짜->주제->채널 목록. job_id로 upsert하는 행 단위
   저장이라, 서로 다른 실행 환경(로컬/GitHub Actions)이 동시에 써도 서로의 행을 지우지 않는다.';
comment on column public.manuscript_manifest_topics.date is 'Asia/Seoul YYYY-MM-DD. 원고 페이지 좌측 날짜 그룹 키.';
comment on column public.manuscript_manifest_topics.channels is 'ManuscriptChannelEntry[] 그대로(channel/title/searchDescription/slug/tags/body/imagePrompts/filePath).';

-- ---------- 권한 ----------
-- article_jobs/telegram_offsets와 동일 정책 - service_role만 접근, anon/authenticated는 차단.

alter table public.manuscript_manifest_topics enable row level security;
revoke all on table public.manuscript_manifest_topics from anon, authenticated;
grant select, insert, update, delete on table public.manuscript_manifest_topics to service_role;
