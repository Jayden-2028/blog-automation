import "dotenv/config";
import { ArticleJobRepository } from "../src/repositories/ArticleJobRepository.js";
const JOB = "5c9a77d1-ca3b-4315-89d5-8dd8511717d2";
const apply = process.argv.includes("--apply");
const job = await ArticleJobRepository.findById(JOB);
const md = (job!.metadata ?? {}) as any;

// 웹 검색으로 채운 자리만 비운다. 6번(페이지 캡처)은 유지.
const targets = (md.images ?? []).filter((i: any) => i.provider === "web" && i.url).map((i: any) => i.index);
const images = (md.images ?? []).map((i: any) =>
  targets.includes(i.index) ? { ...i, url: null, sourcePage: null, provider: null } : i
);
console.log("비울 자리:", targets.join(", "));
console.log("지울 요구사항:", JSON.stringify(md.imageRequirements));
console.log("5번 표 마커:", "prepareManuscript가 본문에서 제거");
if (!apply) { console.log("\n미리보기입니다. --apply로 실행하세요."); process.exit(0); }

await ArticleJobRepository.mergeMetadata(JOB, {
  images,
  // 낡은 요구사항을 지운다 - 1·2번은 거부된 gstatic 주소, 5번은 이제 삭제로 처리된다.
  imageRequirements: null,
  imageDirectUrls: null,
  channelManuscriptsReadyAt: null,
  webImagesReadyAt: null,
});
console.log("\n→ 비우고 게이트 열림");
