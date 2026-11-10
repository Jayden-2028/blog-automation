/**
 * 사용설명서 트랙(Korea Plain)의 저장 값.
 * 저장되는 값은 옛 코드명 그대로다 - DB에 'kscene'으로 71행이 쌓여 있어 바꾸면 과거 글을 못 읽는다(2026-11-10 리네임).
 * `articles.category` / `manuscript_manifest_topics.category` / `job.metadata.track`이 이 값을 쓴다.
 */
export const KOREAPLAIN_TRACK = "kscene" as const;
