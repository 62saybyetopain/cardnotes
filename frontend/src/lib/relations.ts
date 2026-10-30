// 卡片連結類型的前端輔助：舊值轉換、對稱類型方向統一、左右側預設。
// @depends-on ../types.ts (RELATION_TYPES, RELATION_CATEGORIES, SYMMETRIC_RELATIONS, RelationType, LinkStatus)
// 與後端 relation_types.py 同文：LEGACY_RELATION_MAP、LEGACY_FORCE_HYPOTHESIS（test_relation_contract.py 檢查）
import {
  RELATION_CATEGORIES,
  RELATION_TYPES,
  SYMMETRIC_RELATIONS,
  type LinkStatus,
  type RelationType,
} from "../types";

/** 舊值 → 新值。舊版前端快取、舊版備份檔、iPad 本機資料庫裡都還可能出現舊值。 */
export const LEGACY_RELATION_MAP: Readonly<Record<string, RelationType>> = {
  support: "支持",
  refute: "反駁",
  influence: "導致",
  instance_of: "實例",
  applied_to: "應用於",
  extend: "延伸",
};

/** 「可能影響」轉成「導致」語氣會變強，所以舊的 influence 一律降為待驗證假說。 */
export const LEGACY_FORCE_HYPOTHESIS: ReadonlySet<string> = new Set(["influence"]);

const KNOWN_TYPES: ReadonlySet<string> = new Set<string>(RELATION_TYPES);

function isLegacy(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(LEGACY_RELATION_MAP, value);
}

export function isSymmetricRelation(rel: RelationType): boolean {
  return SYMMETRIC_RELATIONS.has(rel);
}

/** 舊值或新值 → 新值。不認得的值直接丟錯，不靜默改成別的類型。 */
export function upgradeRelationType(value: string): RelationType {
  if (isLegacy(value)) return LEGACY_RELATION_MAP[value];
  if (KNOWN_TYPES.has(value)) return value as RelationType;
  throw new Error(`未知的關係類型：${value}`);
}

function asLinkStatus(value: string): LinkStatus {
  if (value === "confirmed" || value === "hypothesis") return value;
  throw new Error(`未知的連結狀態：${value}`);
}

/**
 * 關係類型與狀態一起轉換。status 只在「舊的 influence 且狀態未指定或為 confirmed」時被改成 hypothesis；
 * 其餘情況原樣返回（未指定則為 undefined，由呼叫端決定預設值或沿用既有狀態）。與後端 _upgrade_legacy_relation 同義。
 */
export function upgradeLinkRelation(
  value: string,
  status?: string,
): { relation_type: RelationType; status?: LinkStatus } {
  const relation_type = upgradeRelationType(value);
  if (LEGACY_FORCE_HYPOTHESIS.has(value) && (status === undefined || status === "confirmed")) {
    return { relation_type, status: "hypothesis" };
  }
  return { relation_type, status: status === undefined ? undefined : asLinkStatus(status) };
}

/** 對稱類型固定成 source_id < target_id（與後端 canonical_endpoints 同；id 為 ASCII 的 UUID，字串比較結果一致）。 */
export function canonicalEndpoints(rel: RelationType, sourceId: string, targetId: string): [string, string] {
  return isSymmetricRelation(rel) && sourceId > targetId ? [targetId, sourceId] : [sourceId, targetId];
}

export type Side = "left" | "right";

/** 白板「依類型分左右」的預設：反駁與張力類（張力、取代、限制）放左側，其餘放右側。 */
export function buildDefaultTypeSideMap(): Record<RelationType, Side> {
  const out = {} as Record<RelationType, Side>;
  for (const rel of RELATION_TYPES) {
    out[rel] = rel === "反駁" || RELATION_CATEGORIES[rel].isTension ? "left" : "right";
  }
  return out;
}

/** 讀 localStorage 裡存的左右設定：舊 key 轉成新 key，不認得的 key 與不是 left／right 的值丟掉。 */
export function upgradeTypeSideMap(raw: unknown): Partial<Record<RelationType, Side>> {
  const out: Partial<Record<RelationType, Side>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v !== "left" && v !== "right") continue;
    const key = isLegacy(k) ? LEGACY_RELATION_MAP[k] : KNOWN_TYPES.has(k) ? (k as RelationType) : null;
    if (key) out[key] = v;
  }
  return out;
}
