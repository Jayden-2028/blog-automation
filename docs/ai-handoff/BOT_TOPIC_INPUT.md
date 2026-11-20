# 엔터·국제 봇 주제 직접 입력 (2026-11-21 사용자 결정)

인스타 변환기의 "직접 입력"을 봇에서 바로 한다. 변환기(맥 큐·수신함)는 건드리지 않았다. 사회 봇(scenepick, `SCENEPICK_CODEX.md`)과 같은 구조다.

## 동작

| 봇 | webhook | 일반 글자 메시지(답장 아님·`/` 아님·설정 채팅) |
|---|---|---|
| 엔터(메인) | `/`, `/webhook/entertainment` | `📝 주제를 받았습니다: <키워드>\n어느 원고로 만들까요?` + `[엔터][인물]` 버튼. 누르면 job 생성 + 자료조사, 메시지가 `✅ 엔터 원고로 발주했습니다`로 바뀌고 버튼이 걷힌다 |
| 국제(koreaplain) | `/webhook/kscene` | 바로 국제 job 생성 + 자료조사, `📝 접수했습니다: <키워드>\n국제(Korea Plain) 원고로 발주했습니다.` |

- 엔터 = 변환기 "엔터" 선택과 같은 job(category 없음, `metadata.track` 없음). 인물 = category=person(소스팩 폴러·person 리서처가 같은 길). 국제 = category=kscene + `metadata.track=kscene`(변환기 global).
- `source=keyword_input`, 명령구 꼬리 제거·300자 초과 긴 글=소스 본문(`interpretDirectInput`). 긴 글은 변환기와 달리 주제를 되묻지 않고 첫 줄(60자)을 주제로 쓴다.
- 답장(수정 피드백)·기존 버튼은 그대로 `TelegramBot`으로 간다(`handled:false`로 통과).

## 구조

- `src/workflows/topic-intake/topicIntake.ts` 순수 파싱 + deps 주입 핸들러(`handleTopicMessage`, `handleTopicPick`), `topicIntakeIo.ts` 실제 DB 조회·텔레그램 호출, `testTopicIntake.ts`.
- `src/jobs/runTelegramUpdateCli.ts`: track이 entertainment/kscene이면 먼저 `runTopicIntake`. `inputJobFields`는 `Pick` 타입으로만 넓혔다(동작 동일).
- Worker `track.ts`: `forwardsPlainMessages` 전 봇 true(글자만, 캡션은 인스타만). 글자 없는 update는 여전히 버린다.
- callback_data = `tpick:ent` / `tpick:person`(11바이트). 기존 접두(go: sel: pass: review: research: publish: kw: 인물 Go)와 파서 테스트로 비충돌 확인.

## 설계 선택: "버튼 누를 때 job 생성"

대기 상태 job을 먼저 만들지 않았다. `selected`는 인물 소스팩 폴러(category=person)가 자동으로 집고, 새 대기 상태를 만들면 선택기·워치독·일일 리포트를 전부 다시 감사해야 하며, 안 누르면 유령 job이 남는다. 대신 봇의 질문을 **원 메시지에 대한 답장**으로 보내, 텔레그램이 버튼 callback의 `message.reply_to_message.text`에 원문을 실어 주게 했다(callback_data 64바이트 제한 회피, 별도 저장소 없음).

- 중복 방지: 원 메시지 번호를 `metadata.topicInputMessageId`(+`topicInputBot`)로 저장해 조회. Worker가 첫 탭 직후 버튼을 `noop`으로 잠그므로 더블 탭은 Actions까지 오지 않고, dispatch 재시도가 와도 job은 하나·조사도 한 번이다. 다른 버튼(엔터→인물)을 이어 눌러도 하나.
- 원 메시지가 삭제돼 원문이 없으면 job을 만들지 않고 "다시 보내 주세요"로 편집.
- 한계: 같은 글자 메시지가 두 번 배달되면 엔터 봇은 질문이 두 번 갈 수 있다(job은 하나). 국제 봇은 job 단계에서 막는다. 조사 발화가 실패하면 job은 남는다(로그만, 변환기와 같다 - `npm run job:research -- <jobId>`).

## 배포

1. main 병합 후 **Cloudflare Worker 재배포**(`cloudflare/telegram-relay`, 엔터·국제 봇 일반 메시지 전달). 이전 Worker는 두 봇의 일반 메시지를 버린다.
2. GitHub Actions 쪽은 병합만으로 반영된다(`telegram-update.yml`이 main 코드를 돈다). 환경변수 추가 없음(`TELEGRAM_CHAT_ID`, `KSCENE_TELEGRAM_CHAT_ID` 기존).
3. 확인: 엔터 봇에 글을 보내 버튼이 오는지, 국제 봇에 글을 보내 접수 답장이 오는지.
