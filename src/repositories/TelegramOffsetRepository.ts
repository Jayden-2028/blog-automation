// Telegram getUpdates 커서(telegram_offsets 테이블) repository.
//
// 왜 필요한가: 수신기를 launchd로 짧게 반복 실행하므로(SPRINT_1_DESIGN.md 6절) 프로세스가 매번
// 죽는다. offset을 메모리에 두면 실행할 때마다 처음부터 다시 받아 같은 버튼 클릭을 반복 처리하게
// 된다. Telegram은 confirm되지 않은 update를 최대 24시간 보관하므로, offset이 없으면 하루치
// 클릭이 전부 재처리된다.

import { supabase } from "../services/supabase/client.js";
import type { TelegramOffsetRow } from "../types/database.js";

/** 기본 수신기 이름. 수신기가 여러 개로 늘어나도 서로의 커서를 침범하지 않게 한다. */
export const DEFAULT_TELEGRAM_RECEIVER_ID = "keyword-bot";

export class TelegramOffsetRepository {
  /** 마지막으로 처리한 update_id. 한 번도 실행된 적 없으면 null. */
  static async getLastUpdateId(receiverId = DEFAULT_TELEGRAM_RECEIVER_ID): Promise<number | null> {
    const { data, error } = await supabase
      .from("telegram_offsets")
      .select("last_update_id")
      .eq("id", receiverId)
      .maybeSingle();

    if (error) throw error;
    return data?.last_update_id ?? null;
  }

  /**
   * 커서를 전진시킨다. 이미 저장된 값보다 작으면 무시한다 - 수신기가 두 개 겹쳐 돌거나 오래된
   * update를 뒤늦게 처리한 경우에 커서가 뒤로 밀려 재처리가 일어나는 것을 막는다.
   */
  static async setLastUpdateId(
    updateId: number,
    receiverId = DEFAULT_TELEGRAM_RECEIVER_ID
  ): Promise<TelegramOffsetRow | null> {
    const current = await this.getLastUpdateId(receiverId);
    if (current !== null && updateId <= current) return null;

    const { data, error } = await supabase
      .from("telegram_offsets")
      .upsert(
        { id: receiverId, last_update_id: updateId, updated_at: new Date().toISOString() },
        { onConflict: "id" }
      )
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /** 테스트 cleanup 등에서 특정 수신기의 커서를 지운다. */
  static async reset(receiverId = DEFAULT_TELEGRAM_RECEIVER_ID): Promise<void> {
    const { error } = await supabase.from("telegram_offsets").delete().eq("id", receiverId);
    if (error) throw error;
  }
}
