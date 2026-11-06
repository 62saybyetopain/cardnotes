// @depends-on ../api.ts (listLiterature：只回摘要不帶內文；Dexie 端回空清單，此元件只在桌面版頂欄掛載)
// @depends-on ../App.tsx (onPick 由 App 轉給 BoardHandle.addLiterature；同一份文獻重複放上同一塊白板的提示由 Board 負責)
// @depends-on ../styles.css (.lit-picker-wrap / .lit-picker-pop / .lit-picker-list / .lit-picker-item；選單與清單共用 .lit-picker-pop)
// @depends-on ./LiteratureLibrary.tsx (todayLocal：新增文獻時帶入擷取日期，與文獻庫的「＋ 新增文獻」一致)
// @depends-on ../api.ts (createLiterature：僅電腦端；onCreated 由 App 放上白板並開中央編輯，建立後的文獻庫刷新靠 LiteratureLibrary 掛載時重抓)
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { LiteratureSummary } from "../types";
import { todayLocal } from "./LiteratureLibrary";

export function LiteraturePicker(props: {
  onPick(litId: string): void;
  onCreated(litId: string): void; // 新文獻已建立：由呼叫端負責放上白板與後續處理
  report(e: unknown, prefix?: string): void;
}) {
  const { onPick, onCreated, report } = props;
  const [view, setView] = useState<"closed" | "menu" | "list">("closed");
  const open = view === "list"; // 清單是否展開；載入清單的 effect 只看這個
  const [q, setQ] = useState("");
  const [items, setItems] = useState<LiteratureSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api
        .listLiterature({ q: q.trim() || undefined, limit: 50 })
        .then((r) => alive && setItems(r.items))
        .catch((e) => alive && report(e, "載入文獻清單失敗"))
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [open, q, report]);

  // 按鈕、選單與清單都在同一個 wrapRef 內，點按鈕不會被「點外面關閉」誤判成外部點擊
  useEffect(() => {
    if (view === "closed") return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setView("closed");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setView("closed");
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [view]);

  // 標題按取消＝不建立，避免留下空文獻；建立成功後放上白板與開編輯交給 onCreated
  const createNew = async () => {
    setView("closed");
    const title = window.prompt("新文獻標題（可留空，之後再填）", "");
    if (title === null) return;
    try {
      const d = await api.createLiterature({ title: title.trim(), captured_on: todayLocal() });
      onCreated(d.id);
    } catch (e) {
      report(e, "新增文獻失敗");
    }
  };

  return (
    <div className="lit-picker-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`icon-btn${view !== "closed" ? " on" : ""}`}
        onClick={() => setView((v) => (v === "closed" ? "menu" : "closed"))}
        aria-label="加入文獻"
        aria-expanded={view !== "closed"}
        title="加入文獻（從文獻庫選取，或在白板上新增）"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M2.5 3h4A1.5 1.5 0 0 1 8 4.5V13a1 1 0 0 0-1-1H2.5z" />
          <path d="M13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1 1 0 0 1 1-1h4.5z" />
        </svg>
      </button>
      {view === "menu" && (
        <div className="lit-picker-pop" role="menu" aria-label="加入文獻">
          <button type="button" role="menuitem" className="lit-picker-item" onClick={() => setView("list")}>
            <strong>從文獻庫選取</strong>
            <span className="snippet">挑一份現有文獻放上這塊白板</span>
          </button>
          <button type="button" role="menuitem" className="lit-picker-item" onClick={() => void createNew()}>
            <strong>在白板上新增文獻</strong>
            <span className="snippet">建立新文獻並放上這塊白板，隨即開啟編輯</span>
          </button>
        </div>
      )}
      {open && (
        <div className="lit-picker-pop" role="dialog" aria-label="選擇要放上白板的文獻">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜尋標題、內文、作者、網址"
            aria-label="搜尋文獻"
          />
          {loading && <div className="muted">載入中…</div>}
          {!loading && items.length === 0 && <div className="muted">沒有符合的文獻</div>}
          <ul className="lit-picker-list">
            {items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  className="lit-picker-item"
                  onClick={() => {
                    onPick(it.id);
                    setView("closed");
                  }}
                >
                  <strong>{it.title || "（無標題）"}</strong>
                  <span className="snippet">{[it.author, it.snippet].filter(Boolean).join(" · ") || "\u00A0"}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}