import type { RelationType } from "../types";
import { buildDefaultTypeSideMap, upgradeTypeSideMap } from "./relations";

const SNAP_KEY = "cardboard:snap-to-grid";
const LAYOUT_PREFS_KEY = "cardboard:layout-prefs";

export type LayoutMode = "grid" | "radial" | "right" | "split";
export type SplitMode = "direction" | "type";

export interface SavedLayoutPrefs {
  mode: LayoutMode;
  gap: number;
  clusterThreshold: number;
  splitMode: SplitMode;
  typeSideMap: Record<RelationType, "left" | "right">;
}

export const DEFAULT_TYPE_SIDE_MAP: Record<RelationType, "left" | "right"> = buildDefaultTypeSideMap();

export function loadSnapToGrid(): boolean {
  try {
    const raw = localStorage.getItem(SNAP_KEY);
    if (raw === null) return true; // 預設開啟
    return raw === "true";
  } catch {
    return true;
  }
}

export function saveSnapToGrid(enabled: boolean): void {
  try {
    localStorage.setItem(SNAP_KEY, enabled ? "true" : "false");
  } catch {
    /* localStorage 不可用時忽略 */
  }
}

export function loadLayoutPrefs(): SavedLayoutPrefs {
  const fallback: SavedLayoutPrefs = {
    mode: "grid",
    gap: 40,
    clusterThreshold: 4,
    splitMode: "type",
    typeSideMap: { ...DEFAULT_TYPE_SIDE_MAP },
  };
  try {
    const raw = localStorage.getItem(LAYOUT_PREFS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    return {
      mode:
        p?.mode === "grid" || p?.mode === "radial" || p?.mode === "right" || p?.mode === "split"
          ? p.mode
          : fallback.mode,
      gap: typeof p?.gap === "number" && Number.isFinite(p.gap) ? Math.min(160, Math.max(20, p.gap)) : fallback.gap,
      clusterThreshold:
        typeof p?.clusterThreshold === "number" && Number.isFinite(p.clusterThreshold)
          ? Math.min(20, Math.max(2, Math.round(p.clusterThreshold)))
          : fallback.clusterThreshold,
      splitMode: p?.splitMode === "direction" || p?.splitMode === "type" ? p.splitMode : fallback.splitMode,
      typeSideMap: {
        ...DEFAULT_TYPE_SIDE_MAP,
        ...upgradeTypeSideMap(p?.typeSideMap), // 舊的 key（refute、extend…）在這裡轉成新 key
      },
    };
  } catch {
    return fallback;
  }
}

export function saveLayoutPrefs(prefs: SavedLayoutPrefs): void {
  try {
    localStorage.setItem(LAYOUT_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* localStorage 不可用時忽略 */
  }
}