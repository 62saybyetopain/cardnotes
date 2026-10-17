// @depends-on ./components/Markdown.tsx (CardOpenProvider, notifyCardDeleted, notifyCardTitleUpdated)
// @depends-on ./lib/device.ts (initDeviceEnvironment)
// @depends-on ./components/IPadCardView.tsx (IPadCardView)
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Board, type BoardHandle } from "./components/Board";
import { ConceptGraph } from "./components/ConceptGraph";
import { IPadCardView } from "./components/IPadCardView";
import { LeftPanel } from "./components/LeftPanel";
import { CardOpenProvider, notifyCardDeleted, notifyCardTitleUpdated } from "./components/Markdown";
import { CardEditorPane, RightPanel, type Filter, type TabKey } from "./components/RightPanel";
import { initDeviceEnvironment } from "./lib/device";
import { useNotify } from "./notify";
import type { BoardLink, BoardSummary, CardDetail, CardSummary, RelationType, Tag } from "./types";

export default function App() {
  const { report, info } = useNotify();
  const boardRef = useRef<BoardHandle>(null);
  const [isStandalone] = useState<boolean>(() => initDeviceEnvironment());
  const [tags, setTags] = useState<Tag[]>([]);
  const [unclassified, setUnclassified] = useState(0);
  const [inboxCount, setInboxCount] = useState(0);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [boardId, setBoardId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewCardId, setPreviewCardId] = useState<string | null>(null);
  const [centerEditing, setCenterEditing] = useState(false);
  const [viewMode, setViewMode] = useState<"board" | "graph">("board");
  const [filter, setFilter] = useState<Filter>({});
  const [tab, setTab] = useState<TabKey>("content");
  const [ipadCardList, setIpadCardList] = useState<CardSummary[]>([]);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightWidth, setRightWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("cardboard:right-width"));
      if (Number.isFinite(saved) && saved >= 300 && saved <= 1200) return saved;
    } catch {
      /* localStorage 不可用時忽略 */
    }
    return 420;
  });
  const [version, setVersion] = useState(0);
  const [booted, setBooted] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const maxW = Math.max(320, window.innerWidth - 320);
      const next = Math.min(maxW, Math.max(300, window.innerWidth - ev.clientX));
      setRightWidth(next);
      try {
        localStorage.setItem("cardboard:right-width", String(Math.round(next)));
      } catch {
        /* localStorage 無法寫入時忽略 */
      }
    };
    const onUp = () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  const refreshTags = useCallback(async () => {
    try {
      const r = await api.listTags();
      setTags(r.tags);
      setUnclassified(r.unclassified_count);
      setInboxCount(r.inbox_count ?? 0);
    } catch (e) {
      report(e, "載入標籤失敗");
    }
  }, [report]);

  const refreshBoards = useCallback(async () => {
    try {
      const r = await api.listBoards();
      setBoards(r.boards);
      setBoardId((cur) => (cur && r.boards.some((b) => b.id === cur) ? cur : r.boards[0]?.id ?? null));
    } catch (e) {
      report(e, "載入白板清單失敗");
    }
  }, [report]);

  const refreshIpadCards = useCallback(async () => {
    try {
      if (boardId) {
        const b = await api.getBoard(boardId);
        const cardSummaries: CardSummary[] = b.cards.map((c) => ({
          id: c.card_id,
          title: c.title,
          snippet: c.body.slice(0, 160),
          updated_at: c.updated_at,
        }));
        setIpadCardList(cardSummaries);
      } else {
        const r = await api.listCards({
          tag_id: filter.tagId,
          unclassified: filter.unclassified,
          curation_status: filter.curationStatus,
          limit: 200,
        });
        setIpadCardList(r.items);
      }
    } catch (e) {
      report(e, "載入卡片清單失敗");
    }
  }, [boardId, filter, report]);

  useEffect(() => {
    void Promise.all([refreshTags(), refreshBoards(), refreshIpadCards()]).finally(() => setBooted(true));
  }, [refreshTags, refreshBoards, refreshIpadCards]);

  const selectCard = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (id) {
        setRightOpen(true);
        if (!centerEditing) {
          setTab((t) => (t === "search" ? "content" : t));
        }
      }
    },
    [centerEditing],
  );

  const openCardPreview = useCallback((id: string) => {
    setPreviewCardId(id);
    setRightOpen(true);
    setTab("search");
  }, []);

  const openCardInCenter = useCallback((id: string) => {
    setSelected(id);
    setCenterEditing(true);
    setRightOpen(true);
    setTab((t) => (t === "content" ? "relations" : t));
  }, []);

  const closeCenterEditor = useCallback(() => {
    setCenterEditing(false);
  }, []);

  useEffect(() => {
    if (!centerEditing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCenterEditor();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [centerEditing, closeCenterEditor]);

  const createCard = async () => {
    try {
      const card = await api.createCard(filter.tagId ? [filter.tagId] : []);
      setRightOpen(true);
      setTab(centerEditing ? "relations" : "content");
      setSelected(card.id);
      if (boardId) {
        if (boardRef.current) {
          await boardRef.current.addCard(card.id);
        } else {
          // 純前端／iPad 模式無畫布時，直接寫入白板關聯
          await api.addToBoard(boardId, card.id, 100, 100);
        }
      }
      void refreshTags();
      void refreshBoards();
      void refreshIpadCards();
      bump();
    } catch (e) {
      report(e, "新增卡片失敗");
    }
  };

  const addToBoard = async (id: string) => {
    if (boardRef.current) {
      await boardRef.current.addCard(id);
    } else if (boardId) {
      await api.addToBoard(boardId, id, 100, 100);
    }
    void refreshBoards();
    void refreshIpadCards();
  };

  const onSaved = useCallback(
    (c: CardDetail) => {
      notifyCardTitleUpdated(c.id, c.title);
      boardRef.current?.updateCard({ id: c.id, title: c.title, body: c.body });
      setIpadCardList((prev) =>
        prev.map((item) =>
          item.id === c.id
            ? { ...item, title: c.title, snippet: c.body.slice(0, 160), updated_at: c.updated_at }
            : item,
        ),
      );
      void refreshTags();
    },
    [refreshTags],
  );

  // 刪除卡片：立即從 ipadCardList 與畫布中移除，不需重新整理立即生效
  const onCardDeleted = useCallback(
    (id: string) => {
      notifyCardDeleted(id);
      boardRef.current?.removeCard(id);
      setIpadCardList((prev) => prev.filter((item) => item.id !== id));
      setSelected(null);
      setCenterEditing(false);
      void refreshTags();
      void refreshBoards();
      void refreshIpadCards();
      bump();
    },
    [refreshBoards, refreshIpadCards, refreshTags, bump],
  );

  const onLinkDeleted = useCallback(
    (sourceId: string, targetId: string, relationType?: RelationType) => {
      boardRef.current?.removeLink(sourceId, targetId, relationType);
      bump();
    },
    [bump],
  );

  const onLinkAdded = useCallback(
    (sourceId: string, targetId: string, extra?: Partial<BoardLink>) => {
      boardRef.current?.addLink(sourceId, targetId, extra);
      bump();
    },
    [bump],
  );

  const onTagsChanged = useCallback(() => {
    void refreshTags();
    bump(); // 標籤組織改變：目前抽屜的卡片組織可能更新，重新取得
  }, [refreshTags, bump]);

  if (!booted) return <div className="boot">載入中…</div>;

  return (
    <CardOpenProvider onOpenCard={openCardPreview}>
      <div
        className={`app${rightOpen ? "" : " right-closed"}`}
        style={rightOpen ? { gridTemplateColumns: `260px 1fr ${rightWidth}px` } : undefined}
      >
        <LeftPanel
          boards={boards}
          boardId={boardId}
          tags={tags}
          unclassifiedCount={unclassified}
          inboxCount={inboxCount}
          filter={filter}
          isSearchTab={rightOpen && tab === "search"}
          onSelectBoard={(id) => {
            setBoardId(id);
            setViewMode("board");
            setCenterEditing(false);
          }}
          onBoardsChanged={refreshBoards}
          onFilter={(f) => (setFilter(f), setRightOpen(true), setTab("search"))}
          onTagsChanged={onTagsChanged}
          report={report}
        />
        <main className="center">
          {!isStandalone ? (
            <>
              <div className="board-toolbar">
                {!centerEditing && (
                  <div className="view-switch" role="group" aria-label="視圖模式切換">
                    <button
                      className={viewMode === "board" ? "on" : ""}
                      onClick={() => setViewMode("board")}
                      title="白板畫布（手動排列卡片與專題推理）"
                    >
                      白板畫布
                    </button>
                    <button
                      className={viewMode === "graph" ? "on" : ""}
                      onClick={() => setViewMode("graph")}
                      title="全域概念圖譜（以概念標籤為節點，探索共現群落）"
                    >
                      概念圖譜
                    </button>
                  </div>
                )}
                {centerEditing && selected && (
                  <button onClick={closeCenterEditor} aria-label="返回白板" title="返回（Esc）">
                    ← 返回{viewMode === "graph" ? "概念圖譜" : "白板"}
                  </button>
                )}
                {!centerEditing && viewMode === "board" && (
                  <button
                    className="icon-btn"
                    onClick={() => void boardRef.current?.createGroup()}
                    aria-label="新增視覺分組框"
                    title="新增視覺分組框（若已選取多張卡片，會自動將它們框入同一群組）"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeDasharray="2.5 2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <rect x="2" y="2.5" width="12" height="11" rx="2" />
                    </svg>
                  </button>
                )}
                <button
                  className="icon-btn primary"
                  onClick={() => void createCard()}
                  aria-label="新增卡片"
                  title="新增卡片"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <rect x="2.5" y="2" width="11" height="12" rx="2" />
                    <line x1="8" y1="5.5" x2="8" y2="10.5" />
                    <line x1="5.5" y1="8" x2="10.5" y2="8" />
                  </svg>
                </button>
                <button
                  className="toggle-right"
                  onClick={() => setRightOpen((o) => !o)}
                  aria-label={rightOpen ? "收合右側面板" : "展開右側面板"}
                  title={rightOpen ? "收合右側面板" : "展開右側面板"}
                >
                  {rightOpen ? "▶" : "◀"}
                </button>
              </div>
              <Board
                ref={boardRef}
                boardId={boardId}
                selectedCardId={selected}
                active={!centerEditing && viewMode === "board"}
                onSelectCard={selectCard}
                onOpenCard={openCardInCenter}
                onLinksChanged={bump}
                onCountChanged={refreshBoards}
                report={report}
                info={info}
              />
              {!centerEditing && viewMode === "graph" && (
                <ConceptGraph
                  selectedTagId={filter.tagId}
                  version={version}
                  onSelectTag={(tagId) => {
                    setFilter({ tagId });
                    setRightOpen(true);
                    setTab("search");
                  }}
                  report={report}
                />
              )}
            </>
          ) : (
            <IPadCardView
              cards={ipadCardList}
              selectedCardId={selected}
              boardId={boardId}
              boards={boards}
              tags={tags}
              onSelectCard={selectCard}
              onCreateCard={() => void createCard()}
              onRefresh={() => {
                void refreshTags();
                void refreshBoards();
                void refreshIpadCards();
              }}
              report={report}
              info={info}
            />
          )}

          {centerEditing && selected && (
            <div className="center-editor" role="region" aria-label="中央卡片編輯視窗">
              <div className="center-editor-head">
                <button onClick={closeCenterEditor}>← 返回白板</button>
                <span className="muted">卡片編輯模式（按 Esc 返回白板）</span>
              </div>
              <div className="center-editor-body">
                <CardEditorPane
                  cardId={selected}
                  tags={tags}
                  version={version}
                  onSaved={onSaved}
                  onCardDeleted={onCardDeleted}
                  onLinkAdded={onLinkAdded}
                  onSelectCard={openCardPreview}
                  onTagsChanged={onTagsChanged}
                  report={report}
                  info={info}
                />
              </div>
            </div>
          )}
        </main>
      {rightOpen && (
        <RightPanel
          selectedCardId={selected}
          previewCardId={previewCardId}
          tags={tags}
          filter={filter}
          version={version}
          tab={tab}
          hideContentTab={centerEditing && !!selected}
          onResizeStart={startResize}
          onTab={setTab}
          onClearFilter={() => setFilter({})}
          onSelectCard={selectCard}
          onPreviewCard={setPreviewCardId}
          onCreateCard={() => void createCard()}
            onAddToBoard={(id) => void addToBoard(id)}
            onSaved={onSaved}
            onCardDeleted={onCardDeleted}
            onLinkAdded={onLinkAdded}
            onLinkDeleted={onLinkDeleted}
            onTagsChanged={onTagsChanged}
            onOpenBoard={(id) => {
              setBoardId(id);
              setViewMode("board");
              setCenterEditing(false);
            }}
            report={report}
            info={info}
          />
        )}
      </div>
    </CardOpenProvider>
  );
}
