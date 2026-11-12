-- 뷰어 "후보 이미지 클릭 교체" 요청 큐(2026-11-12).
--
-- 배경: 교체 한 건이 1~2분 걸리는데 사용자는 그 사이 다른 자리도 누른다. 2026-11-12 한효주 원고에서
-- 1번을 누르고 반영 전에 3번을 눌렀더니 **1번만 남았다**(run 둘 다 성공으로 끝났다). 겹쳐 돈 두 run
-- 중 나중에 끝난 쪽이 **자기가 시작할 때 읽은 옛 상태로** 페이지를 배포해 앞 교체를 덮었고,
-- `ArticleJobRepository.mergeMetadata`가 버전 검사 없는 read-modify-write라 DB의 `metadata.images`
-- 까지 되돌아갔다. PR #80이 jobId별 concurrency(`cancel-in-progress: false`)로 2건은 막았다.
--
-- 그런데 **3건 이상은 못 막는다**: GitHub은 concurrency 그룹당 대기분을 **하나만** 들고 있어서,
-- 한 건이 도는 중에 두 건이 더 들어오면 가운데 것이 조용히 취소된다(대기 중 취소는 스텝이 아예
-- 돌지 않아 알림도 못 보낸다). 그래서 요청을 **대기 중인 run이 아니라 이 테이블에** 보관한다 -
-- GitHub이 대기분을 취소해도 요청 행은 남고, 뒤에 실제로 도는 run이 큐를 통째로 비운다.
--
-- 왜 `metadata` JSON이 아니라 별도 테이블인가: `metadata`에 쌓으면 위에 적은 `mergeMetadata`의
-- read-modify-write와 경합해 **또 같은 lost update가 난다** - 그게 이번 버그의 원인이었다.
-- 테이블 insert는 그 자체로 원자적이라 경합이 없다.
--
-- 주의: 이 migration은 파일 작성 후 사용자 승인을 받아 `supabase db push`로 적용한다.
-- 적용 전에도 코드는 깨지지 않는다 - 큐를 읽지 못하면 옛 경로(단건 처리)로 떨어진다
-- (`imagePickQueue.ts`의 `isQueueTableMissing`).

create table if not exists public.image_pick_requests (
  id uuid primary key default gen_random_uuid(),

  -- article_jobs.id. FK로 참조하지 않는다(pipeline_dispatch_queue와 같은 이유 - job이 나중에
  -- 정리돼도 이 행은 감사 로그로 독립적으로 남아 있어도 무방하다).
  job_id uuid not null,

  -- 슬롯(자리) 번호. 본문 [IMAGE] 마커 순서(1부터).
  slot_index int not null,
  candidate_number int not null,

  -- 뷰어가 본 현재 채택 이미지 URL. 빈 자리는 ''. 같은 슬롯을 두 번 누르면 뒤 요청의 fromUrl이
  -- 어긋나므로(앞 요청이 이미 바꿔 놓았다) 드레인이 중복을 먼저 접고 살아남은 한 건만 검사한다.
  from_url text not null default '',

  -- pending | done | failed | skipped
  --   skipped = 같은 슬롯에 더 나중 요청이 있어 접힌 건(나중 것이 이긴다).
  status text not null default 'pending'
    check (status in ('pending', 'done', 'failed', 'skipped')),
  error text,

  requested_at timestamptz not null default now(),
  processed_at timestamptz
);

-- 드레인 조회(이 job의 pending을 requested_at 오름차순으로)가 쓰는 색인.
create index if not exists image_pick_requests_pending_idx
  on public.image_pick_requests (job_id, status, requested_at);

comment on table public.image_pick_requests is
  '뷰어 후보 이미지 클릭 교체 요청 큐. 요청을 대기 중인 GitHub run이 아니라 DB에 보관해, 그룹당
   대기분 1개 한도로 가운데 요청이 취소돼도 유실되지 않게 한다 - 뒤에 도는 run이 큐를 비운다.';

-- ---------- 권한 ----------
-- article_jobs/pipeline_dispatch_queue와 동일 정책 - service_role만 접근, anon/authenticated는 차단.
-- 뷰어(Pages Function)는 Access 토큰을 검증한 뒤 service_role 키로 insert한다.

alter table public.image_pick_requests enable row level security;
revoke all on table public.image_pick_requests from anon, authenticated;
grant select, insert, update, delete on table public.image_pick_requests to service_role;
