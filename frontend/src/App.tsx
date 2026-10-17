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
      const r = await api.listCards({
        tag_id: filter.tagId,
        unclassified: filter.unclassified,
        curation_status: filter.curationStatus,
        limit: 200,
      });
      setIpadCardList(r.items);
    } catch (e) {
      report(e, "載入卡片清單失敗");
    }
  }, [filter, report]);

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

  // 點擊 @ 引用超連結時：在右方欄【搜尋】頁面下半部開啟該卡片預覽，不洗掉目前正在編輯的卡片
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
      const card = await api.createCard(filter.tagId ? [filter.tagId] : []); // 在某抽屜被選取時新增，自動歸檔
      setRightOpen(true);
      setTab(centerEditing ? "relations" : "content");
      setSelected(card.id);
      if (boardId) await boardRef.current?.addCard(card.id);
      void refreshTags();
      void refreshBoards();
      bump();
    } catch (e) {
      report(e, "新增卡片失敗");
    }
  };

  const addToBoard = async (id: string) => {
    await boardRef.current?.addCard(id);
    void refreshBoards();
  };

  const onSaved = useCallback(
    (c: CardDetail) => {
      notifyCardTitleUpdated(c.id, c.title);
      boardRef.current?.updateCard({ id: c.id, title: c.title, body: c.body });
      void refreshTags();
    },
    [refreshTags],
  );

  const onCardDeleted = useCallback(
    (id: string) => {
      notifyCardDeleted(id);
      boardRef.current?.removeCard(id);
      setSelected(null);
      setCenterEditing(false);
      void refreshTags();
      void refreshBoards();
      bump();
    },
    [refreshBoards, refreshTags, bump],
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
