// @depends-on ../api.ts (listDailyStreams／listDailyStreamsRange／createDailyStream／patchDailyStream／unlockDailyStream／finishDailyStream／reopenDailyStream／peekDailyStream／convertDailyStream／deleteDailyStream／bindDailyCard／unbindDailyCard／listDailyChanges)
// @depends-on 後端 daily.py 的狀態機：這裡按鈕的可用條件只是提示，真正的不變量（盲寫凍結、轉換後唯讀）在伺服器
// @depends-on ../App.tsx (只在 viewMode === "daily" 時掛載；onOpenCard 是 openCardInCenter；centerEditing 轉 false 時要重抓異動清單)
// @depends-on ./Markdown.tsx (Markdown：source、onOpenCard)
// @depends-on ../styles.css (.daily-*／.stream-*／.change-*／.journal-*／.archive-*)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api";
import { messageOf } from "../notify";
import {
  CARD_TYPE_LABELS,
  type DailyChange,
  type DailyStatus,
  type DailyStream,
  type DailyStreamKind,
} from "../types";
import { Markdown } from "./Markdown";

const pad = (n: number) => String(n).padStart(2, "0");
const fmtDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDay = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d); // 本地午夜
};
const shiftDay = (s: string, delta: number) => {
  const d = parseDay(s);
  d.setDate(d.getDate() + delta);
  return fmtDay(d);
};
const todayStr = () => fmtDay(new Date());
const fmtTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
type DailyViewMode = "card" | "journal" | "archive";
// 本地日界線換成 UTC 區間 [from, to)；後端會再正規化並拒絕沒帶時區的值
const dayBounds = (s: string) => {
  const a = parseDay(s);
  const b = parseDay(s);
  b.setDate(b.getDate() + 1);
  return { from: a.toISOString(), to: b.toISOString() };
};
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

// 原因：◀▶ 與 emoji 是字元，風格與 App.tsx 的描邊 SVG 工具列不一致。改成同規格圖示（24 格、描邊 2、currentColor），深淺主題才會跟著文字色。
// head3 已刪：標題提示改顯示完整標題，不再需要截斷。
const ICON = {
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
  plus: "M12 5v14M5 12h14",
  trash: "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v5M14 11v5",
  lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4",
  unlock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2",
  bulb: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z",
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.3-4.3",
  link: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
  check: "M20 6L9 17l-5-5",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z",
  calendar: "M3 6h18v15H3zM8 3v4M16 3v4M3 10h18",
} as const;
const Ico = ({ d, size = 14 }: { d: string; size?: number }) => (
  <svg
    className="ui-icon"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path
      d={d}
    />
  </svg>
);
const ui = { Ico, Markdown, StreamItem, JournalItem };
const SKEL_W = ["78%", "62%", "88%", "54%", "72%", "66%", "84%", "58%"];

const STAGE_LABEL: Record<DailyStatus, string> = {
  recalling: "階段 1・盲寫",
  comparing: "階段 2・對照",
  done: "已完成",
};

type SaveStatus = "saved" | "dirty" | "saving" | "error" | "conflict";
const SAVE_TEXT: Record<SaveStatus, string> = {
  saved: "已儲存",
  dirty: "未儲存",
  saving: "儲存中…",
  error: "儲存失敗",
  conflict: "版本衝突",
};

interface Props {
  version: number;
  centerEditing: boolean;
  onOpenCard(id: string): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

export function DailyReview({ version, centerEditing, onOpenCard, report, info }: Props) {
  const [mode, setMode] = useState<DailyViewMode>("card");
  const [day, setDay] = useState(todayStr);
  const [streams, setStreams] = useState<DailyStream[] | null>(null);
  const [streamsErr, setStreamsErr] = useState("");
  const [changes, setChanges] = useState<{ day: string; items: DailyChange[]; truncated: boolean } | null>(null);
  const [changesErr, setChangesErr] = useState("");
  const [reloadNonce, setReloadNonce] = useState(0);
  const [changesTick, setChangesTick] = useState(0);
  const [newId, setNewId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeJournalId, setActiveJournalId] = useState<string | null>(null);
  const [peekOn, setPeekOn] = useState(false);
  const [binding, setBinding] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [quickTitle, setQuickTitle] = useState("");
  const [quickText, setQuickText] = useState("");
  const [quickTitleOpen, setQuickTitleOpen] = useState(false);
  const [creatingJournal, setCreatingJournal] = useState(false);
  const quickInputRef = useRef<HTMLTextAreaElement>(null);

  const [archiveKind, setArchiveKind] = useState<"all" | DailyStreamKind>("all");
  const [archiveQuery, setArchiveQuery] = useState("");
  const [archiveFrom, setArchiveFrom] = useState(() => shiftDay(todayStr(), -30));
  const [archiveTo, setArchiveTo] = useState(todayStr);
  const [archiveItems, setArchiveItems] = useState<DailyStream[] | null>(null);
  const [archiveTruncated, setArchiveTruncated] = useState(false);
  const [archiveErr, setArchiveErr] = useState("");
  const [selectedArchiveId, setSelectedArchiveId] = useState<string | null>(null);

  const streamSeq = useRef(0);
  useEffect(() => {
    const my = ++streamSeq.current;
    setStreams(null);
    setStreamsErr("");
    api
      .listDailyStreams(day)
      .then((r) => {
        if (my === streamSeq.current) setStreams(r.items);
      })
      .catch((e) => {
        if (my === streamSeq.current) setStreamsErr(messageOf(e));
      });
  }, [day, reloadNonce]);

  const changesSeq = useRef(0);
  useEffect(() => {
    if (mode === "archive") return;
    const my = ++changesSeq.current;
    setChangesErr("");
    const { from, to } = dayBounds(day);
    api
      .listDailyChanges(from, to)
      .then((r) => {
        if (my === changesSeq.current) setChanges({ day, items: r.items, truncated: r.truncated });
      })
      .catch((e) => {
        if (my !== changesSeq.current) return;
        setChanges(null);
        setChangesErr(messageOf(e));
      });
  }, [day, version, changesTick, centerEditing, mode]);

  const archiveRangeInvalid = Boolean(archiveFrom && archiveTo && archiveFrom > archiveTo);
  const archiveSeq = useRef(0);
  useEffect(() => {
    if (mode !== "archive") return;
    if (archiveRangeInvalid) {
      setArchiveItems([]);
      setArchiveTruncated(false);
      setArchiveErr("");
      return;
    }
    const my = ++archiveSeq.current;
    setArchiveErr("");
    const timer = setTimeout(() => {
      api
        .listDailyStreamsRange({
          from_day: archiveFrom || undefined,
          to_day: archiveTo || undefined,
          kind: archiveKind === "all" ? undefined : archiveKind,
          q: archiveQuery.trim() || undefined,
        })
        .then((r) => {
          if (my !== archiveSeq.current) return;
          setArchiveItems(r.items);
          setArchiveTruncated(r.truncated);
          setSelectedArchiveId((prev) =>
            prev && r.items.some((x) => x.id === prev) ? prev : (r.items[0]?.id ?? null),
          );
        })
        .catch((e) => {
          if (my !== archiveSeq.current) return;
          setArchiveItems(null);
          setArchiveErr(messageOf(e));
        });
    }, 180);
    return () => clearTimeout(timer);
  }, [mode, archiveKind, archiveQuery, archiveFrom, archiveTo, archiveRangeInvalid, reloadNonce, centerEditing]);

  const cardStreams = useMemo(
    () => (streams ?? []).filter((s) => s.kind === "card"),
    [streams],
  );
  const journalStreams = useMemo(
    () => (streams ?? []).filter((s) => s.kind === "journal"),
    [streams],
  );

  // 尚未載入完成也視為鎖定（失敗時寧可不顯示標題，也不猜）
  const locked = streams === null || cardStreams.some((s) => s.status === "recalling");
  useEffect(() => {
    if (!locked) setPeekOn(false);
  }, [locked]);

  const covered = useMemo(
    () => new Set(cardStreams.flatMap((s) => s.cards.map((c) => c.id))),
    [cardStreams],
  );
  const comparing = cardStreams.filter((s) => s.status === "comparing");
  const target = comparing.find((s) => s.id === activeId) ?? comparing[0] ?? null;
  const journalTarget = journalStreams.find((s) => s.id === activeJournalId) ?? journalStreams[0] ?? null;

  // 這些回應裡 cards 以誰為準：綁定／解除綁定／載入以伺服器回應為準；文字儲存與狀態轉換的回應保留現有 cards，
  // 避免較早送出、較晚回來的回應把剛綁好的卡片蓋掉
  const applyStream = useCallback((u: DailyStream, opts?: { cards?: boolean; refreshChanges?: boolean }) => {
    setStreams((cur) => cur && cur.map((s) => (s.id === u.id ? { ...u, cards: opts?.cards ? u.cards : s.cards } : s)));
    setArchiveItems(
      (cur) => cur && cur.map((s) => (s.id === u.id ? { ...u, cards: opts?.cards ? u.cards : s.cards } : s)),
    );
    if (opts?.refreshChanges) setChangesTick((n) => n + 1);
  }, []);

  const createStream = async () => {
    try {
      const s = await api.createDailyStream(day, { kind: "card" });
      setStreams((cur) => [...(cur ?? []), s]);
      setNewId(s.id);
    } catch (e) {
      report(e, "新增主題串失敗");
    }
  };

  const submitQuickJournal = async () => {
    const text = quickText.trim();
    const title = quickTitle.trim();
    if ((!text && !title) || creatingJournal || streams === null) return;
    setCreatingJournal(true);
    try {
      const s = await api.createDailyStream(day, {
        kind: "journal",
        title,
        review_text: quickText,
      });
      setStreams((cur) => [...(cur ?? []), s]);
      setActiveJournalId(s.id);
      setQuickText("");
      setQuickTitle("");
      setQuickTitleOpen(false);
      quickInputRef.current?.focus();
    } catch (e) {
      report(e, "新增靈感失敗");
    } finally {
      setCreatingJournal(false);
    }
  };

  const bindOp = async (streamId: string, cardId: string, bound: boolean) => {
    setBinding(true);
    try {
      const u = bound ? await api.unbindDailyCard(streamId, cardId) : await api.bindDailyCard(streamId, cardId);
      applyStream(u, { cards: true });
    } catch (e) {
      report(e, bound ? "解除綁定失敗" : "綁定失敗");
    } finally {
      setBinding(false);
    }
  };

  // 先記錄「用過提示」再顯示；記錄失敗就不顯示，盲寫的純度才可信
  const togglePeek = async () => {
    if (peekOn) {
      setPeekOn(false);
      return;
    }
    const rec = cardStreams.filter((s) => s.status === "recalling");
    const res = await Promise.allSettled(rec.map((s) => api.peekDailyStream(s.id)));
    let ok = true;
    res.forEach((r) => {
      if (r.status === "fulfilled") applyStream(r.value);
      else {
        ok = false;
        report(r.reason, "記錄提示失敗，未顯示提示");
      }
    });
    if (ok) setPeekOn(true);
  };

  const toggleExpand = (id: string) =>
    setExpanded((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const jumpToDayMode = (targetDay: string, targetKind: DailyStreamKind, streamId: string) => {
    setDay(targetDay);
    setMode(targetKind);
    if (targetKind === "card") setActiveId(streamId);
    else setActiveJournalId(streamId);
  };

  const today = todayStr();
  const ch = changes && changes.day === day ? changes : null;
  const newCount = ch ? ch.items.filter((c) => c.kind === "new").length : 0;
  const updatedCount = ch ? ch.items.length - newCount : 0;

  const groupedArchive = useMemo(() => {
    if (!archiveItems) return [];
    const map = new Map<string, DailyStream[]>();
    for (const item of archiveItems) {
      const list = map.get(item.day) ?? [];
      list.push(item);
      map.set(item.day, list);
    }
    return Array.from(map.entries());
  }, [archiveItems]);

  const selectedArchiveItem = useMemo(
    () => (archiveItems ?? []).find((x) => x.id === selectedArchiveId) ?? archiveItems?.[0] ?? null,
    [archiveItems, selectedArchiveId],
  );

  const renderSideBody = (
    sideLocked: boolean,
    sideTarget: DailyStream | null,
    targetLabel: string,
    emptyHint: string,
    useCoveredDim: boolean,
  ) => {
    if (streamsErr)
      return <div className="banner danger">無法確認主題串狀態，清單先不顯示：{streamsErr}</div>;
    if (streams === null) return <div className="empty">載入中…</div>;
    if (changesErr)
      return (
        <div
          className="banner danger"
          role="alert"
        >
          載入異動卡片失敗：{changesErr}
          <button
            type="button"
            onClick={() => setChangesTick((n) => n + 1)}
          >
            重試
          </button>
        </div>
      );
    if (!ch) return <div className="empty">載入中…</div>;
    if (ch.items.length === 0) return <div className="empty">這一天沒有新增或更新的卡片</div>;
    const summary = (
      <div className="daily-summary">
        今日共新增 {newCount} 張、更新 {updatedCount} 張卡片
      </div>
    );
    // 原因：等寬灰條被 blur 後像「載入中」，不像遮罩。改畫長得像清單的假卡片（寬度不一、底部漸隱），再疊一塊磨砂提示；真實標題仍不進 DOM，所以 peeked_at 的紀錄才可信。
    if (sideLocked && !peekOn) {
      return (
        <>
          {summary}
          <div className="change-veil">
            <ul
              className="change-list"
              aria-hidden="true"
            >
              {Array.from({ length: Math.min(ch.items.length, 8) }, (_, i) => (
                <li
                  key={i}
                  className="change-skel"
                >
                  <span className="skel-pill" />
                  <span
                    className="skel-bar"
                    style={{ width: SKEL_W[i % SKEL_W.length] }}
                  />
                </li>
              ))}
            </ul>
            <div className="change-veil-msg">
              <ui.Ico
                d={ICON.lock}
                size={18}
              />
              先寫下你記得的
              <span className="muted">對照時才會顯示卡片</span>
            </div>
          </div>
        </>
      );
    }
    // 提示改顯示完整標題（內文仍隱藏）；型態徽章只在有指定型態時顯示，避免整排「未指定型態」。
    if (sideLocked) {
      return (
        <>
          {summary}
          <ul className="change-list">
            {ch.items.map((c) => (
              <li
                key={c.id}
                className="change-item hint"
              >
                <div className="change-row">
                  {(c.card_type ?? "untyped") !== "untyped" && (
                    <span className="facet-badge">{CARD_TYPE_LABELS[c.card_type]}</span>
                  )}
                  <span className="change-title">{c.title.trim() || "（無標題）"}</span>
                </div>
              </li>
            ))}
          </ul>
        </>
      );
    }
    return (
      <>
        {summary}
        {ch.truncated && <div className="banner warn">只顯示最近更新的 500 張</div>}
        <ul className="change-list">
          {ch.items.map((c) => {
            const open = expanded.has(c.id);
            const isCovered = useCoveredDim && covered.has(c.id);
            const boundToTarget = !!sideTarget && sideTarget.cards.some((x) => x.id === c.id);
            return (
              <li
                key={c.id}
                className={`change-item${isCovered ? " covered" : ""}`}
              >
                <div className="change-row">
                  <button
                    type="button"
                    className="change-toggle"
                    aria-expanded={open}
                    aria-label={open ? "收合內容" : "展開內容"}
                    onClick={() => toggleExpand(c.id)}
                  >
                    <ui.Ico
                      d={ICON.right}
                    />
                  </button>
                  <span
                    className={`facet-badge kind-${c.kind}`}
                  >
                    {c.kind === "new" ? "新增" : "更新"}
                  </span>
                  <strong className="change-title">{c.title || "（無標題）"}</strong>
                  {isCovered && (
                    <span
                      className="change-check"
                      title="已被今日某個主題串綁定"
                    >
                      <ui.Ico
                        d={ICON.check}
                      />
                    </span>
                  )}
                  <span className="change-actions">
                    <button
                      type="button"
                      disabled={!sideTarget || binding}
                      title={sideTarget ? `綁定到「${sideTarget.title || targetLabel}」` : emptyHint}
                      onClick={() => sideTarget && void bindOp(sideTarget.id, c.id, boundToTarget)}
                    >
                      {boundToTarget ? (
                        <>
                          <ui.Ico
                            d={ICON.check}
                            size={12}
                          />{" "}
                          已綁定
                        </>
                      ) : (
                        <>
                          <ui.Ico
                            d={ICON.link}
                            size={12}
                          />{" "}
                          綁定
                        </>
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => onOpenCard(c.id)}
                    >
                      編輯
                    </button>
                  </span>
                </div>
                {open && (
                  <div className="change-body">
                    <ui.Markdown
                      source={c.body}
                      onOpenCard={onOpenCard}
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </>
    );
  };

  const renderJournalModeSide = () => {
    if (streams === null) return <div className="empty">載入中…</div>;
    return (
      <>
        <div className="side-section">
          <div className="side-section-title">當日卡片總結脈絡（{cardStreams.length}）</div>
          {cardStreams.length === 0 ? (
            <p className="muted daily-note">這一天尚未建立卡片總結主題串。</p>
          ) : (
            <ul className="side-ref-list">
              {cardStreams.map((cs) => (
                <li
                  key={cs.id}
                  className="side-ref-item"
                >
                  <span className="stream-stage">{STAGE_LABEL[cs.status]}</span>
                  <span className="side-ref-title">{cs.title.trim() || "（未命名主題串）"}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveId(cs.id);
                      setMode("card");
                    }}
                  >
                    前往
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="side-section">
          <div className="side-section-title">
            當日異動卡片{ch ? `（${ch.items.length}）` : ""}
          </div>
          <p className="muted daily-note">
            靈感模式不啟用盲寫遮罩；點選左側一則靈感後，可將相關卡片直接關聯上去。
          </p>
          {renderSideBody(false, journalTarget, "此則靈感", "先新增或點選一則靈感，才能關聯卡片", false)}
        </div>
      </>
    );
  };

  const renderArchiveModeSide = () => {
    if (archiveErr)
      return (
        <div
          className="banner danger"
          role="alert"
        >
          載入總覽失敗：{archiveErr}
        </div>
      );
    if (!archiveItems) return <div className="empty">載入中…</div>;
    const totalCards = archiveItems.filter((x) => x.kind === "card").length;
    const totalJournals = archiveItems.filter((x) => x.kind === "journal").length;
    const totalConverted = archiveItems.filter((x) => x.converted_card_id !== null).length;

    return (
      <>
        <div className="archive-stats">
          <div className="daily-summary">目前篩選共 {archiveItems.length} 筆紀錄</div>
          <div className="archive-stat-pills">
            <span className="facet-badge kind-updated">卡片總結 {totalCards}</span>
            <span className="facet-badge kind-new">靈感日記 {totalJournals}</span>
            <span className="facet-badge">已轉卡片 {totalConverted}</span>
          </div>
        </div>

        {!selectedArchiveItem ? (
          <div className="empty">點選左側任一條目檢視完整內容</div>
        ) : (
          <div className="archive-detail">
            <div className="archive-detail-head">
              <span
                className={`facet-badge ${selectedArchiveItem.kind === "journal" ? "kind-new" : "kind-updated"}`}
              >
                {selectedArchiveItem.kind === "journal" ? "靈感日記" : "卡片總結"}
              </span>
              <span className="muted">
                {selectedArchiveItem.day}
                {fmtTime(selectedArchiveItem.created_at) ? ` ${fmtTime(selectedArchiveItem.created_at)}` : ""}
              </span>
            </div>
            <h4 className="archive-detail-title">
              {selectedArchiveItem.title.trim() ||
                (selectedArchiveItem.kind === "journal" ? "（無標題靈感）" : "（未命名主題串）")}
            </h4>

            {selectedArchiveItem.kind === "journal" ? (
              <div className="change-body">
                {selectedArchiveItem.review_text.trim() ? (
                  <ui.Markdown
                    source={selectedArchiveItem.review_text}
                    onOpenCard={onOpenCard}
                  />
                ) : (
                  <span className="muted">（無內文）</span>
                )}
              </div>
            ) : (
              <>
                <div className="stream-block recall">
                  <div className="stream-label">
                    <ui.Ico
                      d={ICON.pen}
                    />{" "}
                    回憶提取
                  </div>
                  {selectedArchiveItem.recall_text.trim() ? (
                    <ui.Markdown
                      source={selectedArchiveItem.recall_text}
                      onOpenCard={onOpenCard}
                    />
                  ) : (
                    <span className="muted">（略過盲寫）</span>
                  )}
                </div>
                <div className="stream-block review">
                  <div className="stream-label">
                    <ui.Ico
                      d={ICON.search}
                    />{" "}
                    對照後補充
                  </div>
                  {selectedArchiveItem.review_text.trim() ? (
                    <ui.Markdown
                      source={selectedArchiveItem.review_text}
                      onOpenCard={onOpenCard}
                    />
                  ) : (
                    <span className="muted">（無補充）</span>
                  )}
                </div>
              </>
            )}

            <div className="chips">
              <span className="muted">
                <ui.Ico
                  d={ICON.link}
                />{" "}
                關聯卡片
              </span>
              {selectedArchiveItem.cards.length === 0 && <span className="muted">無</span>}
              {selectedArchiveItem.cards.map((c) => (
                <span
                  key={c.id}
                  className="chip"
                >
                  <button
                    type="button"
                    onClick={() => onOpenCard(c.id)}
                  >
                    {c.title || "（無標題）"}
                  </button>
                </span>
              ))}
            </div>

            <div className="stream-actions">
              <button
                type="button"
                className="primary"
                onClick={() =>
                  jumpToDayMode(selectedArchiveItem.day, selectedArchiveItem.kind, selectedArchiveItem.id)
                }
              >
                前往 {selectedArchiveItem.day} 編輯
              </button>
              {selectedArchiveItem.converted_card_id && (
                <button
                  type="button"
                  onClick={() => onOpenCard(selectedArchiveItem.converted_card_id as string)}
                >
                  開啟已轉出卡片 ↗
                </button>
              )}
            </div>
          </div>
        )}
      </>
    );
  };

  return (
    <div
      className="daily-review"
      role="region"
      aria-label="今日總結與靈感日記"
    >
      {/* 原因：「新增主題串」是動作，卻和 App 頂欄右上四個視圖切換並排，語意混在一起。移到列表底部；日期導覽併成一組，外觀比照 .view-switch。 */}
      <div className="daily-head">
        <div
          className="view-switch"
          role="tablist"
          aria-label="日誌模式切換"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === "card"}
            className={mode === "card" ? "on" : ""}
            onClick={() => setMode("card")}
          >
            卡片總結{streams ? `（${cardStreams.length}）` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "journal"}
            className={mode === "journal" ? "on" : ""}
            onClick={() => setMode("journal")}
          >
            靈感日記{streams ? `（${journalStreams.length}）` : ""}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "archive"}
            className={mode === "archive" ? "on" : ""}
            onClick={() => setMode("archive")}
          >
            雙類總覽
          </button>
        </div>

        {mode !== "archive" ? (
          <>
            <div
              className="daily-nav"
              role="group"
              aria-label="日期切換"
            >
              <button
                type="button"
                onClick={() => setDay((d) => shiftDay(d, -1))}
                aria-label="前一天"
                title="前一天"
              >
                <ui.Ico
                  d={ICON.left}
                />
              </button>
              <span className="daily-day">
                {day}
                <span className="muted">（{WEEK[parseDay(day).getDay()]}）</span>
              </span>
              <button
                type="button"
                onClick={() => setDay((d) => shiftDay(d, 1))}
                aria-label="後一天"
                title="後一天"
              >
                <ui.Ico
                  d={ICON.right}
                />
              </button>
            </div>
            <button
              type="button"
              onClick={() => setDay(todayStr())}
              disabled={day === today}
            >
              今天
            </button>
          </>
        ) : (
          <div className="archive-toolbar">
            <div
              className="view-switch"
              role="group"
              aria-label="總覽類型篩選"
            >
              <button
                type="button"
                className={archiveKind === "all" ? "on" : ""}
                onClick={() => setArchiveKind("all")}
              >
                全部
              </button>
              <button
                type="button"
                className={archiveKind === "card" ? "on" : ""}
                onClick={() => setArchiveKind("card")}
              >
                卡片總結
              </button>
              <button
                type="button"
                className={archiveKind === "journal" ? "on" : ""}
                onClick={() => setArchiveKind("journal")}
              >
                靈感日記
              </button>
            </div>
            <input
              type="date"
              value={archiveFrom}
              aria-label="起始日期"
              onChange={(e) => setArchiveFrom(e.target.value)}
            />
            <span className="muted">～</span>
            <input
              type="date"
              value={archiveTo}
              aria-label="結束日期"
              onChange={(e) => setArchiveTo(e.target.value)}
            />
            <button
              type="button"
              onClick={() => {
                setArchiveFrom(shiftDay(todayStr(), -7));
                setArchiveTo(todayStr());
              }}
            >
              近 7 天
            </button>
            <button
              type="button"
              onClick={() => {
                setArchiveFrom("");
                setArchiveTo("");
              }}
            >
              全部日期
            </button>
            <input
              type="search"
              className="archive-search"
              value={archiveQuery}
              placeholder="搜尋標題或內文…"
              aria-label="搜尋總結與靈感"
              onChange={(e) => setArchiveQuery(e.target.value)}
            />
          </div>
        )}
      </div>

      <div className="daily-body">
        {mode === "card" && (
          <div className="daily-streams">
            {streamsErr && (
              <div
                className="banner danger"
                role="alert"
              >
                載入主題串失敗：{streamsErr}
                <button
                  type="button"
                  onClick={() => setReloadNonce((n) => n + 1)}
                >
                  重試
                </button>
              </div>
            )}
            {streams === null && !streamsErr && <div className="empty">載入中…</div>}
            {streams !== null && cardStreams.length === 0 && (
              <div className="empty">這一天還沒有卡片總結主題串。按下方「新增主題串」，先不看右邊卡片，寫下你記得的。</div>
            )}
            {cardStreams.map((s) => (
              <ui.StreamItem
                key={`${s.id}:${reloadNonce}`}
                stream={s}
                isTarget={target?.id === s.id}
                autoFocus={s.id === newId}
                onActivate={setActiveId}
                onChange={(u, o) => applyStream(u, o)}
                onRemoved={(id) => setStreams((cur) => cur && cur.filter((x) => x.id !== id))}
                onUnbind={(sid, cid) => void bindOp(sid, cid, true)}
                onReload={() => setReloadNonce((n) => n + 1)}
                onOpenCard={onOpenCard}
                report={report}
                info={info}
              />
            ))}
            {streams !== null && (
              <button
                type="button"
                className="stream-add"
                onClick={() => void createStream()}
              >
                <ui.Ico
                  d={ICON.plus}
                />{" "}
                新增主題串
              </button>
            )}
          </div>
        )}

        {mode === "journal" && (
          <div className="daily-streams">
            <div className="journal-composer">
              <div className="journal-composer-head">
                <span className="stream-label">
                  <ui.Ico
                    d={ICON.spark}
                  />{" "}
                  快速記一則靈感／碎念
                </span>
                <button
                  type="button"
                  className="journal-title-toggle"
                  onClick={() => setQuickTitleOpen((v) => !v)}
                >
                  {quickTitleOpen ? "收起標題" : "+ 加標題"}
                </button>
              </div>
              {quickTitleOpen && (
                <input
                  className="journal-quick-title"
                  value={quickTitle}
                  placeholder="靈感標題（選填，轉成卡片時沿用）"
                  onChange={(e) => setQuickTitle(e.target.value)}
                />
              )}
              <textarea
                ref={quickInputRef}
                className="journal-quick-textarea"
                value={quickText}
                disabled={creatingJournal || streams === null}
                placeholder="想到什麼就寫下來，不必整理結構…（Ctrl+Enter 快速送出）"
                onChange={(e) => setQuickText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    void submitQuickJournal();
                  }
                }}
              />
              <div className="stream-actions">
                <button
                  type="button"
                  className="primary"
                  disabled={creatingJournal || streams === null || (!quickText.trim() && !quickTitle.trim())}
                  onClick={() => void submitQuickJournal()}
                >
                  <ui.Ico
                    d={ICON.plus}
                  />{" "}
                  {creatingJournal ? "記錄中…" : "記一筆"}{" "}
                  <span className="stream-kbd">Ctrl+Enter</span>
                </button>
              </div>
            </div>

            {streamsErr && (
              <div
                className="banner danger"
                role="alert"
              >
                載入靈感日記失敗：{streamsErr}
                <button
                  type="button"
                  onClick={() => setReloadNonce((n) => n + 1)}
                >
                  重試
                </button>
              </div>
            )}
            {streams === null && !streamsErr && <div className="empty">載入中…</div>}
            {streams !== null && journalStreams.length === 0 && (
              <div className="empty">這一天還沒有靈感記錄，在上方輸入框隨時記下第一則想法。</div>
            )}
            {journalStreams.map((s) => (
              <ui.JournalItem
                key={`${s.id}:${reloadNonce}`}
                stream={s}
                isTarget={journalTarget?.id === s.id}
                onActivate={setActiveJournalId}
                onChange={(u, o) => applyStream(u, o)}
                onRemoved={(id) => setStreams((cur) => cur && cur.filter((x) => x.id !== id))}
                onUnbind={(sid, cid) => void bindOp(sid, cid, true)}
                onReload={() => setReloadNonce((n) => n + 1)}
                onOpenCard={onOpenCard}
                report={report}
                info={info}
              />
            ))}
          </div>
        )}

        {mode === "archive" && (
          <div className="daily-streams">
            {archiveRangeInvalid && (
              <div
                className="banner warn"
                role="alert"
              >
                起始日期不可晚於結束日期
              </div>
            )}
            {archiveErr && (
              <div
                className="banner danger"
                role="alert"
              >
                載入總覽失敗：{archiveErr}
                <button
                  type="button"
                  onClick={() => setReloadNonce((n) => n + 1)}
                >
                  重試
                </button>
              </div>
            )}
            {archiveItems === null && !archiveErr && <div className="empty">載入中…</div>}
            {archiveTruncated && (
              <div className="banner warn">結果超過 300 筆，僅顯示最新 300 筆；請縮小日期範圍或輸入關鍵字</div>
            )}
            {archiveItems && archiveItems.length === 0 && !archiveRangeInvalid && (
              <div className="empty">符合目前篩選條件的總結或靈感為空</div>
            )}
            {groupedArchive.map(([groupDay, items]) => (
              <section
                key={groupDay}
                className="archive-day-group"
              >
                <div className="archive-day-head">
                  <strong>
                    <ui.Ico
                      d={ICON.calendar}
                    />{" "}
                    {groupDay}
                    <span className="muted">（{WEEK[parseDay(groupDay).getDay()]}）</span>
                  </strong>
                  <span className="muted">共 {items.length} 筆</span>
                </div>
                <div className="archive-day-list">
                  {items.map((item) => {
                    const isJournal = item.kind === "journal";
                    const selected = selectedArchiveItem?.id === item.id;
                    const previewText = isJournal
                      ? item.review_text.trim()
                      : [item.recall_text.trim(), item.review_text.trim()].filter(Boolean).join(" ／ ");
                    return (
                      <article
                        key={item.id}
                        className={`archive-item${selected ? " selected" : ""}`}
                        onClick={() => setSelectedArchiveId(item.id)}
                      >
                        <div className="archive-item-head">
                          <span
                            className={`facet-badge ${isJournal ? "kind-new" : "kind-updated"}`}
                          >
                            {isJournal ? "靈感日記" : "卡片總結"}
                          </span>
                          {!isJournal && <span className="stream-stage">{STAGE_LABEL[item.status]}</span>}
                          <strong className="archive-item-title">
                            {item.title.trim() || (isJournal ? "（無標題靈感）" : "（未命名主題串）")}
                          </strong>
                          {item.converted_card_id && <span className="facet-badge">已轉卡</span>}
                          <span className="muted archive-item-time">{fmtTime(item.created_at)}</span>
                        </div>
                        {previewText && <p className="archive-item-snippet">{previewText}</p>}
                        {item.cards.length > 0 && (
                          <div className="chips">
                            {item.cards.map((c) => (
                              <span
                                key={c.id}
                                className="chip"
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    onOpenCard(c.id);
                                  }}
                                >
                                  {c.title || "（無標題）"}
                                </button>
                              </span>
                            ))}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}

        <aside
          className={`daily-side${mode === "card" && locked ? " locked" : ""}`}
        >
          <div className="daily-side-head">
            {mode === "card" && (
              <>
                <strong>今日異動卡片{ch ? `（${ch.items.length}）` : ""}</strong>
                {streams !== null && locked && (
                  <button
                    type="button"
                    className={`side-peek${peekOn ? " on" : ""}`}
                    onClick={() => void togglePeek()}
                  >
                    <ui.Ico
                      d={ICON.bulb}
                    />{" "}
                    {peekOn ? "隱藏提示" : "顯示標題提示"}
                  </button>
                )}
              </>
            )}
            {mode === "journal" && <strong>靈感脈絡與今日卡片</strong>}
            {mode === "archive" && <strong>總覽統計與詳情</strong>}
          </div>
          {mode === "card" && (
            <p className="muted daily-note">
              依卡片「最後更新時間」推算；「更新」包含標記已整理等任何欄位變動。
              {day !== today && "過去日期可能漏掉之後又被修改的卡片。"}
            </p>
          )}
          <div className="daily-side-body">
            {mode === "card" && renderSideBody(locked, target, "未命名主題串", "先解鎖一個主題串，才能綁定", true)}
            {mode === "journal" && renderJournalModeSide()}
            {mode === "archive" && renderArchiveModeSide()}
          </div>
        </aside>
      </div>
    </div>
  );
}

interface ItemProps {
  stream: DailyStream;
  isTarget: boolean;
  autoFocus: boolean;
  onActivate(id: string): void;
  onChange(s: DailyStream, opts?: { refreshChanges?: boolean }): void;
  onRemoved(id: string): void;
  onUnbind(streamId: string, cardId: string): void;
  onReload(): void;
  onOpenCard(id: string): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

function StreamItem(p: ItemProps) {
  const { stream: s, report, info } = p;
  const id = s.id;
  const [title, setTitle] = useState(s.title);
  const [recall, setRecall] = useState(s.recall_text);
  const [review, setReview] = useState(s.review_text);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [errMsg, setErrMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // 本地草稿是文字的唯一來源；props 只提供狀態、卡片與初始值
  const draft = useRef({ title: s.title, recall: s.recall_text, review: s.review_text });
  const saved = useRef({ ...draft.current });
  const version = useRef(s.updated_at);
  const serverStatus = useRef(s.status);
  serverStatus.current = s.status;
  const statusRef = useRef<SaveStatus>("saved");
  statusRef.current = status;
  const closed = useRef(false);
  const inflight = useRef<Promise<unknown>>(Promise.resolve());
  const recallRef = useRef<HTMLTextAreaElement>(null);
  const reviewRef = useRef<HTMLTextAreaElement>(null);

  // 這個主題串所有寫入都排進同一條佇列：轉換前會等自動儲存結束，版本號才不會過期
  const run = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = inflight.current.then(fn);
    inflight.current = next.catch(() => undefined);
    return next;
  };

  const edit = (k: "title" | "recall" | "review", v: string) => {
    draft.current = { ...draft.current, [k]: v };
    if (k === "title") setTitle(v);
    else if (k === "recall") setRecall(v);
    else setReview(v);
    setStatus((st) => (st === "conflict" ? st : "dirty"));
  };

  const adopt = (u: DailyStream) => {
    version.current = u.updated_at;
    draft.current = { title: u.title, recall: u.recall_text, review: u.review_text };
    saved.current = { ...draft.current };
    setTitle(u.title);
    setRecall(u.recall_text);
    setReview(u.review_text);
    setStatus("saved");
  };

  const saveInner = async () => {
    const d = draft.current;
    const sv = saved.current;
    const patch: { title?: string; recall_text?: string; review_text?: string } = {};
    if (d.title !== sv.title) patch.title = d.title;
    // 盲寫只在階段 1 送、對照只在階段 2 送：與伺服器的狀態機一致，不靠伺服器拒絕來兜底
    if (serverStatus.current === "recalling" && d.recall !== sv.recall) patch.recall_text = d.recall;
    if (serverStatus.current === "comparing" && d.review !== sv.review) patch.review_text = d.review;
    if (Object.keys(patch).length === 0) {
      setStatus((st) => (st === "saving" || st === "dirty" ? "saved" : st));
      return;
    }
    setStatus("saving");
    try {
      const u = await api.patchDailyStream(id, patch, version.current);
      version.current = u.updated_at;
      saved.current = {
        title: d.title,
        recall: patch.recall_text !== undefined ? d.recall : sv.recall,
        review: patch.review_text !== undefined ? d.review : sv.review,
      };
      p.onChange(u);
      setStatus(draft.current === d ? "saved" : "dirty"); // 儲存期間又打了字就再存一次
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_VERSION") setStatus("conflict");
      else {
        setStatus("error");
        setErrMsg(messageOf(e));
      }
      throw e;
    }
  };

  // 解鎖／完成／重開／轉卡片：先把標題等寫進去，再呼叫專用端點；期間輸入框唯讀，回應後以伺服器內容為準
  const transition = async (
    prefix: string,
    call: () => Promise<DailyStream>,
    refreshChanges = false,
  ): Promise<boolean> => {
    setBusy(true);
    try {
      return await run(async () => {
        try {
          await saveInner();
          const u = await call();
          adopt(u);
          p.onChange(u, { refreshChanges });
          return true;
        } catch (e) {
          if (e instanceof ApiError && e.code === "STALE_VERSION") setStatus("conflict");
          else report(e, prefix);
          return false;
        }
      });
    } finally {
      setBusy(false);
    }
  };

  const unlock = () =>
    transition("解鎖失敗", () => api.unlockDailyStream(id, draft.current.recall, version.current));
  const finish = () =>
    transition("完成失敗", () => api.finishDailyStream(id, draft.current.review, version.current));
  const reopen = () => transition("重新開啟失敗", () => api.reopenDailyStream(id, version.current));
  const convert = async () => {
    if (!draft.current.title.trim()) {
      const t = window.prompt("為這個主題串命名（卡片標題會沿用）", "");
      if (!t?.trim()) return;
      edit("title", t.trim());
    }
    const ok = await transition("轉成卡片失敗", () => api.convertDailyStream(id, version.current), true);
    if (ok) info(`已轉成卡片「${draft.current.title}」，可到收件夾查看`);
  };

  const remove = () => {
    if (!window.confirm("刪除這個主題串？盲寫與對照內容會永久消失（已轉出的卡片不受影響）。")) return;
    closed.current = true; // 不再自動儲存，卸載時也不沖刷
    void run(async () => {
      try {
        await api.deleteDailyStream(id);
        p.onRemoved(id);
      } catch (e) {
        closed.current = false;
        report(e, "刪除主題串失敗");
      }
    });
  };

  useEffect(() => {
    if (status !== "dirty" || busy || closed.current) return;
    const t = setTimeout(() => void run(saveInner).catch(() => undefined), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, recall, review, status, busy]);

  // 切換日期／視圖造成卸載時，仍有未儲存內容就立即沖刷（衝突或錯誤狀態不沖刷：不蓋別人的版本）
  useEffect(
    () => () => {
      if (statusRef.current === "dirty" && !closed.current) void run(saveInner).catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (p.autoFocus && s.status === "recalling") recallRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const prevStatus = useRef(s.status);
  useEffect(() => {
    if (prevStatus.current !== s.status && s.status === "comparing") reviewRef.current?.focus();
    prevStatus.current = s.status;
  }, [s.status]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, action: () => unknown) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // 輸入法組字中不觸發
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void action();
    }
  };

  const converted = s.converted_card_id !== null;
  const copyMine = () => {
    const d = draft.current;
    void navigator.clipboard.writeText(`${d.title}\n\n${d.recall}\n\n${d.review}`).catch((e) => report(e, "複製失敗"));
  };

  return (
    <section
      className={`stream-item ${s.status}`}
      onClick={() => p.onActivate(id)}
      aria-label={`主題串：${title || "未命名"}`}
    >
      {/* 原因：階段標籤、標題、綁定目標、儲存狀態、垃圾桶擠在同一列，標題被截斷（階段 2 已看不全）。標題獨佔一列，狀態類資訊放下一列；垃圾桶平時淡出。 */}
      <div className="stream-head">
        <input
          className="stream-title"
          value={title}
          disabled={converted || busy}
          placeholder="主題名稱（轉成卡片時沿用為標題）"
          aria-label="主題串標題"
          onFocus={() => p.onActivate(id)}
          onChange={(e) => edit("title", e.target.value)}
        />
        <button
          type="button"
          className="stream-del"
          onClick={remove}
          aria-label="刪除主題串"
          title="刪除主題串"
        >
          <ui.Ico
            d={ICON.trash}
          />
        </button>
      </div>
      <div className="stream-meta">
        <span className="stream-stage">{STAGE_LABEL[s.status]}</span>
        {p.isTarget && (
          <span
            className="stream-target"
            title="右側點「綁定」會掛到這一串"
          >
            <ui.Ico
              d={ICON.link}
              size={12}
            />{" "}
            綁定目標
          </span>
        )}
        {s.peeked_at && (
          <span
            className="stream-peeked"
            title="盲寫期間曾顯示標題提示"
          >
            <ui.Ico
              d={ICON.bulb}
              size={12}
            />{" "}
            用過提示
          </span>
        )}
        <span
          className={`status ${status}`}
        >
          {SAVE_TEXT[status]}
        </span>
      </div>

      {status === "conflict" && (
        <div
          className="banner danger"
          role="alert"
        >
          這個主題串已在別處被修改，你的修改尚未儲存。
          <button
            type="button"
            onClick={p.onReload}
          >
            重新載入（捨棄我的修改）
          </button>
          <button
            type="button"
            onClick={copyMine}
          >
            複製我的內容
          </button>
        </div>
      )}
      {status === "error" && (
        <div
          className="banner danger"
          role="alert"
        >
          儲存失敗：{errMsg}（內容仍保留在這裡）
          <button
            type="button"
            onClick={() => void run(saveInner).catch(() => undefined)}
          >
            重試
          </button>
        </div>
      )}

      {s.status === "recalling" && (
        <>
          <label
            className="stream-label"
            htmlFor={`recall-${id}`}
          >
            <ui.Ico
              d={ICON.pen}
            />{" "}
            回憶提取
            <span className="muted">先不看右邊，用自己的話寫</span>
          </label>
          <textarea
            id={`recall-${id}`}
            ref={recallRef}
            className="stream-textarea"
            value={recall}
            readOnly={busy}
            placeholder="剛剛學到的核心是什麼…（Ctrl+Enter 解鎖並對照）"
            onFocus={() => p.onActivate(id)}
            onChange={(e) => edit("recall", e.target.value)}
            onKeyDown={(e) => onKeyDown(e, unlock)}
          />
          <div className="stream-actions">
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void unlock()}
            >
              {recall.trim() ? (
                <>
                  <ui.Ico
                    d={ICON.unlock}
                  />{" "}
                  解鎖右側並對照 <span className="stream-kbd">Ctrl+Enter</span>
                </>
              ) : (
                "直接對照"
              )}
            </button>
          </div>
        </>
      )}

      {/* 原因：略過盲寫時原本渲染一個「藍框＋括號空殼」。改成一行虛線提示；有盲寫時用中性灰左條，與對照後補充的強調色左條區分「最初記憶」與「事後補充」。 */}
      {s.status !== "recalling" &&
        (s.recall_text.trim() ? (
          <div className="stream-block recall">
            <div className="stream-label">
              <ui.Ico
                d={ICON.pen}
              />{" "}
              回憶提取
            </div>
            {s.recall_text}
          </div>
        ) : (
          <div className="stream-skipped">
            <ui.Ico
              d={ICON.pen}
            />{" "}
            直接對照卡片
          </div>
        ))}

      {s.status === "comparing" && (
        <>
          <label
            className="stream-label"
            htmlFor={`review-${id}`}
          >
            <ui.Ico
              d={ICON.search}
            />{" "}
            對照後補充
            <span className="muted">補上漏掉的細節、修正錯誤認知</span>
          </label>
          <textarea
            id={`review-${id}`}
            ref={reviewRef}
            className="stream-textarea"
            value={review}
            readOnly={busy}
            placeholder="對照右側卡片後的補充與修正…（Ctrl+Enter 完成）"
            onFocus={() => p.onActivate(id)}
            onChange={(e) => edit("review", e.target.value)}
            onKeyDown={(e) => onKeyDown(e, finish)}
          />
        </>
      )}

      {s.status === "done" && (
        <div className="stream-block review">
          <div className="stream-label">
            <ui.Ico
              d={ICON.search}
            />{" "}
            對照後補充
          </div>
          {s.review_text.trim() ? s.review_text : <span className="muted">（沒有補充）</span>}
        </div>
      )}

      {s.status !== "recalling" && (
        <div className="chips">
          <span className="muted">
            <ui.Ico
              d={ICON.link}
            />{" "}
            關聯
          </span>
          {s.cards.length === 0 && <span className="muted">尚未綁定卡片</span>}
          {s.cards.map((c) => (
            <span
              key={c.id}
              className="chip"
            >
              <button
                type="button"
                onClick={() => p.onOpenCard(c.id)}
                title="在中央編輯這張卡片"
              >
                {c.title || "（無標題）"}
              </button>
              {s.status === "comparing" && (
                <button
                  type="button"
                  aria-label={`解除綁定 ${c.title}`}
                  onClick={() => p.onUnbind(id, c.id)}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="stream-actions">
        {s.status === "comparing" && (
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void finish()}
          >
            <ui.Ico
              d={ICON.check}
            />{" "}
            完成 <span className="stream-kbd">Ctrl+Enter</span>
          </button>
        )}
        {s.status === "done" && !converted && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => void reopen()}
            >
              重新開啟
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => void convert()}
            >
              轉為卡片
            </button>
          </>
        )}
        {converted && (
          <button
            type="button"
            onClick={() => p.onOpenCard(s.converted_card_id as string)}
          >
            已轉為卡片 ↗
          </button>
        )}
      </div>
    </section>
  );
}

function JournalItem(p: Omit<ItemProps, "autoFocus">) {
  const { stream: s, report, info } = p;
  const id = s.id;
  const [title, setTitle] = useState(s.title);
  const [body, setBody] = useState(s.review_text);
  const [status, setStatus] = useState<SaveStatus>("saved");
  const [errMsg, setErrMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const draft = useRef({ title: s.title, body: s.review_text });
  const saved = useRef({ ...draft.current });
  const version = useRef(s.updated_at);
  const statusRef = useRef<SaveStatus>("saved");
  statusRef.current = status;
  const closed = useRef(false);
  const inflight = useRef<Promise<unknown>>(Promise.resolve());

  const run = <T,>(fn: () => Promise<T>): Promise<T> => {
    const next = inflight.current.then(fn);
    inflight.current = next.catch(() => undefined);
    return next;
  };

  const edit = (k: "title" | "body", v: string) => {
    draft.current = { ...draft.current, [k]: v };
    if (k === "title") setTitle(v);
    else setBody(v);
    setStatus((st) => (st === "conflict" ? st : "dirty"));
  };

  const saveInner = async () => {
    const d = draft.current;
    const sv = saved.current;
    const patch: { title?: string; review_text?: string } = {};
    if (d.title !== sv.title) patch.title = d.title;
    if (d.body !== sv.body) patch.review_text = d.body;
    if (Object.keys(patch).length === 0) {
      setStatus((st) => (st === "saving" || st === "dirty" ? "saved" : st));
      return;
    }
    setStatus("saving");
    try {
      const u = await api.patchDailyStream(id, patch, version.current);
      version.current = u.updated_at;
      saved.current = { title: d.title, body: d.body };
      p.onChange(u);
      setStatus(draft.current === d ? "saved" : "dirty");
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_VERSION") setStatus("conflict");
      else {
        setStatus("error");
        setErrMsg(messageOf(e));
      }
      throw e;
    }
  };

  const convert = async () => {
    if (!draft.current.body.trim()) {
      report(new Error("靈感內容為空，無法轉成卡片"));
      return;
    }
    if (!draft.current.title.trim()) {
      const t = window.prompt("為這則靈感命名（卡片標題會沿用）", "");
      if (!t?.trim()) return;
      edit("title", t.trim());
    }
    setBusy(true);
    try {
      await run(async () => {
        try {
          await saveInner();
          const u = await api.convertDailyStream(id, version.current);
          version.current = u.updated_at;
          p.onChange(u, { refreshChanges: true });
          info(`已轉成卡片「${draft.current.title}」，可到收件夾查看`);
        } catch (e) {
          if (e instanceof ApiError && e.code === "STALE_VERSION") setStatus("conflict");
          else report(e, "轉成卡片失敗");
        }
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (!window.confirm("刪除這則靈感日記？（已轉出的卡片不受影響）")) return;
    closed.current = true;
    void run(async () => {
      try {
        await api.deleteDailyStream(id);
        p.onRemoved(id);
      } catch (e) {
        closed.current = false;
        report(e, "刪除靈感失敗");
      }
    });
  };

  useEffect(() => {
    if (status !== "dirty" || busy || closed.current) return;
    const t = setTimeout(() => void run(saveInner).catch(() => undefined), 800);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, body, status, busy]);

  useEffect(
    () => () => {
      if (statusRef.current === "dirty" && !closed.current) void run(saveInner).catch(() => undefined);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const converted = s.converted_card_id !== null;
  const copyMine = () => {
    const d = draft.current;
    void navigator.clipboard.writeText(`${d.title}\n\n${d.body}`).catch((e) => report(e, "複製失敗"));
  };

  return (
    <article
      className={`stream-item journal-item${p.isTarget ? " target" : ""}`}
      onClick={() => p.onActivate(id)}
      aria-label={`靈感日記：${title || "無標題"}`}
    >
      <div className="stream-head">
        <span className="journal-time">{fmtTime(s.created_at) || "靈感"}</span>
        <input
          className="stream-title"
          value={title}
          disabled={converted || busy}
          placeholder="標題（選填，轉成卡片時沿用）"
          aria-label="靈感標題"
          onFocus={() => p.onActivate(id)}
          onChange={(e) => edit("title", e.target.value)}
        />
        {p.isTarget && (
          <span
            className="stream-target"
            title="右側點「綁定」會關聯到這則靈感"
          >
            <ui.Ico
              d={ICON.link}
              size={12}
            />{" "}
            關聯目標
          </span>
        )}
        <span
          className={`status ${status}`}
        >
          {SAVE_TEXT[status]}
        </span>
        <button
          type="button"
          className="stream-del"
          onClick={remove}
          aria-label="刪除靈感"
          title="刪除靈感"
        >
          <ui.Ico
            d={ICON.trash}
          />
        </button>
      </div>

      {status === "conflict" && (
        <div
          className="banner danger"
          role="alert"
        >
          這則靈感已在別處被修改，你的修改尚未儲存。
          <button
            type="button"
            onClick={p.onReload}
          >
            重新載入（捨棄我的修改）
          </button>
          <button
            type="button"
            onClick={copyMine}
          >
            複製我的內容
          </button>
        </div>
      )}
      {status === "error" && (
        <div
          className="banner danger"
          role="alert"
        >
          儲存失敗：{errMsg}（內容仍保留在這裡）
          <button
            type="button"
            onClick={() => void run(saveInner).catch(() => undefined)}
          >
            重試
          </button>
        </div>
      )}

      <textarea
        className="journal-textarea"
        value={body}
        readOnly={converted || busy}
        placeholder="靈感或瑣碎想法…"
        aria-label="靈感內容"
        onFocus={() => p.onActivate(id)}
        onChange={(e) => edit("body", e.target.value)}
      />

      {s.cards.length > 0 && (
        <div className="chips">
          <span className="muted">
            <ui.Ico
              d={ICON.link}
            />{" "}
            關聯卡片
          </span>
          {s.cards.map((c) => (
            <span
              key={c.id}
              className="chip"
            >
              <button
                type="button"
                onClick={() => p.onOpenCard(c.id)}
                title="在中央編輯這張卡片"
              >
                {c.title || "（無標題）"}
              </button>
              {!converted && (
                <button
                  type="button"
                  aria-label={`解除綁定 ${c.title}`}
                  onClick={() => p.onUnbind(id, c.id)}
                >
                  ✕
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="stream-actions">
        {!converted ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void convert()}
          >
            轉為卡片
          </button>
        ) : (
          <button
            type="button"
            onClick={() => p.onOpenCard(s.converted_card_id as string)}
          >
            已轉為卡片 ↗
          </button>
        )}
      </div>
    </article>
  );
}