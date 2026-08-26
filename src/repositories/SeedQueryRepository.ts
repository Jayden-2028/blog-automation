// keyword ranking 파이프라인이 사용하는 seed 검색어(seed_queries 테이블) repository.
// 코드 내부 배열(naverCategoryMap.ts의 DEFAULT_CATEGORY_BY_QUERY 등)로 관리되던 seed 목록을
// DB 기반으로 옮기기 위한 진입점. runDailyKeywordWorkflow()가 기본 queries로 getActiveSeeds()를 쓴다.

import { supabase } from "../services/supabase/client.js";
import type {
  SeedQueryInsert,
  SeedQueryRow,
  SeedQueryStatus,
  SeedQueryUpdate,
} from "../types/database.js";

export class SeedQueryRepository {
  // status='active'인 seed만, priority 내림차순(숫자가 클수록 우선순위 높음) -> 오래된 순으로 반환한다.
  static async getActiveSeeds(): Promise<SeedQueryRow[]> {
    const { data, error } = await supabase
      .from("seed_queries")
      .select("*")
      .eq("status", "active")
      .order("priority", { ascending: false })
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data ?? [];
  }

  static async getSeedsByCategory(category: string): Promise<SeedQueryRow[]> {
    const { data, error } = await supabase
      .from("seed_queries")
      .select("*")
      .eq("category", category)
      .order("priority", { ascending: false });

    if (error) throw error;
    return data ?? [];
  }

  static async createSeed(input: SeedQueryInsert): Promise<SeedQueryRow> {
    const { data, error } = await supabase
      .from("seed_queries")
      .insert(input)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  static async updateSeedStatus(
    id: string,
    status: SeedQueryStatus
  ): Promise<SeedQueryRow> {
    const { data, error } = await supabase
      .from("seed_queries")
      .update({
        status,
        updated_at: new Date().toISOString(),
      } satisfies SeedQueryUpdate)
      .eq("id", id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // id 단건 삭제. 테스트 데이터 cleanup 등 명시적으로 id를 아는 row를 지울 때만 사용한다.
  static async deleteSeed(id: string): Promise<void> {
    const { error } = await supabase.from("seed_queries").delete().eq("id", id);
    if (error) throw error;
  }
}
