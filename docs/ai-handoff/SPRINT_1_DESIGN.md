# Sprint 1 설계안 — 선택 루프 닫기

작성일: 2026-08-27 · 상태: **승인됨** (2026-08-27, 구현 착수 가능)

> 열려 있던 두 결정은 사용자 승인으로 확정됐다:
> - **수신 경로: ① 주기적 폴링** (§6)
> - **추천 제목: 선택 후 1건 생성** (§7)

## 1. 목표

매일 아침 도착하는 키워드 TOP 10에서 **폰으로 버튼 하나 눌러 원고 주제를 고르면, 그 선택이 DB에
job으로 남는 것**까지가 이번 스프린트다. 원고 생성(Sprint 2)은 이 job을 읽어서 시작한다.

### 완료 조건

1. 텔레그램 알림 메시지에 항목별 선택 버튼이 붙는다
2. 버튼을 누르면 `article_jobs`에 row가 생기고 확인 메시지가 온다
3. 같은 항목을 두 번 눌러도 job이 하나만 생긴다
4. 선택된 키워드에 대한 추천 제목이 실제 LLM 생성물이다(현재는 `[placeholder]` 문자열)

---

## 2. 현재 구조와 손댈 지점

```
runDailyKeywordWorkflow()
  └─ [notify] sendKeywordNotification()
       ├─ fetchTopKeywordsForNotification(topN, runId)   -> run + items
       ├─ generateTitleSuggestions(keyword)              ← [placeholder] 반환. 교체 대상
       ├─ formatNotificationMessage(payload)             -> string[] (chunk)
       └─ TelegramNotifier.sendMany(messages)            ← 버튼을 못 붙임. 확장 대상
```

발송은 있고 **수신이 통째로 없다.** `TelegramNotifier`는 `sendMessage`만 호출한다.

### 변경 범위

| 파일 | 변경 |
|---|---|
| `notifications/TelegramNotifier.ts` | `reply_markup` 전달 경로 추가 (발송 전용 유지) |
| `notifications/TelegramBot.ts` | **신규** — `getUpdates` 수신, callback 처리 |
| `workflows/keyword-notification/formatNotificationMessage.ts` | chunk별 버튼 배열 함께 반환 |
| `workflows/keyword-notification/sendKeywordNotification.ts` | 버튼 포함 발송 |
| `workflows/keyword-notification/generateTitleSuggestions.ts` | LLM 생성으로 교체 |
| `repositories/ArticleJobRepository.ts` | **신규** |
| `types/database.ts` | `article_jobs`, `telegram_offsets` 타입 추가 |
| `supabase/migrations/` | **신규** migration 1개 |

---

## 3. DB 스키마

### 3-1. `article_jobs` — 선택된 키워드 1건 = job 1건

이후 모든 단계(조사→집필→이미지→검수→발행)의 상태 머신이 된다.

```sql
create table if not exists article_jobs (
  id uuid primary key default gen_random_uuid(),

  -- 출처 스냅샷. keyword_rankings를 조인하지 않아도 job만으로 재현 가능해야 한다
  -- (keyword_rankings는 run별 스냅샷이라 나중에 정리될 수 있다).
  source_run_id integer not null,
  source_rank integer not null,
  keyword text not null,
  headline text,
  seed_query text,
  category text,
  total_score integer,
  score_breakdown jsonb,

  status text not null default 'selected',
  selected_at timestamptz not null default now(),
  selected_via text not null default 'telegram',

  -- 생성된 추천 제목, 사용자가 최종 선택한 제목 등
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint article_jobs_status_check
    check (status in ('selected','researching','writing','review','approved','published','rejected'))
);

-- 같은 run의 같은 순위를 두 번 선택해도 job은 하나만 생긴다(중복 클릭 방어).
create unique index uq_article_jobs_run_rank on article_jobs (source_run_id, source_rank);
create index idx_article_jobs_status on article_jobs (status);
create index idx_article_jobs_selected_at on article_jobs (selected_at desc);
```

**status 값은 기존 `KEYWORD_STATUSES`에서 `discovered`만 뺀 것**이다(`types/database.ts`에 이미 정의됨).
job은 "선택된 순간" 생기므로 `discovered` 상태가 존재하지 않는다.

**출처를 스냅샷으로 복사하는 이유**: `keyword_rankings`는 run 단위 스냅샷이고 run이 쌓이면 정리
대상이 된다. job은 며칠~몇 주 살아 있을 수 있으므로 FK로 묶지 않고 값을 복사한다
(`keyword_rankings`가 `keywords`를 참조하지 않고 값을 복사해둔 것과 같은 이유).

### 3-2. `telegram_offsets` — `getUpdates` 커서

```sql
create table if not exists telegram_offsets (
  id text primary key,              -- 'keyword-bot' 같은 논리적 수신기 이름
  last_update_id bigint not null,
  updated_at timestamptz not null default now()
);
```

**왜 DB인가**: 수신기를 짧게 여러 번 실행하는 방식(§6 안①)을 택하면 프로세스가 매번 죽으므로
offset을 메모리에 둘 수 없다. 파일로 둘 수도 있지만, 나중에 수신기를 클라우드로 옮길 때 그대로
따라오려면 DB가 낫다.

두 테이블 모두 `trend_candidates`와 동일하게 **RLS on + anon/authenticated 권한 회수 +
service_role 명시**를 적용한다.

---

## 4. 인라인 버튼 설계

### callback_data 형식

```
sel:<run_id>:<rank>      예) sel:18:3
```

Telegram의 `callback_data`는 **64바이트 제한**이 있다. 키워드를 넣으면 초과하므로 참조 키만 넣고,
실제 키워드는 수신 시 `keyword_rankings`에서 다시 읽는다. 이 방식은 부수 효과로 **위변조된
callback_data로 임의 키워드를 주입하는 것도 막는다** — run_id/rank로 조회되지 않으면 거부한다.

### 버튼 배치

메시지가 4000자를 넘으면 chunk로 나뉘므로, **버튼은 해당 chunk에 실린 항목만** 담는다.
번호만 있는 격자로 배치한다(본문에 이미 `1. 키워드` 형태로 번호가 있다):

```
[1] [2] [3] [4] [5]
[6] [7] [8] [9] [10]
```

`formatNotificationMessage()`의 반환 타입을 바꾼다:

```ts
// 지금: string[]
// 변경: { text: string; ranks: number[] }[]
```

`ranks`는 그 chunk에 포함된 항목의 rank 목록이다. 발송 측이 이걸로 `reply_markup`을 만든다.
버튼 생성 자체를 이 함수에 넣지 않는 이유는, 이 함수가 Telegram API 스키마를 몰라도 되게 하기
위해서다(현재도 순수 포맷 함수다).

### 누른 뒤 화면

`editMessageReplyMarkup`으로 선택된 버튼을 `✅ 3`으로 바꾸고 나머지는 그대로 둔다. 하루에 여러 건
고를 수 있어야 하므로 버튼 전체를 지우지 않는다.

---

## 5. 콜백 처리 흐름

```
handleCallbackQuery(callbackQuery)
 1. callback_data 파싱 -> { runId, rank }. 형식 안 맞으면 무시
 2. chat_id가 TELEGRAM_CHAT_ID와 일치하는지 확인  ← 다른 사람이 못 누르게
 3. keyword_rankings에서 (run_id, rank) 조회. 없으면 "만료된 항목" 응답
 4. ArticleJobRepository.createFromRanking(row)
      - unique index 위반이면 이미 선택된 것으로 보고 성공 처리(멱등)
 5. 추천 제목 생성 (LLM) -> job.metadata.titleSuggestions에 저장
 6. answerCallbackQuery(짧은 토스트)
 7. editMessageReplyMarkup(선택 표시)
 8. 확인 메시지 발송 (선택한 키워드 + 추천 제목 3개)
```

**멱등성**: 3~4단계가 두 번 실행돼도 unique index가 두 번째를 막는다. 5단계(LLM 호출)는 job이
새로 생겼을 때만 실행한다 — 중복 클릭으로 토큰을 태우지 않기 위해서다.

**보안**: 2단계가 핵심이다. 봇 토큰이 유출되지 않아도, 봇이 들어 있는 다른 대화에서 온
callback은 거부해야 한다.

---

## 6. 수신 경로 — ① 주기적 폴링으로 확정

`handleCallbackQuery()`는 **어떻게 update가 도착하는지와 무관하게** 동작하도록 설계한다. 그래서
아래 셋 중 무엇을 택해도 핸들러 코드는 그대로다. 다만 UX와 운영 특성이 다르다.

| | ① 주기적 폴링 | ② 클라우드 수신 서버 | ③ 상시 로컬 프로세스 |
|---|---|---|---|
| 반응 속도 | 최대 N분 지연 | 즉시 | 즉시 |
| 맥 잠자기 | **영향 없음** | 영향 없음 | **죽음** |
| 구현량 | 작음 (기존 launchd 패턴 재사용) | 큼 (배포·시크릿·webhook) | 작음 |
| 시스템 분산 | 없음 | **맥 + 클라우드로 쪼개짐** | 없음 |
| `answerCallbackQuery` | **만료될 수 있음** | 정상 | 정상 |

### ①의 실질적 문제 하나

Telegram은 callback query에 **약 15초 안에** `answerCallbackQuery`로 응답하기를 기대한다. 폴링
주기가 5분이면 그 시점엔 이미 만료돼 버튼의 로딩 표시가 그냥 사라진다.

다만 **`editMessageReplyMarkup`과 확인 메시지 발송은 만료와 무관하게 동작한다.** 즉 사용자는
"버튼을 눌렀는데 잠깐 아무 반응 없다가 몇 분 뒤 확인 메시지가 온다"를 겪는다. 하루 1~2건 고르는
용도로는 감수할 만하다고 보지만, 판단이 필요하다.

### ②의 걸림돌

Creator Advisor 크롤링은 로그인된 브라우저 프로필에 묶여 있어 **맥에 남아야 한다.** 수신기만
클라우드로 보내면 시스템이 두 곳으로 쪼개지고, 클라우드에서 Supabase에 쓰는 경로가 하나 더
생긴다. 이건 Sprint 4~5에서 발행까지 클라우드로 옮길 때 한꺼번에 하는 게 자연스럽다.

### 결정: ①로 시작한다 (2026-08-27 승인)

이유:
- 오늘 확인한 잠자기 문제를 구조적으로 회피한다
- 이미 검증된 launchd + caffeinate 패턴을 그대로 재사용한다
- 핸들러가 수신 방식과 분리돼 있으므로, 나중에 ②로 옮길 때 버릴 코드가 거의 없다

주기는 **5분**을 제안한다(09:00~자정 사이만 실행하도록 `StartCalendarInterval` 배열 사용도 가능).

---

## 7. 추천 제목 생성 — 선택 후 1건 생성으로 확정

원래 계획은 알림에 항목별 추천 제목 3개를 함께 보내는 것이었다. **선택 후 생성으로 변경한다**
(2026-08-27 승인).

| | 알림 시 10건 생성 | **선택 후 1건 생성** |
|---|---|---|
| LLM 호출 | 매일 10회 | 하루 1~2회 |
| 쓰이는 비율 | 10건 중 1~2건만 | 전부 |
| 알림 지연 | 생성 시간만큼 늘어남 | 없음 |

키워드와 원문 headline이 이미 메시지에 있어서 **고르는 데는 제목이 없어도 충분하다.** 제목은
선택 후 확인 메시지에 함께 보내면 된다. 매일 8건의 버려지는 LLM 호출을 없앨 수 있다.

생성 경로는 Sprint 2의 헤드리스 러너(`claude -p`)와 같은 것을 쓴다 — Sprint 1에서 그 러너의
최소 형태를 먼저 만들고, Sprint 2에서 원고 생성으로 확장한다.

---

## 8. 작업 순서

| # | 작업 | 담당 | 승인 게이트 |
|---|---|---|---|
| 1 | migration 작성 (`article_jobs`, `telegram_offsets`) | Claude | **적용 시 승인 필요** |
| 2 | `types/database.ts` 타입 추가 (+ 누락된 `images`/`analytics`도 함께) | **Codex** | - |
| 3 | `ArticleJobRepository` + 멱등 생성 | Claude | - |
| 4 | `formatNotificationMessage` 반환 타입 변경 + 버튼 배열 | **Codex** | - |
| 5 | `TelegramNotifier` reply_markup 경로 | **Codex** | - |
| 6 | `TelegramBot` 수신기 + `handleCallbackQuery` | Claude | - |
| 7 | 헤드리스 제목 생성기 | Claude | - |
| 8 | launchd 폴링 등록 | Claude | **시스템 설정 변경, 승인 필요** |

2·4·5는 범위가 명확한 반복 작업이라 Codex 위임에 적합하다. 6·7은 설계 판단이 섞여 Claude가 한다.

---

## 9. 검증 방법

```bash
npm run build
npm run test:article-job          # 신규 - 멱등 생성, 상태 전이
npm run test:telegram-callback    # 신규 - callback_data 파싱, chat_id 검증, 만료 처리
npm run test:notification         # 기존 - 반환 타입 변경 회귀
npm run test:score-keyword
npm run test:keyword-category
# ... 기존 11개 전부
```

수신기 테스트는 실제 Telegram을 호출하지 않는다 — `getUpdates` 응답과 발송 함수를 주입해
핸들러 로직만 검증한다(`runCreatorAdvisorCollection`의 `fetchCandidates` 주입과 같은 패턴).

**최종 검증**: 폰에서 버튼을 눌러 `article_jobs`에 row가 생기고 확인 메시지가 오는 것.

---

## 10. 이 설계에서 의도적으로 하지 않는 것

- **원고 생성** — Sprint 2
- **선택 취소/되돌리기** — job을 `rejected`로 바꾸는 건 가능하지만 UI는 나중에
- **여러 사용자 지원** — `TELEGRAM_CHAT_ID` 단일 사용자 전제
- **webhook 전환** — ②를 택할 때 함께
- **`keyword_rankings` 정리 정책** — job이 스냅샷을 복사하므로 급하지 않다
