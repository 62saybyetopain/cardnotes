import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import type { BoardSummary } from "../types";
import { MindMap } from "./MindMap";

interface Props {
  boards: BoardSummary[];
  rightOpen?: boolean;
  onToggleRight?(): void;
  onSelectCard?(cardId: string): void;
  onJumpBoardToCards(boardId: string): void;
  onBoardsChanged(): void | Promise<void>;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

interface MindMapOverviewItem {
  boardId: string;
  title: string;
  nodeCount: number;
}

export function MindMapOverview({
  boards,
  rightOpen,
  onToggleRight,
  onSelectCard,
  onJumpBoardToCards,
  onBoardsChanged,
  report,
  info,
}: Props) {
  const [items, setItems] = useState<MindMapOverviewItem[]>([]);
  const [emptyBoards, setEmptyBoards] = useState<BoardSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [activeBoardId, setActiveBoardId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const loadOverview = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listBoards();
      const activeBoards = res.boards.filter((b) => !b.question?.archived_at);
      const settled = await Promise.allSettled(activeBoards.map((b) => api.getMindMap(b.id)));
      const withNodes: MindMapOverviewItem[] = [];
      const withoutNodes: BoardSummary[] = [];

      settled.forEach((r, idx) => {
        const b = activeBoards[idx];
        if (r.status === "fulfilled") {
          const mm = r.value;
          if (mm.nodes.length > 0) {
            withNodes.push({
              boardId: b.id,
              title: mm.display_title,
              nodeCount: mm.nodes.length,
            });
          } else {
            withoutNodes.push(b);
          }
        } else {
          withoutNodes.push(b);
        }
      });

      setItems(withNodes);
      setEmptyBoards(withoutNodes);
    } catch (e) {
      report(e, "載入心智圖總覽失敗");
    } finally {
      setLoading(false);
    }
  }, [report]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, boards]);

  const handleCreateNewBoardMindMap = async () => {
    const name = window.prompt("新白板名稱（將直接開啟心智圖畫布）");
    if (!name?.trim()) return;
    try {
      const created = await api.createBoard(name.trim());
      await onBoardsChanged();
      setPickerOpen(false);
      setActiveBoardId(created.id);
    } catch (e) {
      report(e, "建立白板失敗");
    }
  };

  if (activeBoardId) {
    return (
      <div className="ipad-view">
        <div className="ipad-toolbar">
          <div className="ipad-toolbar-left">
            <button
              type="button"
              className="touch-btn"
              onClick={() => {
                setActiveBoardId(null);
                void loadOverview();
              }}
            >
              ← 返回心智圖總覽
            </button>
            <span className="ipad-badge">心智圖</span>
          </div>
          <div className="ipad-toolbar-actions">
            {onToggleRight && (
              <button
                type="button"
                className="touch-btn"
                onClick={onToggleRight}
                aria-label={rightOpen ? "收合右側面板" : "展開右側面板"}
                title={rightOpen ? "收合右側面板" : "展開右側面板"}
              >
                {rightOpen ? "▶" : "◀"}
              </button>
            )}
          </div>
        </div>
        <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
          <MindMap
            boardId={activeBoardId}
            isIpad={true}
            onJumpBoard={onJumpBoardToCards}
            onMutated={async () => {
              await onBoardsChanged();
            }}
            onSelectCard={onSelectCard}
            report={report}
            info={info}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="ipad-view">
      <div className="ipad-toolbar">
        <div className="ipad-toolbar-left">
          <span className="ipad-badge">心智圖</span>
          <span className="muted" style={{ fontSize: 13 }}>
            已有心智圖（{items.length}）
          </span>
        </div>
        <div className="ipad-toolbar-actions">
          <button
            type="button"
            className="touch-btn primary"
            onClick={() => setPickerOpen(true)}
          >
            ＋ 從白板建立心智圖
          </button>
          {onToggleRight && (
            <button
              type="button"
              className="touch-btn"
              onClick={onToggleRight}
              aria-label={rightOpen ? "收合右側面板" : "展開右側面板"}
              title={rightOpen ? "收合右側面板" : "展開右側面板"}
            >
              {rightOpen ? "▶" : "◀"}
            </button>
          )}
        </div>
      </div>

      <div
        className="ipad-card-grid mindmap-overview-grid"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" && selectedBoardId) {
            e.preventDefault();
            setActiveBoardId(selectedBoardId);
          }
        }}
      >
        {loading && <div className="empty" style={{ gridColumn: "1 / -1" }}>載入心智圖清單中…</div>}
        {!loading && items.length === 0 && (
          <div className="empty" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px 0" }}>
            <p>目前尚無已建立節點的心智圖。</p>
            <button
              type="button"
              className="touch-btn primary"
              style={{ marginTop: 10 }}
              onClick={() => setPickerOpen(true)}
            >
              ＋ 從白板建立心智圖
            </button>
          </div>
        )}
        {!loading &&
          items.map((item) => {
            const isSelected = selectedBoardId === item.boardId;
            return (
              <div
                key={item.boardId}
                className={`mindmap-overview-card${isSelected ? " active" : ""}`}
                onClick={() => setSelectedBoardId(item.boardId)}
                onDoubleClick={() => setActiveBoardId(item.boardId)}
                role="button"
                tabIndex={0}
                title="單擊選取，雙擊進入心智圖畫布"
              >
                <div className="mindmap-overview-title">{item.title}</div>
                <div className="mindmap-overview-meta">
                  <span className="facet-badge">{item.nodeCount} 個節點</span>
                </div>
              </div>
            );
          })}
      </div>

      {pickerOpen && (
        <div className="modal" role="dialog" aria-label="從白板建立心智圖">
          <div className="modal-card" style={{ width: 420, maxWidth: "92vw" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h4 style={{ margin: 0 }}>選擇尚無心智圖的白板</h4>
              <button type="button" onClick={() => setPickerOpen(false)} aria-label="關閉">
                ✕
              </button>
            </div>
            <div style={{ maxHeight: 260, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
              {emptyBoards.length === 0 ? (
                <div className="muted" style={{ padding: "8px 0", fontSize: 13 }}>
                  目前所有白板都已有心智圖，你可以直接建立新白板開啟心智圖。
                </div>
              ) : (
                emptyBoards.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className="result-main"
                    style={{ padding: "8px 10px" }}
                    onClick={() => {
                      setPickerOpen(false);
                      setActiveBoardId(b.id);
                    }}
                  >
                    <strong>{b.name}</strong>
                    <span className="snippet">白板內 {b.card_count} 張卡片</span>
                  </button>
                ))
              )}
            </div>
            <div className="modal-actions" style={{ justifyContent: "space-between", marginTop: 8 }}>
              <button type="button" onClick={() => void handleCreateNewBoardMindMap()}>
                ＋ 新建白板並開啟
              </button>
              <button type="button" onClick={() => setPickerOpen(false)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
