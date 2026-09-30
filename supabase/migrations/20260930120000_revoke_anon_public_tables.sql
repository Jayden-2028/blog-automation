-- Supabase 보안 어드바이저(rls_disabled_in_public, 2026-09-27) 조치.
-- 이 파이프라인은 서버의 service_role client만 쓴다(anon 키 사용처 없음). 다른 테이블과 동일하게
-- RLS on + anon/authenticated 권한 회수 + service_role 명시. RLS는 service_role이 우회한다.
-- 되돌리기: disable row level security + grant ... to anon, authenticated.

alter table public.instagram_capture_inbox enable row level security;

revoke all on table public.instagram_capture_inbox from anon, authenticated;
revoke all on table public.analytics from anon, authenticated;
revoke all on table public.articles from anon, authenticated;
revoke all on table public.discovery_runs from anon, authenticated;
revoke all on table public.images from anon, authenticated;
revoke all on table public.keyword_rankings from anon, authenticated;
revoke all on table public.keywords from anon, authenticated;
revoke all on table public.publications from anon, authenticated;
revoke all on table public.seed_queries from anon, authenticated;
revoke all on table public.sources from anon, authenticated;

grant select, insert, update, delete on table public.instagram_capture_inbox to service_role;
