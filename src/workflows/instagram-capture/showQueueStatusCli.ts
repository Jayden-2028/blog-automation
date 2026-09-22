// npm run ig-capture:status
// 대기 중인 인스타 큐 항목을 보여준다. 캡처 처리(캐러셀 캡처 -> createInstagramJob)를 할 때
// "지금 뭐가 쌓여 있는지" 확인하는 용도.
import "dotenv/config";

import { readQueue, INSTAGRAM_QUEUE_PATH } from "./instagramQueue.js";

function main(): void {
  const entries = readQueue();
  const pending = entries.filter((e) => e.status === "pending");

  console.log(`▶ 큐 파일: ${INSTAGRAM_QUEUE_PATH}`);
  console.log(`▶ 대기 ${pending.length}건 / 전체 ${entries.length}건`);

  for (const entry of pending) {
    console.log("");
    console.log(`- id: ${entry.id}`);
    console.log(`  url: ${entry.instagramUrl}`);
    console.log(`  받은 시각: ${entry.receivedAt}`);
    if (entry.rawCaption) {
      const preview = entry.rawCaption.length > 80 ? `${entry.rawCaption.slice(0, 80)}...` : entry.rawCaption;
      console.log(`  캡션: ${preview}`);
    } else {
      console.log("  캡션: (없음 - URL만 옴)");
    }
  }
}

main();
