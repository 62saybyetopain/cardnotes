// @depends-on ./components/Markdown.tsx (CardOpenProvider, notifyCardDeleted, notifyCardTitleUpdated)
// @depends-on ./components/RightPanel.tsx (Filter：loadSavedView 逐欄位白名單還原，Filter 新增欄位時要同步改，否則重整後該欄位會被丟掉)
// @depends-on ./lib/device.ts (initDeviceEnvironment)
// @depends-on ./components/IPadCardView.tsx (IPadCardView)
// @depends-on ./components/Board.tsx (toolsSlot：App 工具列提供的容器，Board 以 createPortal 把「定位／自動對齊」渲染進去；toolsOpen 只控制容器的展開動畫)
// @depends-on ./styles.css (.tools-dock / .tools-slide 及其內部 button 樣式)
// @depends-on ./components/DailyReview.tsx (DailyReview：只在 viewMode === "daily" 掛載；此視圖不渲染右側面板，grid 欄位與 right-closed 都改看 showRight)
// @depends-on ./styles.css (.board-toolbar.daily：日誌視圖隱藏「新增卡片」與「收合右側面板」)
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Board, type BoardHandle } from "./components/Board";
import { ConceptGraph } from "./components/ConceptGraph";
import { DailyReview } from "./components/DailyReview";
import { IPadCardView } from "./components/IPadCardView";
import { LeftPanel } from "./components/LeftPanel";
import { CardOpenProvider, notifyCardDeleted, notifyCardTitleUpdated } from "./components/Markdown";
import { CardEditorPane, RightPanel, type Filter, type TabKey } from "./components/RightPanel";
import { initDeviceEnvironment } from "./lib/device";
import { useNotify } from "./notify";
import type { BoardLink, BoardSummary, CardDetail, CardSummary, RelationType, Tag } from "./types";

const VIEW_KEY = "cardboard:view";
type ViewMode = "board" | "graph" | "cards" | "daily";

// 還原重新整理前的白板、視圖與篩選；欄位型別不符一律丟棄，退回預設
function loadSavedView(): { boardId: string | null; viewMode: ViewMode; filter: Filter } {
  const view = { boardId: null as string | null, viewMode: "board" as ViewMode, filter: {} as Filter };
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY) ?? "null");
    if (!v || typeof v !== "object") return view;
    if (typeof v.boardId === "string") view.boardId = v.boardId;
    if (v.viewMode === "board" || v.viewMode === "graph" || v.viewMode === "cards" || v.viewMode === "daily")
      view.viewMode = v.viewMode;
    const f = v.filter;
    if (f && typeof f === "object") {
      if (typeof f.tagId === "string") view.filter.tagId = f.tagId;
      if (f.unclassified === true) view.filter.unclassified = true;
      if (f.curationStatus === "inbox" || f.curationStatus === "curated") view.filter.curationStatus = f.curationStatus;
    }
  } catch {
    /* localStorage 不可用或資料損毀時忽略 */
  }
  return view;
}

export default function App() {
  const { report, info } = useNotify();
  const boardRef = useRef<BoardHandle>(null);
  const [isStandalone] = useState<boolean>(() => initDeviceEnvironment());
  const [tags, setTags] = useState<Tag[]>([]);
  const [unclassified, setUnclassified] = useState(0);
  const [inboxCount, setInboxCount] = useState(0);
  const [boards, setBoards] = useState<BoardSummary[]>([]);
  const [initialView] = useState(loadSavedView);
  const [boardId, setBoardId] = useState<string | null>(initialView.boardId);
  const [selected, setSelected] = useState<string | null>(null);
  const [previewCardId, setPreviewCardId] = useState<string | null>(null);
  const [centerEditing, setCenterEditing] = useState(false);
  const [pendingSmartPaste, setPendingSmartPaste] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(initialView.viewMode);
  const [filter, setFilter] = useState<Filter>(initialView.filter);
  const [tab, setTab] = useState<TabKey>("content");
  const [ipadCardList, setIpadCardList] = useState<CardSummary[]>([]);
  const [rightOpen, setRightOpen] = useState(true);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsSlot, setToolsSlot] = useState<HTMLDivElement | null>(null);
  const [rightWidth, setRightWidth] = useState<number>(() => {
    try {
      const saved = Number(localStorage.getItem("cardboard:right-width"));
      if (Number.isFinite(saved) && saved >= 300 && saved <= 1200) return saved;
    } catch {
      /* localStorage 不可用時忽略 */
    }
    return 420;
  });
  const [leftOpen, setLeftOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem("cardboard:left-open");
      if (saved !== null) return saved === "true";
    } catch {
      /* localStorage 不可用時忽略 */
    }
    return true;
  });
  const [version, setVersion] = useState(0);
  const [booted, setBooted] = useState(false);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify({ boardId, viewMode, filter }));
    } catch {
      /* localStorage 無法寫入時忽略 */
    }
  }, [boardId, viewMode, filter]);

  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      const saved = localStorage.getItem("cardboard:theme");
      if (saved === "light" || saved === "dark") return saved;
    } catch {
      /* localStorage 不可用時忽略 */
    }
    return "dark";
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem("cardboard:theme", theme);
    } catch {
      /* 忽略寫入失敗 */
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const toggleLeft = useCallback(() => {
    setLeftOpen((cur) => {
      const next = !cur;
      try {
        localStorage.setItem("cardboard:left-open", String(next));
      } catch {
        /* 忽略寫入失敗 */
      }
      return next;
    });
  }, []);

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
      // 還原的篩選指向已不存在的標籤時清掉，否則會停在一份對不上的清單
      setFilter((f) => (f.tagId && !r.tags.some((t) => t.id === f.tagId) ? {} : f));
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
      // 有篩選條件（抽屜／概念標籤／未歸檔／收件夾）時查全部卡片，否則才顯示目前白板的成員
      const hasFilter = !!(filter.tagId || filter.unclassified || filter.curationStatus);
      // boardId 來自閉包：覆蓋匯入／雲端拉取後舊白板已不存在，先對照目前清單；
      // 失效時退回查全部卡片（refreshBoards 會校正 boardId 並重新觸發本函式）
      const boardAlive =
        !!boardId && !hasFilter && (await api.listBoards()).boards.some((b) => b.id === boardId);
      if (boardId && boardAlive) {
        const b = await api.getBoard(boardId);
        const cardSummaries: CardSummary[] = b.cards.map((c) => ({
          id: c.card_id,
          title: c.title,
          snippet: c.body,
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

  // ---- 電腦版：定時自動備份至本機固定檔案（含開機錯時補償 Catch-up）----
  useEffect(() => {
    if (!booted || isStandalone) return;

    // 原因：失敗不會更新上次備份時間，此檢查每 60 秒重試一次；不加旗標同一個錯誤會每分鐘跳一次。
    let failureReported = false;
    const runBackupCheck = async () => {
      try {
        const rawCfg = localStorage.getItem("cardboard:auto-backup-config");
        if (!rawCfg) return;
        const cfg = JSON.parse(rawCfg);
        if (!cfg.enabled || !cfg.targetPath?.trim()) return;

        const lastIso = localStorage.getItem("cardboard:last-auto-backup-time");
        const now = new Date();
        let needBackup = false;

        if (cfg.scheduleType === "daily") {
          const [targetHour, targetMin] = (cfg.dailyTime || "22:00").split(":").map(Number);
          const scheduledToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), targetHour, targetMin, 0);

          if (!lastIso) {
            // 從未備份過且已過今日指定時間：立即備份
            if (now >= scheduledToday) needBackup = true;
          } else {
            const lastDate = new Date(lastIso);
            const isDifferentDay =
              lastDate.getFullYear() !== now.getFullYear() ||
              lastDate.getMonth() !== now.getMonth() ||
              lastDate.getDate() !== now.getDate();

            // 錯時補償：若跨日且今天已過排程時間，或者上次備份已是前天（昨日未開機錯過備份）：立即執行
            if (isDifferentDay && now >= scheduledToday) {
              needBackup = true;
            } else if (now.getTime() - lastDate.getTime() > 24 * 3600 * 1000) {
              needBackup = true;
            }
          }
        } else if (cfg.scheduleType === "interval") {
          const intervalMs = Math.max(0.1, Number(cfg.intervalHours) || 4) * 3600 * 1000;
          if (!lastIso) {
            needBackup = true;
          } else {
            const lastDate = new Date(lastIso);
            if (now.getTime() - lastDate.getTime() >= intervalMs) {
              needBackup = true;
            }
          }
        }

        if (needBackup) {
          const res = await api.syncSaveToFile(cfg.targetPath.trim());
          localStorage.setItem("cardboard:last-auto-backup-time", res.exported_at);
          failureReported = false;
        }
      } catch (e) {
        // 原因：原本整個吞掉，路徑被後端拒絕（422）或磁碟錯誤時使用者會以為有備份；改為大聲報錯，每次失敗期間只報一次。
        if (!failureReported) {
          failureReported = true;
          report(e, "自動備份失敗");
        }
        /* 靜默守護背景備份，不中斷前端使用 */
      }
    };

    // 1. 開機立即檢查一次（執行錯時補償）
    void runBackupCheck();
    // 2. 每 60 秒定期輪詢一次時間
    const timer = setInterval(() => void runBackupCheck(), 60000);
    return () => clearInterval(timer);
  }, [booted, isStandalone, report]);

  const selectCard = useCallback(
    (id: string | null) => {
      setSelected(id);
      if (id) {
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

  const openCardInCenter = useCallback((id: string, options?: { smartPasteText?: string }) => {
    setSelected(id);
    setPendingSmartPaste(options?.smartPasteText ?? null);
    setCenterEditing(true);
    setTab("content");
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
      if (isStandalone) {
        // 網頁／iPad 版：新增後直接進中央編輯
        openCardInCenter(card.id);
      } else {
        setRightOpen(true);
        setTab(centerEditing ? "relations" : "content");
        setSelected(card.id);
      }
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
    void refreshIpadCards();
    if (selected) {
      void api.cardTitle(selected).catch(() => {
        setSelected(null);
        setCenterEditing(false);
      });
    }
    if (previewCardId) {
      void api.cardTitle(previewCardId).catch(() => setPreviewCardId(null));
    }
    bump(); // 標籤組織或同步覆蓋完成：重新取得卡片與畫布狀態
  }, [refreshTags, refreshIpadCards, selected, previewCardId, bump]);

  if (!booted) return <div className="boot">載入中…</div>;

  // 日誌視圖整頁接管中央與右欄；standalone 沒有日誌視圖，不隱藏右側面板
  const showRight = rightOpen && !(viewMode === "daily" && !isStandalone);

  return (
    <CardOpenProvider onOpenCard={openCardPreview}>
      <div
        className={`app${leftOpen ? "" : " left-closed"}${showRight ? "" : " right-closed"}`}
        style={{
          gridTemplateColumns: `${leftOpen ? "260px" : "0px"} 1fr${showRight ? ` ${rightWidth}px` : ""}`,
        }}
      >
        <LeftPanel
          boards={boards}
          boardId={boardId}
          tags={tags}
          unclassifiedCount={unclassified}
          inboxCount={inboxCount}
          filter={filter}
          isSearchTab={showRight && tab === "search"}
          theme={theme}
          onToggleTheme={toggleTheme}
          onToggleCollapse={toggleLeft}
          onSelectBoard={(id) => {
            setBoardId(id);
            setViewMode("board");
            setCenterEditing(false);
            setFilter({});
          }}
          onBoardsChanged={refreshBoards}
          onFilter={(f) => {
            setFilter(f);
            setViewMode("cards");
            setCenterEditing(false);
          }}
          onTagsChanged={onTagsChanged}
          report={report}
        />
        <main className="center">
          {!leftOpen && (
            <div className="left-collapsed-bar" role="toolbar" aria-label="左側面板控制">
              <button
                type="button"
                className="icon-btn"
                onClick={toggleLeft}
                aria-label="展開左側面板"
                title="展開左側面板"
              >
                ▶
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={toggleTheme}
                aria-label={theme === "dark" ? "切換至淺色模式" : "切換至深色模式"}
                title={theme === "dark" ? "切換至淺色模式" : "切換至深色模式"}
              >
                {theme === "dark" ? "☀️" : "🌙"}
              </button>
            </div>
          )}

          {!isStandalone && viewMode !== "cards" && (
            <div className={`board-toolbar${viewMode === "daily" ? " daily" : ""}`}>
              {!centerEditing && (
                <div className="view-switch" role="group" aria-label="視圖模式切換">
                  <button
                    className={viewMode === "board" ? "on" : ""}
                    onClick={() => {
                      setViewMode("board");
                      setFilter({});
                    }}
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
                  <button
                    onClick={() => setViewMode("cards")}
                    title="卡片冊模式（列表瀏覽、批次歸檔與收件夾整理）"
                  >
                    卡片冊
                  </button>
                  <button
                    className={viewMode === "daily" ? "on" : ""}
                    onClick={() => setViewMode("daily")}
                    title="今日總結（先盲寫，再對照今天動過的卡片）"
                  >
                    今日總結
                  </button>
                </div>
              )}
              {!centerEditing && viewMode === "board" && boardId && (
                <div className="tools-dock">
                  <button
                    type="button"
                    className={`icon-btn${toolsOpen ? " on" : ""}`}
                    onClick={() => setToolsOpen((v) => !v)}
                    aria-label="畫布工具"
                    aria-expanded={toolsOpen}
                    title="畫布工具（定位、自動對齊）"
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                    </svg>
                  </button>
                  <div ref={setToolsSlot} className={`tools-slide${toolsOpen ? " open" : ""}`} />
                </div>
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
          )}

          {!isStandalone && viewMode !== "cards" ? (
            <>
              <Board
                ref={boardRef}
                boardId={boardId}
                selectedCardId={selected}
                active={!centerEditing && viewMode === "board"}
                toolsSlot={toolsSlot}
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
              {viewMode === "daily" && (
                <DailyReview
                  version={version}
                  centerEditing={centerEditing}
                  onOpenCard={openCardInCenter}
                  report={report}
                  info={info}
                />
              )}
            </>
          ) : (
            <IPadCardView
              cards={ipadCardList}
              selectedCardId={selected}
              boardId={boardId}
              boards={boards}
              filtered={!!(filter.tagId || filter.unclassified || filter.curationStatus)}
              tags={tags}
              rightOpen={rightOpen}
              onToggleRight={() => setRightOpen((o) => !o)}
              onBackToBoard={() => {
                setViewMode("board");
                setFilter({});
              }}
              onSelectCard={selectCard}
              onOpenCard={openCardInCenter}
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
              <div
                className="center-editor-head"
                style={isStandalone || viewMode === "cards" ? { paddingRight: 16 } : undefined}
              >
                <button onClick={closeCenterEditor} title="返回（Esc）">
                  ← 返回{isStandalone ? "卡片冊" : viewMode === "graph" ? "概念圖譜" : viewMode === "daily" ? "今日總結" : "白板"}
                </button>
                <span className="muted">
                  卡片編輯模式（按 Esc 返回{isStandalone ? "卡片冊" : viewMode === "daily" ? "今日總結" : "白板"}）
                </span>
                {(isStandalone || viewMode === "cards") && (
                  <button
                    type="button"
                    className="toggle-right"
                    style={{ marginLeft: "auto", padding: "0 10px" }}
                    onClick={() => setRightOpen((o) => !o)}
                    aria-label={rightOpen ? "收合右側面板" : "展開右側面板"}
                    title={rightOpen ? "收合右側面板" : "展開右側面板"}
                  >
                    {rightOpen ? "▶" : "◀"}
                  </button>
                )}
              </div>
              <div className="center-editor-body">
                <CardEditorPane
                  cardId={selected}
                  tags={tags}
                  version={version}
                  initialSmartPaste={pendingSmartPaste}
                  onClearInitialSmartPaste={() => setPendingSmartPaste(null)}
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
      {showRight && (
          <RightPanel
            selectedCardId={selected}
            previewCardId={previewCardId}
            boardId={boardId}
            centerEditing={centerEditing}
            tags={tags}
            filter={filter}
            version={version}
            tab={tab}
            hideContentTab={false}
            onResizeStart={startResize}
            onTab={setTab}
            onClearFilter={() => setFilter({})}
            onSelectCard={openCardInCenter}
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

