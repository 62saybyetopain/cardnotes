// @depends-on ../types.ts (BoardSummary, CardSummary, SyncPackage, Tag)
// @depends-on ./Markdown.tsx (Markdown)
import { useCallback, useRef, useState } from "react";
import { storage } from "../lib/storage";
import type { BoardSummary, CardSummary, SyncPackage, Tag } from "../types";
import { Markdown } from "./Markdown";

const DEFAULT_CARD_HEIGHT = 200;
const DEFAULT_EXPANDED_HEIGHT = 380;
const HEIGHT_STORAGE_KEY = "cardboard:ipad-card-heights";

interface Props {
  cards: CardSummary[];
  selectedCardId: string | null;
  boardId: string | null;
  boards: BoardSummary[];
  filtered?: boolean;
  tags: Tag[];
  onSelectCard(id: string): void;
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
  tags: _tags,
  onSelectCard,
  onCreateCard,
  onRefresh,
  report,
  info,
}: Props) {
  const activeBoard = filtered ? undefined : boards.find((b) => b.id === boardId);

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

  const resizingRef = useRef<{ cardId: string; startY: number; startH: number } | null>(null);

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

  // 拖曳底部拉條調節長度（支援滑鼠與觸控螢幕）
  const startResize = useCallback(
    (e: React.MouseEvent | React.TouchEvent, cardId: string, currentH: number) => {
      e.preventDefault();
      e.stopPropagation();
      const clientY = "touches" in e ? e.touches[0].clientY : e.clientY;
      resizingRef.current = { cardId, startY: clientY, startH: currentH };
      setExpandedCards((prev) => new Set(prev).add(cardId));

      const onMove = (ev: MouseEvent | TouchEvent) => {
        if (!resizingRef.current) return;
        const curY = "touches" in ev ? ev.touches[0].clientY : ev.clientY;
        const delta = curY - resizingRef.current.startY;
        const nextH = Math.max(DEFAULT_CARD_HEIGHT, Math.round(resizingRef.current.startH + delta));
        setHeightMap((prev) => ({ ...prev, [resizingRef.current!.cardId]: nextH }));
      };

      const onEnd = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onEnd);
        window.removeEventListener("touchmove", onMove);
        window.removeEventListener("touchend", onEnd);
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
      <div className="ipad-toolbar">
        <div className="ipad-toolbar-left">
          <span className="ipad-badge">iPad 卡片冊</span>
          {activeBoard ? (
            <span style={{ fontWeight: 600, color: "var(--accent)" }}>
              白板：{activeBoard.name}（{cards.length}）
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>{filtered ? "篩選結果" : "全部卡片"}（{cards.length}）</span>
          )}
        </div>
        <div className="ipad-toolbar-actions">
          <button type="button" className="touch-btn primary" onClick={onCreateCard}>
            ＋ {activeBoard ? `在「${activeBoard.name.slice(0, 6)}」新增` : "新增卡片"}
          </button>
        </div>
      </div>

      <div className="ipad-card-grid">
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
              onClick={() => onSelectCard(c.id)}
              role="region"
              aria-label={c.title || "卡片"}
            >
              <div className="ipad-card-item-head">
                <div className="ipad-card-item-title">{c.title || "（無標題卡片）"}</div>
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

              <div
                className="ipad-card-item-body"
                onClick={(e) => e.stopPropagation()}
                title="滾動查看完整渲染內文"
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