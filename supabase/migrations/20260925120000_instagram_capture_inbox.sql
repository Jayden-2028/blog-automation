-- 인스타 링크 수신함(2026-09-25 사용자 승인).
--
-- 왜 필요한가(실측): 링크는 텔레그램으로 오고, 그걸 받는 폴러는 **맥에서만** 돈다(캡처에 로그인된
-- 브라우저가 필요해 GitHub Actions에서 못 돈다). 그런데 맥이 네트워크 장애·절전으로 39시간 멈춘
-- 적이 있고, 텔레그램은 미확인 업데이트를 **24시간만** 보관한다. 그 경계를 넘기면 링크가 사라진다.
--
-- 그래서 **받는 일만 클라우드로 옮긴다.** GitHub Actions가 텔레그램에서 받아 여기에 쌓고, 맥은
-- 우리 저장소에서 가져간다. 맥이 며칠을 자도 링크는 남는다.
--
--   텔레그램 --(GitHub Actions cron)--> instagram_capture_inbox --> 맥 폴러 --> 캡처
--
-- 캡처 자체는 그대로 맥에 남는다. 인스타 로그인 세션을 CI에 두는 것은 계정 탈취급 위험이고,
-- 데이터센터 IP에서 쓰면 인스타가 먼저 막는다(네이버 발행을 맥에 남긴 것과 같은 이유).
create table if not exists public.instagram_capture_inbox (
  -- `tg-<update_id>`. 같은 업데이트가 재전달돼도 한 번만 들어간다.
  id text primary key,

  instagram_url text not null,
  -- 게시물 캡션이 아니라 **사용자가 링크와 함께 보낸 말**이다. 대개 비어 있다.
  raw_caption text not null default '',

  telegram_chat_id text not null,
  telegram_message_id bigint not null,

  -- 맥이 가져간 시각. null이면 아직 안 가져간 것이다. 지우지 않고 표시만 하는 이유는
  -- 감사(언제 받아 언제 처리했나)가 남아야 하기 때문이다.
  claimed_at timestamptz,

  received_at timestamptz not null default now()
);

-- 맥 폴러는 "아직 안 가져간 것"만 본다.
create index if not exists idx_instagram_inbox_unclaimed
  on public.instagram_capture_inbox (received_at)
  where claimed_at is null;

-- 주제 답장도 같은 수신함으로 받는다(2026-09-25, 같은 날 추가).
--
-- 왜: 텔레그램 getUpdates는 **봇당 소비자가 하나**여야 한다. 맥과 클라우드가 같이 부르면 offset을
-- 두고 서로 잡아먹는다. 그래서 링크뿐 아니라 "주제가 뭔가요" 답장까지 클라우드가 받아 여기 넣고,
-- 맥이 가져가 자기 큐에 적용한다.
alter table public.instagram_capture_inbox
  add column if not exists kind text not null default 'link',   -- 'link' | 'topic_reply'
  add column if not exists reply_to_message_id bigint,          -- topic_reply가 답한 원본 메시지
  add column if not exists reply_text text;                     -- 사용자가 쓴 주제

-- topic_reply에는 인스타 주소가 없다.
alter table public.instagram_capture_inbox
  alter column instagram_url drop not null;
