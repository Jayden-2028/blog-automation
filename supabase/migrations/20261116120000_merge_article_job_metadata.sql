-- article_jobs.metadata를 **한 문장으로** 병합하는 함수(2026-11-16, 외부 감사 F4).
--
-- 배경: `ArticleJobRepository.mergeMetadata`는 **버전 검사 없는 read-modify-write**였다 -
-- `findById`로 metadata를 읽고, 자바스크립트에서 펼쳐 합치고, 통째로 UPDATE 한다. 읽기와 쓰기
-- 사이에 다른 러너가 **다른 키**를 쓰면 그 키가 조용히 사라진다(lost update). 호출 지점이 60곳이고
-- 조사·집필·번역·발행·뷰어 편집·이미지 교체가 전부 이 한 함수를 지난다.
--
-- 실측된 피해: 2026-11-11 한효주 원고에서 이미지 교체 두 건이 겹쳐 돌아 나중 run이 자기가 시작할
-- 때 읽은 옛 images로 되돌렸다(1번 누르고 3번을 눌렀더니 1번만 남았다. run 둘 다 "교체 완료"로
-- 끝났다). 그 경로는 PR #80(jobId별 concurrency)·#83(요청 큐 테이블)이 앞단에서 막았지만,
-- **일반 경로**(각 파이프라인 단계·뷰어 편집·진행 중 표식 선기록)는 그대로 열려 있었다.
--
-- 왜 조건부 UPDATE(CAS)가 아니라 함수인가: CAS(`...eq("updated_at", 읽은 값)`)는 스키마를 안
-- 건드리는 대신 **실패 → 다시 읽고 다시 병합**하는 재시도 루프가 필요하고, 재시도를 다 쓰면
-- 던질 수도 없다(호출 60곳 중 catch로 감싼 곳이 1곳이라 던지면 조사·집필·발행이 멈춘다). 즉 최후의
-- 폴백이 "지금과 같은 lost update"로 남는다. `jsonb ||`는 UPDATE **한 문장 안에서** 읽고 합치므로
-- 행 잠금이 전 구간을 덮는다 - 경합이 일어날 틈 자체가 없고, 재시도도 폴백도 필요 없다.
-- 사용자 승인: 2026-11-16("f4는 migration + 승인합니다").
--
-- 병합 규칙은 지금과 같은 **얕은 병합**이다(`||`는 최상위 키만 덮는다). 다른 점 하나: 값이
-- `undefined`인 키는 지금은 JSON 직렬화에서 빠져 **키가 지워졌는데**, `||`에서는 patch에 그 키가
-- 없는 것이므로 **옛 값이 남는다**. 키를 지우려면 `null`을 쓴다(현재 호출 60곳 중 undefined로
-- 지우는 곳은 없다 - 2026-11-16 전수 확인). 리포지토리가 undefined를 보면 경고를 찍는다.
--
-- 주의: 이 migration은 파일 작성 후 사용자 승인을 받아 적용한다. **적용 전에도 코드는 깨지지
-- 않는다** - 함수가 없으면(42883·PGRST202) 리포지토리가 옛 read-modify-write로 떨어진다
-- (image_pick_requests·pages_deploy_lock과 같은 정책).
--
-- 되돌리기: drop function public.merge_article_job_metadata(uuid, jsonb);

create or replace function public.merge_article_job_metadata(p_id uuid, p_patch jsonb)
returns setof public.article_jobs
language sql
-- security invoker가 기본이지만 명시한다 - definer로 두면 anon 키로도 metadata를 고칠 수 있는
-- 권한 상승 통로가 된다(아래 grant는 service_role 하나다).
security invoker
-- search_path를 고정한다(함수 안에서 public만 본다).
set search_path = public
as $$
  update public.article_jobs
     set metadata = coalesce(metadata, '{}'::jsonb) || coalesce(p_patch, '{}'::jsonb),
         -- 러너 시계가 아니라 DB 시계를 쓴다(여러 러너의 시계가 어긋나도 순서가 보존된다).
         updated_at = now()
   where id = p_id
  returning *;
$$;

comment on function public.merge_article_job_metadata(uuid, jsonb) is
  'article_jobs.metadata 얕은 병합(2026-11-16, 감사 F4). UPDATE 한 문장이라 읽기-쓰기 사이에
   다른 러너가 끼어들 틈이 없다 - 옛 read-modify-write는 다른 키를 쓰는 동시 작업을 되돌렸다.
   키 삭제는 null로 한다(undefined는 patch에서 빠져 옛 값이 남는다).';

-- ---------- 권한 ----------
-- 함수는 기본으로 PUBLIC에 execute가 붙으므로 **반드시 회수한다**. article_jobs를 쓰는 주체는
-- 러너의 service_role 하나다.
revoke all on function public.merge_article_job_metadata(uuid, jsonb) from public;
revoke all on function public.merge_article_job_metadata(uuid, jsonb) from anon, authenticated;
grant execute on function public.merge_article_job_metadata(uuid, jsonb) to service_role;
