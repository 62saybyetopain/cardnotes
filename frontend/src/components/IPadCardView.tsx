// @depends-on ../types.ts (BoardSummary, CardSummary, SyncPackage, Tag)
// @depends-on ./Markdown.tsx (Markdown)
// @depends-on ../App.tsx (onSelectCard 負責單擊切換選取與右側面板內容，onOpenCard 負責進入中央編輯模式)
import { useCallback, useRef, useState } from "react";
import { api } from "../api";
import { storage } from "../lib/storage";
import { isSameAxisGroup, tagPath } from "../lib/tree";
import type { BoardSummary, CardSummary, SyncPackage, Tag } from "../types";
import { Markdown } from "./Markdown";

const DEFAULT_CARD_HEIGHT = 136;
const DEFAULT_EXPANDED_HEIGHT = 280;
const HEIGHT_STORAGE_KEY = "cardboard:ipad-card-heights";

interface Props {
  cards: CardSummary[];
  selectedCardId: string | null;
  boardId: string | null;
  boards: BoardSummary[];
  filtered?: boolean;
  tags: Tag[];
  onBackToBoard?(): void;
  onSelectCard(id: string): void;
  onOpenCard?(id: string): void;
  onCreateCard(): void;
  onRefresh(): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

// 回傳 false 代表使用者取消，iPad 資料完全沒有變動
async function overwriteLocal(pkg: SyncPackage): Promise<boolean> {
  if (typeof storage.importPackageOverwrite !== "function" || typeof storage.findLocalOnlyCards !== "function") {
    throw new Error(
      "目前儲存驅動不是 IndexedDB（dexie），無法覆蓋匯入。請以 ?storage=dexie 開啟，或確認 iPad 已切換為本機儲存。",
    );
  }
  // 覆蓋會刪除所有「iPad 有、備份沒有」的卡片：先列出來讓使用者決定
  const localOnly = await storage.findLocalOnlyCards(pkg);
  if (localOnly.length > 0) {
    const shown = localOnly
      .slice(0, 5)
      .map((c) => "・" + (c.title || "（無標題）"))
      .join("\n");
    const rest = localOnly.length > 5 ? "\n…另有 " + String(localOnly.length - 5) + " 張" : "";
    const proceed = window.confirm(
      "此 iPad 上有 " +
        String(localOnly.length) +
        " 張卡片不在要覆蓋的備份中：\n" +
        shown +
        rest +
        "\n\n繼續覆蓋會永久刪除它們。\n按「確定」繼續覆蓋，按「取消」中止（iPad 資料不會變動）。",
    );
    if (!proceed) return false;
  }
  await storage.importPackageOverwrite(pkg);
  return true;
}

export function IPadCardView({
  cards,
  selectedCardId,
  boardId,
  boards,
  filtered = false,
  tags,
  onBackToBoard,
  onSelectCard,
  onOpenCard,
  onCreateCard,
  onRefresh,
  report,
  info,
}: Props) {
  const activeBoard = filtered ? undefined : boards.find((b) => b.id === boardId);
  const gridRef = useRef<HTMLDivElement>(null);

  // 批次選取狀態與批次操作目標
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchBoardId, setBatchBoardId] = useState<string>(() => boardId || boards[0]?.id || "");
  const [batchTagId, setBatchTagId] = useState<string>("");
  const [batchOperating, setBatchOperating] = useState(false);

  const locationTags = tags.filter((t) => isSameAxisGroup(t.axis, "location"));

  const toggleSelectCardId = useCallback((id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(cards.map((c) => c.id)));
  }, [cards]);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  // 批次加入白板
  const handleBatchAddToBoard = async () => {
    if (!batchBoardId) {
      report(new Error("請先選擇目標白板"));
      return;
    }
    if (selectedIds.size === 0) return;
    setBatchOperating(true);
    try {
      const ids = Array.from(selectedIds);
      let idx = 0;
      for (const cardId of ids) {
        const offX = 100 + (idx % 6) * 30;
        const offY = 100 + Math.floor(idx / 6) * 30;
        await api.addToBoard(batchBoardId, cardId, offX, offY);
        idx++;
      }
      const bName = boards.find((b) => b.id === batchBoardId)?.name || "白板";
      info(`已成功將 ${ids.length} 張卡片加入白板「${bName}」`);
      clearSelection();
      onRefresh();
    } catch (e) {
      report(e, "批次加入白板失敗");
    } finally {
      setBatchOperating(false);
    }
  };

  // 批次歸入收納抽屜／櫃子
  const handleBatchAssignDrawer = async () => {
    if (!batchTagId) {
      report(new Error("請先選擇目標抽屜／櫃子"));
      return;
    }
    if (selectedIds.size === 0) return;
    setBatchOperating(true);
    try {
      const ids = Array.from(selectedIds);
      for (const cardId of ids) {
        await api.assignTag(cardId, batchTagId);
      }
      const tName = tagPath(tags, batchTagId);
      info(`已成功將 ${ids.length} 張卡片歸入抽屜「${tName}」`);
      clearSelection();
      onRefresh();
    } catch (e) {
      report(e, "批次歸入抽屜失敗");
    } finally {
      setBatchOperating(false);
    }
  };

  // 批次標記為已整理（移出收件夾）
  const handleBatchMarkCurated = async () => {
    if (selectedIds.size === 0) return;
    setBatchOperating(true);
    try {
      const ids = Array.from(selectedIds);
      for (const cardId of ids) {
        const c = await api.getCard(cardId);
        await api.patchCard(cardId, { curation_status: "curated" }, c.updated_at);
      }
      info(`已成功將 ${ids.length} 張卡片標記為已整理！`);
      clearSelection();
      onRefresh();
    } catch (e) {
      report(e, "批次整理失敗");
    } finally {
      setBatchOperating(false);
    }
  };

  // 記錄展開狀態與每張卡片的自訂高度
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  const [heightMap, setHeightMap] = useState<Record<string, number>>(() => {
    try {
      const raw = localStorage.getItem(HEIGHT_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      /* 忽略快取損毀 */
    }
    return {};
  });

  const resizingRef = useRef<{
    cardId: string;
    startY: number;
    startH: number;
    startScrollTop: number;
    lastY: number;
  } | null>(null);

  const saveHeights = useCallback((map: Record<string, number>) => {
    setHeightMap(map);
    try {
      localStorage.setItem(HEIGHT_STORAGE_KEY, JSON.stringify(map));
    } catch {
      /* 忽略儲存失敗 */
    }
  }, []);

  const toggleExpand = useCallback((e: React.MouseEvent, cardId: string) => {
    e.stopPropagation();
    setExpandedCards((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) {
        next.delete(cardId);
      } else {
        next.add(cardId);
      }
      return next;
    });
  }, []);

  // 拖曳底部拉條調節長度（支援滑鼠與觸控螢幕；固定卡片上緣，僅在拉到畫面底部繼續往下拉時才捲動容器）
  const startResize = useCallback(
    (e: React.MouseEvent | React.TouchEvent, cardId: string, currentH: number) => {
      if (e.cancelable) e.preventDefault();
      e.stopPropagation();
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      const gridEl = gridRef.current;
      resizingRef.current = {
        cardId,
        startY: clientY,
        startH: currentH,
        startScrollTop: gridEl ? gridEl.scrollTop : 0,
        lastY: clientY,
      };
      setExpandedCards((prev) => new Set(prev).add(cardId));
      setHeightMap((prev) => (prev[cardId] === currentH ? prev : { ...prev, [cardId]: currentH }));

      const onMove = (ev: MouseEvent | TouchEvent) => {
        if (!resizingRef.current) return;
        if (ev.cancelable) ev.preventDefault();
        const curY = "touches" in ev ? ev.touches[0].clientY : ev.clientY;
        const grid = gridRef.current;
        if (grid) {
          const rect = grid.getBoundingClientRect();
          const bottomEdge = rect.bottom - 16;
          if (curY >= bottomEdge && curY > resizingRef.current.lastY) {
            // 拉到畫面底部且繼續往下拉時，允許容器同步向下捲動
            grid.scrollTop += curY - Math.max(resizingRef.current.lastY, bottomEdge);
          }
        }
        resizingRef.current.lastY = curY;
        const scrollDelta = grid ? grid.scrollTop - resizingRef.current.startScrollTop : 0;
        const delta = curY - resizingRef.current.startY + scrollDelta;
        const nextH = Math.max(DEFAULT_CARD_HEIGHT, Math.round(resizingRef.current.startH + delta));
        const targetId = resizingRef.current.cardId;
        setHeightMap((prev) => (prev[targetId] === nextH ? prev : { ...prev, [targetId]: nextH }));
      };

      const onEnd = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onEnd);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onEnd);
        window.removeEventListener("touchcancel", onEnd);
        if (resizingRef.current) {
          setHeightMap((prev) => {
            saveHeights(prev);
            return prev;
          });
          resizingRef.current = null;
        }
      };

      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onEnd);
      window.addEventListener("touchmove", onMove, { passive: false });
      window.addEventListener("touchend", onEnd);
      window.addEventListener("touchcancel", onEnd);
    },
    [saveHeights],
  );

  // 一鍵填入初始示範資料（讓首次打開 GitHub Pages 的 iPad 立即有標籤與抽屜可測）
  const loadSampleData = async () => {
    try {
      const now = new Date().toISOString();
      const demoPkg: SyncPackage = {
        version: 1,
        exported_at: now,
        source_device: "ipad_sample",
        cards: [
          {
            id: "sample-c1",
            title: "肩胛骨動作障礙評估",
            body: "# 肩胛骨動作障礙\n觀察肩胛骨在上舉過程中的翼狀或代償，評估菱形肌與前鋸肌的力偶平衡。",
            card_type: "concept",
            curation_status: "curated",
            created_at: now,
            updated_at: now,
            tags: [],
            links: [],
            boards: [],
            warnings: [],
          },
          {
            id: "sample-c2",
            title: "胸椎活動度矯正運動",
            body: "胸椎後伸活動度不足時，肩關節容易產生夾擠現象。\n相關動作參考：[肩胛骨動作障礙評估](card:sample-c1)",
            card_type: "method",
            curation_status: "curated",
            created_at: now,
            updated_at: now,
            tags: [],
            links: [],
            boards: [],
            warnings: [],
          },
        ],
        tags: [
          {
            id: "sample-t1",
            name: "肩膀與上肢",
            axis: "location",
            facet: null,
            definition: "上肢關節與肩胛力學收納抽屜",
            parent_id: null,
            aliases: ["上肢"],
          },
          {
            id: "sample-t2",
            name: "動作評估",
            axis: "concept",
            facet: "方法／工具",
            definition: "功能性動態評估手段",
            parent_id: null,
            aliases: [],
          },
        ],
        card_tags: [
          { card_id: "sample-c1", tag_id: "sample-t1" },
          { card_id: "sample-c1", tag_id: "sample-t2" },
          { card_id: "sample-c2", tag_id: "sample-t1" },
        ],
        links: [
          {
            source_id: "sample-c2",
            target_id: "sample-c1",
            relation_type: "support",
            status: "confirmed",
            reason: "改善胸椎活動度可支持肩胛力學穩定",
          },
        ],
        boards: [{ id: "sample-b1", name: "肩膀臨床評估專題" }],
        board_cards: [
          { board_id: "sample-b1", card_id: "sample-c1", x: 100, y: 100 },
          { board_id: "sample-b1", card_id: "sample-c2", x: 420, y: 100 },
        ],
      };

      if (!(await overwriteLocal(demoPkg))) {
        info("已取消載入示範資料，iPad 上的資料沒有任何變動。");
        return;
      }
      info("已成功載入示範資料！已建立收納抽屜、概念標籤與關聯卡片。");
      onRefresh();
    } catch (e) {
      report(e, "載入示範資料失敗");
    }
  };

  return (
    <div className="ipad-view">
      <div className="ipad-toolbar" style={{ flexWrap: "wrap", gap: 8 }}>
        <div className="ipad-toolbar-left" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {onBackToBoard && (
            <button
              type="button"
              className="touch-btn"
              onClick={onBackToBoard}
              title="切換回白板畫布"
              style={{ fontSize: 12, padding: "3px 10px" }}
            >
              ← 返回白板
            </button>
          )}
          <span className="ipad-badge">卡片冊</span>
          {activeBoard ? (
            <span style={{ fontWeight: 600, color: "var(--accent)" }}>
              白板：{activeBoard.name}（{cards.length}）
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>{filtered ? "篩選結果" : "全部卡片"}（{cards.length}）</span>
          )}
          {cards.length > 0 && (
            <button
              type="button"
              className="touch-btn"
              style={{ fontSize: 12, padding: "2px 8px" }}
              onClick={selectedIds.size === cards.length ? clearSelection : selectAll}
            >
              {selectedIds.size === cards.length ? "取消全選" : "全選本頁"}
            </button>
          )}
        </div>
        <div className="ipad-toolbar-actions">
          <button type="button" className="touch-btn primary" onClick={onCreateCard}>
            ＋ {activeBoard ? `在「${activeBoard.name.slice(0, 6)}」新增` : "新增卡片"}
          </button>
        </div>
      </div>

      {/* 批次操作控制列（勾選至少 1 張時顯示） */}
      {selectedIds.size > 0 && (
        <div
          className="batch-actions-bar"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 14px",
            background: "var(--panel, #1e293b)",
            borderBottom: "2px solid var(--accent, #60a5fa)",
            flexWrap: "wrap",
            fontSize: 13,
            zIndex: 10,
          }}
        >
          <strong style={{ color: "var(--accent, #60a5fa)" }}>已選取 {selectedIds.size} 張</strong>

          {/* 歸入特定白板 */}
          {boards.length > 0 && (
            <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <select
                value={batchBoardId}
                onChange={(e) => setBatchBoardId(e.target.value)}
                style={{ padding: "3px 6px", fontSize: 12 }}
                disabled={batchOperating}
                aria-label="選擇目標白板"
              >
                {boards.map((b) => (
                  <option key={b.id} value={b.id}>
                    白板：{b.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="touch-btn"
                style={{ padding: "3px 8px", fontSize: 12 }}
                onClick={() => void handleBatchAddToBoard()}
                disabled={batchOperating}
              >
                加到白板
              </button>
            </div>
          )}

          {/* 歸入特定抽屜/櫃子 */}
          {locationTags.length > 0 && (
            <div style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
              <select
                value={batchTagId}
                onChange={(e) => setBatchTagId(e.target.value)}
                style={{ padding: "3px 6px", fontSize: 12 }}
                disabled={batchOperating}
                aria-label="選擇目標抽屜"
              >
                <option value="">選擇抽屜／櫃子…</option>
                {locationTags.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    📁 {tagPath(tags, loc.id)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="touch-btn"
                style={{ padding: "3px 8px", fontSize: 12 }}
                onClick={() => void handleBatchAssignDrawer()}
                disabled={batchOperating || !batchTagId}
              >
                歸入抽屜
              </button>
            </div>
          )}

          {/* 批次標記已整理 */}
          <button
            type="button"
            className="touch-btn primary"
            style={{ padding: "3px 10px", fontSize: 12 }}
            onClick={() => void handleBatchMarkCurated()}
            disabled={batchOperating}
            title="將選中卡片標記為「已整理」，正式納入知識庫並移出待整理收件夾"
          >
            ✓ 標記為已整理
          </button>

          <button
            type="button"
            className="touch-btn"
            style={{ padding: "3px 8px", fontSize: 12, marginLeft: "auto" }}
            onClick={clearSelection}
            disabled={batchOperating}
          >
            取消選取
          </button>
        </div>
      )}

      <div className="ipad-card-grid" ref={gridRef}>
        {cards.length === 0 && (
          <div className="empty" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px 0" }}>
            <p>目前尚無卡片。</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 12 }}>
              <button type="button" className="touch-btn primary" onClick={onCreateCard}>
                ＋ 立即新增第一張卡片
              </button>
              <button type="button" className="touch-btn" onClick={() => void loadSampleData()}>
                載入示範卡片與抽屜標籤
              </button>
            </div>
          </div>
        )}
        {cards.map((c) => {
          const isSelected = c.id === selectedCardId;
          const isExpanded = expandedCards.has(c.id);
          const rememberedH = heightMap[c.id] ?? DEFAULT_EXPANDED_HEIGHT;
          const currentHeight = isExpanded ? Math.max(DEFAULT_CARD_HEIGHT, rememberedH) : DEFAULT_CARD_HEIGHT;
          const cardTags = (c.tags ?? []).map((t) => t.name);
          const bodyContent = (c as { body?: string }).body || c.snippet || "";

          return (
            <div
              key={c.id}
              className={`ipad-card-item${isSelected ? " active" : ""}${isExpanded ? " expanded" : ""}`}
              style={{ height: currentHeight }}
              onClick={() => {
                if ((window.getSelection()?.toString() ?? "").length > 0) return;
                onSelectCard(c.id);
              }}
              onDoubleClick={() => onOpenCard?.(c.id)}
              role="region"
              aria-label={c.title || "卡片"}
            >
              <div className="ipad-card-item-head">
                <label
                  style={{ display: "inline-flex", alignItems: "center", cursor: "pointer", marginRight: 6 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id)}
                    onChange={(e) => toggleSelectCardId(c.id, e as unknown as React.MouseEvent)}
                    aria-label={`選取卡片 ${c.title || "未命名"}`}
                    style={{ width: 16, height: 16, cursor: "pointer" }}
                  />
                </label>
                <div className="ipad-card-item-title">{c.title || "（無標題卡片）"}</div>
                <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
                  {onOpenCard && (
                    <button
                      type="button"
                      className="ipad-card-expand-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenCard(c.id);
                      }}
                      title="進入中央編輯模式"
                      aria-label="進入中央編輯模式"
                    >
                      ✎ 編輯
                    </button>
                  )}
                  <button
                    type="button"
                    className="ipad-card-expand-btn"
                    onClick={(e) => toggleExpand(e, c.id)}
                    title={isExpanded ? "收合卡片（還原固定長度）" : "展開卡片（內部滾動與自訂長度）"}
                    aria-label={isExpanded ? "收合卡片" : "展開卡片"}
                  >
                    {isExpanded ? "⤡ 收合" : "⤢ 展開"}
                  </button>
                </div>
              </div>

              <div
                className="ipad-card-item-body"
                title="點選切換卡片，雙擊進入中央編輯，亦可直接反白複製內文"
              >
                {bodyContent.trim() ? (
                  <Markdown source={bodyContent} onOpenCard={onSelectCard} />
                ) : (
                  <span className="muted">（空白內文）</span>
                )}
              </div>

              <div className="ipad-card-item-footer">
                <span className="ipad-card-time">{new Date(c.updated_at).toLocaleDateString()}</span>
                {cardTags.length > 0 && (
                  <div className="ipad-card-tags">
                    {cardTags.slice(0, 2).map((tn, idx) => (
                      <span key={idx} className="facet-badge">{tn}</span>
                    ))}
                    {cardTags.length > 2 && <span className="muted">+{cardTags.length - 2}</span>}
                  </div>
                )}
              </div>

              {/* 底部拖曳拉條：可拖曳調節卡片長度，最小高度限制為 200px */}
              <div
                className="ipad-card-resizer"
                onMouseDown={(e) => startResize(e, c.id, currentHeight)}
                onTouchStart={(e) => startResize(e, c.id, currentHeight)}
                title="按住拖曳可調整此卡片長度（自動記憶）"
                aria-label="調整卡片長度"
              >
                <span className="ipad-card-resizer-handle" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}