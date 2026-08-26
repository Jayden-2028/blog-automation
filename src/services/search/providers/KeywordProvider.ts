import type { RawKeyword } from "../../../types/keywordDiscovery.js";

export interface KeywordProvider {
  fetchKeywords(): Promise<RawKeyword[]>;
}
