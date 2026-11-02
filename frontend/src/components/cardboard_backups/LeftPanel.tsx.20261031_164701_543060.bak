// @depends-on ./SyncModal.tsx (SyncModal)
// @depends-on ../lib/storage/index.ts (getPreferredDriverType)
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../api";
import { getPreferredDriverType } from "../lib/storage";
import { buildTree, descendantIds, isSameAxisGroup, tagPath, type TreeNode } from "../lib/tree";
import type { Axis, BoardSummary, CardSummary, CleanupResult, Tag } from "../types";
import { FacetPicker } from "./FacetPicker";
import type { Filter } from "./RightPanel";
import { SyncModal } from "./SyncModal";

interface Props {
  boards: BoardSummary[];
  boardId: string | null;
  tags: Tag[];
  unclassifiedCount: number;
  inboxCount?: number;
  filter: Filter;
  isSearchTab?: boolean;
  theme: "dark" | "light";
  onToggleTheme(): void;
  onToggleCollapse(): void;
  onSelectBoard(id: string): void;
  onBoardsChanged(): void;
  onFilter(f: Filter): void;
  onTagsChanged(): void;
  report(e: unknown, prefix?: string): void;
}

// 線條圖標：規格與 Board.tsx 的 CrosshairIcon 一致（stroke=currentColor、圓端點、線寬為尺寸的 1/10）。
// viewBox 用 24 以沿用 Feather 風格幾何，所以線寬是 2.4（= 24 × 0.1）
type IconName =
  | "layers"
  | "inbox"
  | "folder"
  | "folder-dashed"
  | "search"
  | "cloud"
  | "trash"
  | "sun"
  | "moon"
  | "chevron-left"
  | "plus"
  | "x"
  | "pencil"
  | "sliders"
  | "merge"
  | "arrow-up-right"
  | "more";

const FOLDER_PATH = "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z";

const ICON_SHAPES: Record<IconName, ReactNode> = {
  layers: (
    <>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </>
  ),
  inbox: (
    <>
      <polyline points="22 12 16 12 14 15 10 15 8 12 2 12" />
      <path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>
  ),
  folder: <path d={FOLDER_PATH} />,
  "folder-dashed": <path d={FOLDER_PATH} strokeDasharray="4 3" />,
  search: (
    <>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </>
  ),
  cloud: <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />,
  trash: (
    <>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
      <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
      <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
      <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
    </>
  ),
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />,
  "chevron-left": <polyline points="15 18 9 12 15 6" />,
  plus: (
    <>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </>
  ),
  x: (
    <>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </>
  ),
  pencil: <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />,
  sliders: (
    <>
      <line x1="4" y1="21" x2="4" y2="14" />
      <line x1="4" y1="10" x2="4" y2="3" />
      <line x1="12" y1="21" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12" y2="3" />
      <line x1="20" y1="21" x2="20" y2="16" />
      <line x1="20" y1="12" x2="20" y2="3" />
      <line x1="1" y1="14" x2="7" y2="14" />
      <line x1="9" y1="8" x2="15" y2="8" />
      <line x1="17" y1="16" x2="23" y2="16" />
    </>
  ),
  merge: (
    <>
      <circle cx="18" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <path d="M6 21V9a9 9 0 0 0 9 9" />
    </>
  ),
  "arrow-up-right": (
    <>
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </>
  ),
};

function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_SHAPES[name]}
    </svg>
  );
}

const AXIS_LABEL: Record<Axis, string> = {
  location: "收納位置（櫃子／抽屜）",
  domain: "收納位置（櫃子／抽屜）",
  type: "類型",
  concept: "概念標籤（描述維度）",
  free: "概念標籤（描述維度）",
};

// 標籤排序：default 維持各清單原本的順序；其餘兩種依「卡片最後更新時間」（updated_at）計算，編輯內文也算
type TagSortMode = "default" | "recent-touch" | "recent-freq";
const TAG_SORT_LABEL: Record<TagSortMode, string> = {
  default: "預設",
  "recent-touch": "最近有動靜",
  "recent-freq": "近期常用",
};
// 「近期常用」只統計最近更新的這幾張卡片
const RECENT_CARD_WINDOW = 30;

export function LeftPanel(p: Props) {
  const [moving, setMoving] = useState<Tag | null>(null);
  const [editingTag, setEditingTag] = useState<Tag | null>(null);
  const [mergingTag, setMergingTag] = useState<Tag | null>(null);
  const [dragging, setDragging] = useState<Tag | null>(null);
  const [cleanup, setCleanup] = useState<CleanupResult | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [syncOpen, setSyncOpen] = useState(false);
  const [tagQuery, setTagQuery] = useState("");
  const [tagSearchOpen, setTagSearchOpen] = useState(false);
  const [showEmptyTags, setShowEmptyTags] = useState(false);
  const [tagMenuOpen, setTagMenuOpen] = useState(false);
  const [fallbackCounts, setFallbackCounts] = useState<Map<string, number>>(new Map());
  const [countsReady, setCountsReady] = useState(false);
  const [sortMode, setSortMode] = useState<TagSortMode>("default");
  const [recentCards, setRecentCards] = useState<CardSummary[]>([]);
  const searchWrapRef = useRef<HTMLDivElement>(null);

  const hasNativeCount = useMemo(
    () => p.tags.some((t) => typeof (t as Tag & { card_count?: unknown }).card_count === "number"),
    [p.tags],
  );

  useEffect(() => {
    if (hasNativeCount) {
      setCountsReady(true);
      return;
    }
    let alive = true;
    api
      .listCards({ limit: 200 })
      .then((r) => {
        if (!alive) return;
        const map = new Map<string, number>();
        for (const c of r.items) {
          for (const t of c.tags ?? []) {
            map.set(t.id, (map.get(t.id) ?? 0) + 1);
          }
        }
        setFallbackCounts(map);
        setCountsReady(true);
      })
      .catch(() => {
        if (alive) {
          setCountsReady(false);
        }
      });
    return () => {
      alive = false;
    };
  }, [p.tags, hasNativeCount]);

  useEffect(() => {
    if (!tagSearchOpen && !tagMenuOpen) return;
    const closeAll = () => {
      setTagSearchOpen(false);
      setTagMenuOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target as Node)) closeAll();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAll();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [tagSearchOpen, tagMenuOpen]);

  const getDirectCardCount = useCallback(
    (t: Tag): number => {
      const native = (t as Tag & { card_count?: unknown }).card_count;
      if (typeof native === "number") return native;
      return fallbackCounts.get(t.id) ?? 0;
    },
    [fallbackCounts],
  );

  const getSubtreeCardCount = useCallback(
    (node: TreeNode): number => {
      let sum = getDirectCardCount(node.tag);
      for (const child of node.children) {
        sum += getSubtreeCardCount(child);
      }
      return sum;
    },
    [getDirectCardCount],
  );

  const filterTreeByCount = useCallback(
    (nodes: TreeNode[]): TreeNode[] => {
      if (showEmptyTags || !countsReady || (!hasNativeCount && fallbackCounts.size === 0)) return nodes;
      const out: TreeNode[] = [];
      for (const n of nodes) {
        const filteredChildren = filterTreeByCount(n.children);
        const total = getSubtreeCardCount(n);
        if (total > 0 || p.filter.tagId === n.tag.id || filteredChildren.length > 0) {
          out.push({ ...n, children: filteredChildren });
        }
      }
      return out;
    },
    [countsReady, getSubtreeCardCount, p.filter.tagId, showEmptyTags],
  );

  // 近期排序的資料來源：卡片 updated_at。只在選了近期排序時才抓；失敗要大聲報錯，不默默沿用舊資料
  useEffect(() => {
    if (sortMode === "default") return;
    let alive = true;
    api
      .listCards({ limit: 200 })
      .then((r) => {
        if (alive) setRecentCards(r.items);
      })
      .catch((e) => {
        if (alive) p.report(e, "載入近期卡片失敗，標籤排序可能不是最新");
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.tags, sortMode]);

  const recentStats = useMemo(() => {
    const sorted = [...recentCards].sort((a, b) =>
      a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0,
    );
    const stats = new Map<string, { lastTouched: string; recentCount: number }>();
    sorted.forEach((c, i) => {
      for (const t of c.tags ?? []) {
        let s = stats.get(t.id);
        if (!s) {
          s = { lastTouched: c.updated_at, recentCount: 0 }; // 由新到舊走訪，第一次遇到的就是最近一次
          stats.set(t.id, s);
        }
        if (i < RECENT_CARD_WINDOW) s.recentCount += 1;
      }
    });
    return stats;
  }, [recentCards]);

  // default 模式下等同原本下拉選單的「卡片數多→少、再依名稱」
  const compareBySort = useCallback(
    (a: Tag, b: Tag): number => {
      const sa = recentStats.get(a.id);
      const sb = recentStats.get(b.id);
      if (sortMode === "recent-touch") {
        const ta = sa?.lastTouched ?? "";
        const tb = sb?.lastTouched ?? "";
        if (ta !== tb) return ta < tb ? 1 : -1;
      } else if (sortMode === "recent-freq") {
        const ca = sa?.recentCount ?? 0;
        const cb = sb?.recentCount ?? 0;
        if (ca !== cb) return cb - ca;
      }
      return getDirectCardCount(b) - getDirectCardCount(a) || a.name.localeCompare(b.name);
    },
    [getDirectCardCount, recentStats, sortMode],
  );

  const locationTreeNodes = useMemo(
    () => filterTreeByCount(buildTree(p.tags, "location")),
    [filterTreeByCount, p.tags],
  );

  const conceptFacetGroups = useMemo(() => {
    const rawNodes = filterTreeByCount(buildTree(p.tags, "concept"));
    const groups = new Map<string, { facet: string; nodes: TreeNode[]; totalCards: number }>();
    for (const n of rawNodes) {
      const facetName = n.tag.facet?.trim() || "未指定維度";
      let g = groups.get(facetName);
      if (!g) {
        g = { facet: facetName, nodes: [], totalCards: 0 };
        groups.set(facetName, g);
      }
      g.nodes.push(n);
      g.totalCards += getDirectCardCount(n.tag);
    }
    if (sortMode !== "default") {
      for (const g of groups.values()) g.nodes.sort((x, y) => compareBySort(x.tag, y.tag));
    }
    return Array.from(groups.values()).sort((a, b) => {
      if (a.facet === "未指定維度") return 1;
      if (b.facet === "未指定維度") return -1;
      return b.totalCards - a.totalCards || a.facet.localeCompare(b.facet);
    });
  }, [compareBySort, filterTreeByCount, getDirectCardCount, p.tags, sortMode]);

  const dropdownTags = useMemo(() => {
    const q = tagQuery.trim().toLowerCase();
    if (!q) {
      const nonEmpty = p.tags.filter((t) => getDirectCardCount(t) > 0);
      const base = nonEmpty.length > 0 ? nonEmpty : p.tags;
      return [...base]
        .sort(compareBySort)
        .slice(0, 30)
        .map((t) => ({ tag: t, matchedAlias: null as string | null, count: getDirectCardCount(t) }));
    }
    const matches: { tag: Tag; matchedAlias: string | null; count: number; rank: number }[] = [];
    for (const t of p.tags) {
      const nameLower = t.name.toLowerCase();
      const pathLower = tagPath(p.tags, t.id).toLowerCase();
      const facetLower = (t.facet ?? "").toLowerCase();
      const hitAlias = (t.aliases ?? []).find((a) => a.toLowerCase().includes(q)) ?? null;
      let rank = 0;
      if (nameLower === q || (hitAlias && hitAlias.toLowerCase() === q)) rank = 4;
      else if (nameLower.startsWith(q) || (hitAlias && hitAlias.toLowerCase().startsWith(q))) rank = 3;
      else if (nameLower.includes(q) || hitAlias) rank = 2;
      else if (pathLower.includes(q) || facetLower.includes(q)) rank = 1;
      if (rank > 0) {
        matches.push({ tag: t, matchedAlias: hitAlias, count: getDirectCardCount(t), rank });
      }
    }
    return matches
      .sort((a, b) => b.rank - a.rank || b.count - a.count || a.tag.name.localeCompare(b.tag.name))
      .slice(0, 30);
  }, [compareBySort, getDirectCardCount, p.tags, tagQuery]);

  const run = async (fn: () => Promise<unknown>, prefix: string) => {
    try {
      await fn();
    } catch (e) {
      p.report(e, prefix);
    }
  };

  // ---- 白板 ----
  const newBoard = () =>
    run(async () => {
      const name = window.prompt("新白板名稱");
      if (!name?.trim()) return;
      const b = await api.createBoard(name.trim());
      p.onBoardsChanged();
      p.onSelectBoard(b.id);
    }, "建立白板失敗");
  const renameBoard = (b: BoardSummary) =>
    run(async () => {
      const name = window.prompt("白板新名稱", b.name);
      if (!name?.trim() || name.trim() === b.name) return;
      await api.renameBoard(b.id, name.trim());
      p.onBoardsChanged();
    }, "改名失敗");
  const deleteBoard = (b: BoardSummary) =>
    run(async () => {
      if (!window.confirm(`刪除白板「${b.name}」？\n只會刪除白板與卡片的擺放位置，卡片本身不會被刪除。`)) return;
      await api.deleteBoard(b.id);
      p.onBoardsChanged();
    }, "刪除白板失敗");

  // ---- 標籤 ----
  const createTag = (axis: Axis, parent: Tag | null) =>
    run(async () => {
      const name = window.prompt(parent ? `在「${parent.name}」底下新增` : `新增${AXIS_LABEL[axis]}`);
      if (!name?.trim()) return;
      await api.createTag(name.trim(), axis, parent?.id ?? null);
      p.onTagsChanged();
    }, "新增標籤失敗");
  const renameTag = (t: Tag) =>
    run(async () => {
      const name = window.prompt("新名稱", t.name);
      if (!name?.trim() || name.trim() === t.name) return;
      await api.patchTag(t.id, { name: name.trim() });
      p.onTagsChanged();
    }, "改名失敗");
  const deleteTag = (t: Tag) =>
    run(async () => {
      const plan = await api.deletePreview(t.id);
      if (plan.conflicts.length) {
        window.alert(`無法刪除：子標籤上移後會與同層標籤同名（${plan.conflicts.join("、")}）。請先改名再刪除。`);
        return;
      }
      const lines = [`刪除「${tagPath(p.tags, t.id)}」？`];
      if (plan.child_count)
        lines.push(`・${plan.child_count} 個子抽屜會上移到${plan.new_parent ? `「${plan.new_parent.name}」底下` : "最上層"}`);
      if (plan.card_count)
        lines.push(
          plan.new_parent
            ? `・${plan.card_count} 張卡片會改歸屬到「${plan.new_parent.name}」`
            : `・${plan.card_count} 張卡片會移除這個歸屬（卡片本身不會被刪除；沒有其他領域歸屬的會變成未分類）`,
        );
      if (!window.confirm(lines.join("\n"))) return;
      await api.deleteTag(t.id);
      if (p.filter.tagId === t.id) p.onFilter({});
      p.onTagsChanged();
    }, "刪除標籤失敗");
  const moveTag = (t: Tag, parentId: string | null) =>
    run(async () => {
      if (t.parent_id === parentId) {
        setMoving(null);
        return;
      }
      await api.patchTag(t.id, { parent_id: parentId });
      setMoving(null);
      p.onTagsChanged();
    }, "移動失敗");

  const isFlat = (a: Axis) => a === "free" || a === "concept";

  const canDropOn = (dragged: Tag | null, target: Tag | null, axis: Axis): boolean => {
    if (!dragged || !isSameAxisGroup(dragged.axis, axis) || isFlat(axis)) return false;
    if (target === null) return dragged.parent_id !== null;
    if (dragged.id === target.id || dragged.parent_id === target.id) return false;
    return !descendantIds(p.tags, dragged.id).has(target.id);
  };

  const handleDrop = (target: Tag | null, axis: Axis, rawId?: string) => {
    const dragged = dragging ?? p.tags.find((t) => t.id === rawId) ?? null;
    setDragging(null);
    if (!dragged) return;
    if (!isSameAxisGroup(dragged.axis, axis)) {
      p.report(new Error("不能跨軸移動標籤"), "移動失敗");
      return;
    }
    if (target && descendantIds(p.tags, dragged.id).has(target.id)) {
      p.report(new Error("不能把標籤移到自己或自己的後代底下"), "移動失敗");
      return;
    }
    const newParentId = target ? target.id : null;
    if (dragged.parent_id === newParentId) return;
    void moveTag(dragged, newParentId);
  };

  // ---- 孤兒媒體清理 ----
  const openCleanup = () =>
    run(async () => {
      const res = await api.cleanupMedia(true);
      setCleanup(res);
    }, "檢查孤兒媒體失敗");

  const confirmCleanup = () =>
    run(async () => {
      setCleaning(true);
      try {
        const res = await api.cleanupMedia(false);
        setCleanup(res);
      } finally {
        setCleaning(false);
      }
    }, "清理孤兒媒體失敗");

  return (
    <nav className="left" aria-label="路徑與功能">
      <div className="left-header">
        <span className="left-header-title">白板筆記</span>
        <div className="left-header-actions">
          <button
            type="button"
            className="icon-btn"
            onClick={p.onToggleTheme}
            aria-label={p.theme === "dark" ? "切換至淺色模式" : "切換至深色模式"}
            title={p.theme === "dark" ? "切換至淺色模式" : "切換至深色模式"}
          >
            <Icon name={p.theme === "dark" ? "sun" : "moon"} size={16} />
          </button>
          <button
            type="button"
            className="icon-btn"
            onClick={p.onToggleCollapse}
            aria-label="收納左側面板"
            title="收納左側面板"
          >
            <Icon name="chevron-left" size={16} />
          </button>
        </div>
      </div>

      <section>
        <div className="section-head">
          <h3>白板</h3>
          <button onClick={() => void newBoard()} aria-label="新增白板">
            <Icon name="plus" size={12} />
          </button>
        </div>
        {p.boards.length === 0 && <div className="muted pad">還沒有白板</div>}
        <ul className="plain">
          {p.boards.map((b) => (
            <li key={b.id} className={`row${b.id === p.boardId ? " on" : ""}`}>
              <button className="label" onClick={() => p.onSelectBoard(b.id)}>
                {b.name} <span className="count">{b.card_count}</span>
              </button>
              <span className="actions">
                <button onClick={() => void renameBoard(b)} aria-label={`重新命名 ${b.name}`}>
                  <Icon name="pencil" size={12} />
                </button>
                <button onClick={() => void deleteBoard(b)} aria-label={`刪除白板 ${b.name}`}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <div className="section-head">
          <h3>卡片冊</h3>
        </div>
        <div
          className={`row nav-row${
            p.isSearchTab && !p.filter.unclassified && !p.filter.tagId && !p.filter.curationStatus ? " on" : ""
          }`}
        >
          <button className="label" onClick={() => p.onFilter({})}>
            <Icon name="layers" /> 全部卡片
          </button>
        </div>
        <div className={`row nav-row${p.filter.curationStatus === "inbox" ? " on" : ""}`}>
          <button
            className="label"
            onClick={() => p.onFilter({ curationStatus: "inbox" })}
            title="尚未整理的卡片"
          >
            <Icon name="inbox" /> 收件夾 <span className="count">{p.inboxCount ?? 0}</span>
          </button>
        </div>
        <div className={`row nav-row${p.filter.unclassified ? " on" : ""}`}>
          <button
            className="label"
            onClick={() => p.onFilter({ unclassified: true })}
            title="尚未放進任何收納位置的卡片"
          >
            <Icon name="folder-dashed" /> 未歸檔 <span className="count">{p.unclassifiedCount}</span>
          </button>
        </div>
      </section>

      <section style={{ paddingBottom: 4 }}>
        <div className="section-head">
          <h3>標籤</h3>
        </div>
        <div ref={searchWrapRef} style={{ position: "relative", padding: "4px 0" }}>
          <div className="tag-search">
            <Icon name="search" />
            <input
              value={tagQuery}
              onFocus={() => {
                setTagMenuOpen(false);
                setTagSearchOpen(true);
              }}
              onClick={() => setTagSearchOpen(true)}
              onChange={(e) => {
                setTagQuery(e.target.value);
                setTagSearchOpen(true);
              }}
              placeholder="搜尋標籤或別名…"
              aria-label="搜尋標籤或別名"
            />
            {tagQuery && (
              <button type="button" onClick={() => setTagQuery("")} title="清除搜尋" aria-label="清除搜尋">
                <Icon name="x" size={12} />
              </button>
            )}
            <button
              type="button"
              className={tagMenuOpen || showEmptyTags ? "on" : ""}
              aria-haspopup="menu"
              aria-expanded={tagMenuOpen}
              onClick={() => {
                setTagSearchOpen(false);
                setTagMenuOpen((v) => !v);
              }}
              title="標籤顯示選項"
              aria-label="標籤顯示選項"
            >
              <Icon name="more" size={16} />
            </button>
            {tagMenuOpen && (
              <div className="tag-filter-menu" role="menu">
                <label>
                  <input
                    type="checkbox"
                    checked={showEmptyTags}
                    onChange={(e) => setShowEmptyTags(e.target.checked)}
                  />
                  顯示沒有卡片的標籤
                </label>
                <p>預設只列出有卡片的標籤，避免清單被空標籤塞滿。這個選項只影響下方的收納位置與概念標籤清單。</p>
                <div className="tag-sort-group" role="radiogroup" aria-label="標籤排序">
                  <span className="muted">排序（概念標籤與下拉選單）</span>
                  {(Object.keys(TAG_SORT_LABEL) as TagSortMode[]).map((m) => (
                    <label key={m}>
                      <input type="radio" name="tag-sort" checked={sortMode === m} onChange={() => setSortMode(m)} />
                      {TAG_SORT_LABEL[m]}
                    </label>
                  ))}
                  <p>
                    「最近有動靜」依標籤所屬卡片的最後更新時間；「近期常用」統計最近更新的 {RECENT_CARD_WINDOW} 張卡片。編輯內文也算更新。
                  </p>
                </div>
              </div>
            )}
          </div>

          {tagSearchOpen && (
            <div
              role="listbox"
              aria-label="標籤檢索選單"
              style={{
                position: "absolute",
                left: 0,
                right: 0,
                top: "calc(100% + 2px)",
                maxHeight: 280,
                overflowY: "auto",
                background: "var(--panel, #1e293b)",
                border: "1px solid var(--line, #475569)",
                borderRadius: 6,
                boxShadow: "0 6px 16px rgba(0, 0, 0, 0.38)",
                zIndex: 60,
                padding: "4px 0",
              }}
            >
              <div
                className="muted"
                style={{
                  fontSize: 11,
                  padding: "4px 10px",
                  borderBottom: "1px solid var(--line, #334155)",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>
                  {tagQuery.trim()
                    ? "相關標籤（含別名比對）"
                    : sortMode === "default"
                      ? "常用標籤（依卡片數排序）"
                      : `常用標籤（依「${TAG_SORT_LABEL[sortMode]}」排序）`}
                </span>
                <span>卡片數</span>
              </div>
              {dropdownTags.length === 0 ? (
                <div className="muted" style={{ fontSize: 12, padding: "8px 10px" }}>
                  找不到符合「{tagQuery.trim()}」的標籤或別名
                </div>
              ) : (
                <ul className="plain" style={{ margin: 0 }}>
                  {dropdownTags.map(({ tag: t, matchedAlias, count }) => {
                    const isLoc = isSameAxisGroup(t.axis, "location");
                    return (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => {
                            p.onFilter({ tagId: t.id });
                            setTagSearchOpen(false);
                          }}
                          style={{
                            width: "100%",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 6,
                            padding: "5px 10px",
                            border: "none",
                            background: p.filter.tagId === t.id ? "var(--row-hover, rgba(59,130,246,0.15))" : "transparent",
                            color: "var(--text)",
                            fontSize: 12,
                            textAlign: "left",
                            cursor: "pointer",
                          }}
                        >
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {isLoc ? (
                              <span className="facet-badge"><Icon name="folder" size={11} /> 抽屜</span>
                            )  : (
                              t.facet && <span className="facet-badge">{t.facet}</span>
                            )}
                            <span>{isLoc ? tagPath(p.tags, t.id) : t.name}</span>
                            {matchedAlias && (
                              <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                                （別名：{matchedAlias}）
                              </span>
                            )}
                          </span>
                          <span className="count" style={{ flexShrink: 0 }}>
                            {count}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}
        </div>
      </section>

      <details open>
        <summary
          onDragOver={(e) => {
            if (canDropOn(dragging, null, "location")) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          }}
          onDrop={(e) => {
            e.preventDefault();
            handleDrop(null, "location", e.dataTransfer.getData("text/plain"));
          }}
          title="點擊展開／收合收納位置；將子抽屜拖曳至此處可移回最上層"
        >
          {AXIS_LABEL.location}
          <button
            className="add"
            onClick={(e) => (e.preventDefault(), void createTag("location", null))}
            aria-label="新增櫃子"
          >
            <Icon name="plus" size={12} /> 櫃子
          </button>
        </summary>
        {locationTreeNodes.length === 0 ? (
          <div className="muted pad" style={{ fontSize: 12 }}>
            尚無含卡片的收納位置
          </div>
        ) : (
          <Tree
            nodes={locationTreeNodes}
            axis="location"
            filter={p.filter}
            dragging={dragging}
            canDropOn={canDropOn}
            onDragStartTag={setDragging}
            onDragEndTag={() => setDragging(null)}
            onDropTag={handleDrop}
            onFilter={p.onFilter}
            onAdd={(t) => void createTag(t.axis, t)}
            onRename={(t) => void renameTag(t)}
            onEditMeta={setEditingTag}
            onMerge={setMergingTag}
            onMove={setMoving}
            onDelete={(t) => void deleteTag(t)}
            getCardCount={getSubtreeCardCount}
          />
        )}
      </details>

      <details open>
        <summary>
          {AXIS_LABEL.concept}
          <button
            className="add"
            onClick={(e) => (e.preventDefault(), void createTag("concept", null))}
            aria-label="新增概念標籤"
          >
            <Icon name="plus" size={12} />
          </button>
        </summary>
        {conceptFacetGroups.length === 0 ? (
          <div className="muted pad" style={{ fontSize: 12 }}>
            尚無含卡片的概念標籤
          </div>
        ) : (
          conceptFacetGroups.map((group) => (
            <details key={group.facet} open style={{ marginLeft: 6, marginBottom: 2 }}>
              <summary
                style={{
                  fontSize: 12,
                  padding: "3px 8px",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <span className="facet-badge">{group.facet}</span>
                <span className="count" style={{ marginLeft: "auto" }}>
                  {group.nodes.length} 標籤 · {group.totalCards} 卡
                </span>
              </summary>
              <Tree
                nodes={group.nodes}
                axis="concept"
                filter={p.filter}
                dragging={dragging}
                canDropOn={canDropOn}
                onDragStartTag={setDragging}
                onDragEndTag={() => setDragging(null)}
                onDropTag={handleDrop}
                onFilter={p.onFilter}
                onAdd={(t) => void createTag(t.axis, t)}
                onRename={(t) => void renameTag(t)}
                onEditMeta={setEditingTag}
                onMerge={setMergingTag}
                onMove={setMoving}
                onDelete={(t) => void deleteTag(t)}
                canNest={false}
                getCardCount={(n) => getDirectCardCount(n.tag)}
                hideFacetBadge={true}
              />
            </details>
          ))
        )}
      </details>

      <section>
        <div className="section-head">
          <h3>資料維護與同步</h3>
        </div>
        <div className="row">
          <button className="label" onClick={() => setSyncOpen(true)} aria-label="資料同步與備份">
            <Icon name="cloud" /> 同步／備份
          </button>
        </div>
        {getPreferredDriverType() !== "dexie" && (
          <div className="row">
            <button className="label" onClick={() => void openCleanup()} aria-label="清理孤兒媒體">
              <Icon name="trash" /> 清理孤兒媒體
            </button>
          </div>
        )}
      </section>

      {syncOpen && (
        <SyncModal
          onClose={() => setSyncOpen(false)}
          onApplied={() => {
            p.onTagsChanged();
            p.onBoardsChanged();
          }}
          report={p.report}
          info={(text) => p.report(null, text)}
        />
      )}

      {moving && <MoveDialog tag={moving} tags={p.tags} onCancel={() => setMoving(null)} onMove={(id) => void moveTag(moving, id)} />}
      {editingTag && (
        <TagMetaDialog
          tag={p.tags.find((x) => x.id === editingTag.id) ?? editingTag}
          onClose={() => setEditingTag(null)}
          onChanged={p.onTagsChanged}
          report={p.report}
        />
      )}
      {mergingTag && (
        <MergeTagDialog
          source={mergingTag}
          tags={p.tags}
          onClose={() => setMergingTag(null)}
          onMerged={() => {
            if (p.filter.tagId === mergingTag.id) p.onFilter({});
            setMergingTag(null);
            p.onTagsChanged();
          }}
          report={p.report}
        />
      )}
      {cleanup && (
        <CleanupDialog
          result={cleanup}
          cleaning={cleaning}
          onClose={() => setCleanup(null)}
          onConfirm={() => void confirmCleanup()}
        />
      )}
    </nav>
  );
}

function Tree(props: {
  nodes: TreeNode[];
  axis: Axis;
  filter: Filter;
  dragging: Tag | null;
  canDropOn(dragged: Tag | null, target: Tag | null, axis: Axis): boolean;
  onDragStartTag(t: Tag): void;
  onDragEndTag(): void;
  onDropTag(target: Tag | null, axis: Axis, rawId?: string): void;
  onFilter(f: Filter): void;
  onAdd(t: Tag): void;
  onRename(t: Tag): void;
  onEditMeta(t: Tag): void;
  onMerge(t: Tag): void;
  onMove(t: Tag): void;
  onDelete(t: Tag): void;
  canNest?: boolean;
  getCardCount?(n: TreeNode): number;
  hideFacetBadge?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const nest = props.canNest !== false;
  return (
    <ul className="plain tree">
      {props.nodes.map((n) => (
        <li key={n.tag.id}>
          <div
            className={`row${props.filter.tagId === n.tag.id ? " on" : ""}`}
            draggable={nest}
            onDragStart={(e) => {
              if (!nest) return;
              e.stopPropagation();
              e.dataTransfer.setData("text/plain", n.tag.id);
              e.dataTransfer.effectAllowed = "move";
              props.onDragStartTag(n.tag);
            }}
            onDragEnd={() => props.onDragEndTag()}
            onDragOver={(e) => {
              if (!nest) return;
              if (!props.dragging || props.canDropOn(props.dragging, n.tag, props.axis)) {
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(e) => {
              if (!nest) return;
              e.preventDefault();
              e.stopPropagation();
              props.onDropTag(n.tag, props.axis, e.dataTransfer.getData("text/plain"));
            }}
          >
            {n.children.length > 0 ? (
              <button className="twisty" onClick={() => toggle(n.tag.id)} aria-label={collapsed.has(n.tag.id) ? "展開" : "收合"}>
                {collapsed.has(n.tag.id) ? "▸" : "▾"}
              </button>
            ) : (
              <span className="twisty" />
            )}
            <button
              className="label"
              onClick={() => props.onFilter({ tagId: n.tag.id })}
              title={
                [
                  n.tag.facet ? `維度：${n.tag.facet}` : "",
                  n.tag.definition ? `定義：${n.tag.definition}` : "",
                  n.tag.aliases?.length ? `別名：${n.tag.aliases.join("、")}` : "",
                ]
                  .filter(Boolean)
                  .join("\n") || undefined
              }
            >
              {!props.hideFacetBadge && n.tag.facet && <span className="facet-badge">{n.tag.facet}</span>}
              {n.tag.name}
              {props.getCardCount && (
                <span className="count" title="卡片數量">
                  {props.getCardCount(n)}
                </span>
              )}
            </button>
            <span className="actions">
              {nest && (
                <button onClick={() => props.onAdd(n.tag)} aria-label={`在 ${n.tag.name} 底下新增`} title="新增子項目">
                  <Icon name="plus" size={13} />
                </button>
              )}
              <button onClick={() => props.onEditMeta(n.tag)} aria-label={`設定 ${n.tag.name} 維度與別名`} title="設定維度、定義與別名">
                <Icon name="sliders" size={13} />
              </button>
              <button onClick={() => props.onMerge(n.tag)} aria-label={`合併 ${n.tag.name}`} title="合併至其他同軸標籤">
                <Icon name="merge" size={13} />
              </button>
              <button onClick={() => props.onRename(n.tag)} aria-label={`重新命名 ${n.tag.name}`} title="重新命名">
                <Icon name="pencil" size={13} />
              </button>
              {nest && (
                <button onClick={() => props.onMove(n.tag)} aria-label={`移動 ${n.tag.name}`} title="移動">
                  <Icon name="arrow-up-right" size={13} />
                </button>
              )}
              <button onClick={() => props.onDelete(n.tag)} aria-label={`刪除 ${n.tag.name}`} title="刪除">
                <Icon name="x" size={13} />
              </button>
            </span>
          </div>
          {n.children.length > 0 && !collapsed.has(n.tag.id) && <Tree {...props} nodes={n.children} />}
        </li>
      ))}
    </ul>
  );
}

function MoveDialog(props: { tag: Tag; tags: Tag[]; onCancel(): void; onMove(parentId: string | null): void }) {
  const banned = descendantIds(props.tags, props.tag.id);
  const options = props.tags.filter((t) => isSameAxisGroup(t.axis, props.tag.axis) && !banned.has(t.id));
  const [value, setValue] = useState<string>(props.tag.parent_id ?? "");
  return (
    <div className="modal" role="dialog" aria-label="移動標籤">
      <div className="modal-card">
        <h4>移動「{props.tag.name}」</h4>
        <select value={value} onChange={(e) => setValue(e.target.value)} aria-label="新的父節點">
          <option value="">（最上層）</option>
          {options.map((t) => (
            <option key={t.id} value={t.id}>
              {tagPath(props.tags, t.id)}
            </option>
          ))}
        </select>
        <div className="modal-actions">
          <button onClick={props.onCancel}>取消</button>
          <button className="primary" onClick={() => props.onMove(value || null)}>
            移動
          </button>
        </div>
      </div>
    </div>
  );
}

function TagMetaDialog(props: {
  tag: Tag;
  onClose(): void;
  onChanged(): void;
  report(e: unknown, prefix?: string): void;
}) {
  const { tag, onClose, onChanged, report } = props;
  const [facet, setFacet] = useState(tag.facet ?? "");
  const [definition, setDefinition] = useState(tag.definition ?? "");
  const [newAlias, setNewAlias] = useState("");
  const isConcept = isSameAxisGroup(tag.axis, "concept");

  const saveMeta = async () => {
    try {
      await api.patchTag(tag.id, {
        facet: isConcept ? facet.trim() || null : null,
        definition: definition.trim(),
      });
      onChanged();
      onClose();
    } catch (e) {
      report(e, "儲存標籤屬性失敗");
    }
  };

  const addAlias = async () => {
    const a = newAlias.trim();
    if (!a) return;
    try {
      await api.addTagAlias(tag.id, a);
      setNewAlias("");
      onChanged();
    } catch (e) {
      report(e, "新增別名失敗");
    }
  };

  const removeAlias = async (a: string) => {
    try {
      await api.removeTagAlias(tag.id, a);
      onChanged();
    } catch (e) {
      report(e, "刪除別名失敗");
    }
  };

  return (
    <div className="modal" role="dialog" aria-label="標籤定義與別名">
      <div className="modal-card" style={{ minWidth: 360 }}>
        <h4>標籤設定：「{tag.name}」</h4>
        {isConcept && <FacetPicker value={facet} onChange={setFacet} />}
        <label className="field-row">
          <span className="muted">簡短定義（協助區分一詞多義）：</span>
          <textarea
            rows={2}
            value={definition}
            onChange={(e) => setDefinition(e.target.value)}
            placeholder="定義這個概念的邊界與判斷標準"
          />
        </label>
        <div className="field-row">
          <span className="muted">同義詞／別名（輸入別名時會自動指向此標籤）：</span>
          <div className="chips">
            {(tag.aliases ?? []).length === 0 && <span className="muted">尚無別名</span>}
            {(tag.aliases ?? []).map((a) => (
              <span key={a} className="chip free">
                {a}
                <button onClick={() => void removeAlias(a)} aria-label={`移除別名 ${a}`}>
                  ✕
                </button>
              </span>
            ))}
          </div>
          <div className="tag-pick">
            <input
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void addAlias()}
              placeholder="輸入新別名後按加入"
            />
            <button onClick={() => void addAlias()}>＋別名</button>
          </div>
        </div>
        <div className="modal-actions">
          <button onClick={onClose}>關閉</button>
          <button className="primary" onClick={() => void saveMeta()}>
            儲存設定
          </button>
        </div>
      </div>
    </div>
  );
}

function MergeTagDialog(props: {
  source: Tag;
  tags: Tag[];
  onClose(): void;
  onMerged(): void;
  report(e: unknown, prefix?: string): void;
}) {
  const { source, tags, onClose, onMerged, report } = props;
  const banned = descendantIds(tags, source.id);
  const candidates = tags.filter((t) => isSameAxisGroup(t.axis, source.axis) && !banned.has(t.id));
  const [targetId, setTargetId] = useState(candidates[0]?.id ?? "");

  const confirmMerge = async () => {
    if (!targetId) return;
    const target = tags.find((t) => t.id === targetId);
    if (
      !window.confirm(
        `確定要將「${source.name}」合併至「${target?.name ?? ""}」嗎？\n` +
          `・所有套用「${source.name}」的卡片將自動改歸屬至「${target?.name ?? ""}」\n` +
          `・「${source.name}」及其別名將自動保留為「${target?.name ?? ""}」的別名`,
      )
    )
      return;
    try {
      await api.mergeTag(source.id, targetId);
      onMerged();
    } catch (e) {
      report(e, "合併標籤失敗");
    }
  };

  return (
    <div className="modal" role="dialog" aria-label="合併標籤">
      <div className="modal-card" style={{ minWidth: 340 }}>
        <h4>合併重複標籤：「{source.name}」</h4>
        <p className="muted" style={{ margin: 0 }}>
          將此標籤併入目標標籤後，原名稱「{source.name}」會自動轉為目標標籤的別名，既有卡片不需手動重貼。
        </p>
        {candidates.length === 0 ? (
          <p className="muted">目前沒有其他同軸標籤可供合併。</p>
        ) : (
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label="目標正式標籤">
            {candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.facet ? `[${t.facet}] ` : ""}
                {tagPath(tags, t.id)}
              </option>
            ))}
          </select>
        )}
        <div className="modal-actions">
          <button onClick={onClose}>取消</button>
          {candidates.length > 0 && (
            <button className="primary" onClick={() => void confirmMerge()}>
              確認合併
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function CleanupDialog(props: {
  result: CleanupResult;
  cleaning: boolean;
  onClose(): void;
  onConfirm(): void;
}) {
  const { result, cleaning, onClose, onConfirm } = props;
  return (
    <div className="modal" role="dialog" aria-label="清理孤兒媒體">
      <div className="modal-card">
        <h4>{result.dry_run ? "孤兒媒體清理預覽" : "孤兒媒體清理完成"}</h4>
        {result.orphans.length === 0 ? (
          <p className="muted">
            {result.dry_run
              ? "目前沒有需要清理的孤兒媒體（建立未滿 24 小時的檔案會自動略過）。"
              : "已無孤兒媒體。"}
          </p>
        ) : (
          <div>
            <p>
              {result.dry_run
                ? `找到 ${result.orphans.length} 個未被任何卡片內文引用（且建立超過 24 小時）的媒體檔案：`
                : `已刪除 ${result.orphans.length} 個孤兒媒體檔案：`}
            </p>
            <ul className="plain">
              {result.orphans.map((o) => (
                <li key={o.id} className="muted">
                  {o.rel_path}（{Math.max(1, Math.round(o.byte_size / 1024))} KB）
                </li>
              ))}
            </ul>
          </div>
        )}
        {result.stray_files.length > 0 && (
          <div>
            <p>磁碟上有檔案但資料庫無紀錄（僅列出，不自動刪除）：</p>
            <ul className="plain">
              {result.stray_files.map((f) => (
                <li key={f} className="muted">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={cleaning}>
            關閉
          </button>
          {result.dry_run && result.orphans.length > 0 && (
            <button className="primary" onClick={onConfirm} disabled={cleaning}>
              {cleaning ? "清理中…" : `確認刪除（${result.orphans.length}）`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
