// 확보한 이미지를 job의 최신 원고에 기록하는 수동 진입점.
//
// 승인 시 자동 발송되는 이미지 브리프 메시지(notifyImageBrief.ts)가 이 명령을 안내한다.
//
// 사용법:
//   npm run job:image -- <jobId> <imageUrl> <copyrightStatus> ["alt text"]
//
// copyrightStatus 예시:
//   ai-generated:chatgpt          (기본 - ChatGPT로 생성한 경우)
//   press-release:kh.or.kr        (공식 보도자료, 도메인 필수)
//   stock:unsplash:license-free   (라이선스 명시 무료 스톡)
import "dotenv/config";

import { recordArticleImage } from "./recordArticleImage.js";

async function main(): Promise<void> {
  const [jobId, imageUrl, copyrightStatus, altText] = process.argv.slice(2);

  if (!jobId || !imageUrl || !copyrightStatus) {
    console.log('사용법: npm run job:image -- <jobId> <imageUrl> <copyrightStatus> ["alt text"]');
    console.log("copyrightStatus 예시: ai-generated:chatgpt / press-release:kh.or.kr / stock:unsplash:license-free");
    return;
  }

  const result = await recordArticleImage({ jobId, imageUrl, copyrightStatus, altText });

  if (result.status === "invalid_copyright") {
    console.error(`❌ ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  if (result.status === "no_article") {
    console.error(`❌ ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✅ 이미지 기록됨 (image #${result.image.id}, article #${result.image.article_id})`);
  console.log(`   URL: ${result.image.image_url}`);
  console.log(`   출처: ${result.image.copyright_status}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
