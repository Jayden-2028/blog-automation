import { SeedQueryRepository } from "./SeedQueryRepository.js";

async function main() {
  console.log("▶ SeedQueryRepository 테스트 시작");

  const suffix = Date.now();
  const activeKeyword = `테스트 active 시드 ${suffix}`;
  const pausedKeyword = `테스트 paused 시드 ${suffix}`;

  // 이 테스트가 직접 생성한 row의 id만 모아둔다 — cleanup은 이 목록에 있는 id만 삭제하고,
  // 운영 데이터(다른 category/keyword의 기존 seed)는 절대 건드리지 않는다.
  const createdIds: string[] = [];

  try {
    // 1. active / paused seed 각 1건 생성
    const activeSeed = await SeedQueryRepository.createSeed({
      keyword: activeKeyword,
      category: "test",
      source: "testSeedQueryRepository script",
    });
    createdIds.push(activeSeed.id);
    console.log("✅ active seed 생성:", activeSeed.id, activeSeed.status);

    const pausedSeedDraft = await SeedQueryRepository.createSeed({
      keyword: pausedKeyword,
      category: "test",
      source: "testSeedQueryRepository script",
    });
    createdIds.push(pausedSeedDraft.id);
    const pausedSeed = await SeedQueryRepository.updateSeedStatus(pausedSeedDraft.id, "paused");
    console.log("✅ paused seed 생성 및 status 변경:", pausedSeed.id, pausedSeed.status);

    // 2. getActiveSeeds()는 active seed만 반환해야 한다.
    const activeSeeds = await SeedQueryRepository.getActiveSeeds();
    const returnedIds = new Set(activeSeeds.map((seed) => seed.id));

    if (!returnedIds.has(activeSeed.id)) {
      throw new Error("getActiveSeeds()가 방금 생성한 active seed를 반환하지 않았습니다.");
    }
    if (returnedIds.has(pausedSeed.id)) {
      throw new Error("getActiveSeeds()가 paused seed를 반환했습니다 (active만 반환해야 함).");
    }
    if (activeSeeds.some((seed) => seed.status !== "active")) {
      throw new Error("getActiveSeeds() 결과에 status가 active가 아닌 seed가 섞여 있습니다.");
    }
    console.log(`✅ getActiveSeeds() 검증 완료 (active ${activeSeeds.length}건, 모두 status=active)`);

    // 3. getSeedsByCategory()도 방금 만든 두 seed를 모두 찾아야 한다 (status 무관).
    const categorySeeds = await SeedQueryRepository.getSeedsByCategory("test");
    const categoryIds = new Set(categorySeeds.map((seed) => seed.id));
    if (!categoryIds.has(activeSeed.id) || !categoryIds.has(pausedSeed.id)) {
      throw new Error("getSeedsByCategory('test')가 방금 생성한 seed를 모두 반환하지 않았습니다.");
    }
    console.log(`✅ getSeedsByCategory('test') 검증 완료 (${categorySeeds.length}건)`);

    console.log("\n✅ SeedQueryRepository 테스트 완료");
  } finally {
    // cleanup: 이 테스트가 만든 row만 id 기준으로 삭제. 실패해도 다른 row에는 영향 없음.
    for (const id of createdIds) {
      try {
        await SeedQueryRepository.deleteSeed(id);
      } catch (cleanupError) {
        console.error(
          `⚠️ 테스트 데이터 cleanup 실패 (id=${id}):`,
          cleanupError instanceof Error ? cleanupError.message : cleanupError
        );
      }
    }
    if (createdIds.length > 0) {
      console.log(`🧹 테스트 seed ${createdIds.length}건 정리 완료`);
    }
  }
}

main().catch((error) => {
  console.error("❌ SeedQueryRepository 테스트 실패:", error.message ?? error);
  process.exit(1);
});
