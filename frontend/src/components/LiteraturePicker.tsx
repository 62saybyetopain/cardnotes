// @depends-on ../api.ts (listLiterature：只回摘要不帶內文；Dexie 端回空清單，此元件只在桌面版頂欄掛載)
// @depends-on ../App.tsx (onPick 由 App 轉給 BoardHandle.addLiterature；同一份文獻重複放上同一塊白板的提示由 Board 負責)
// @depends-on ../styles.css (.lit-picker-wrap / .lit-picker-pop / .lit-picker-list / .lit-picker-item)
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { LiteratureSummary } from "../types";

export function LiteraturePicker(props: {
  onPick(litId: string): void;
  report(e: unknown, prefix?: string): void;
}) {
  const { onPick, report } = props;
  const [open, setOpen] = useState(false);
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

  // 按鈕與浮層在同一個 wrapRef 內，點按鈕不會被「點外面關閉」誤判成外部點擊
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="lit-picker-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`icon-btn${open ? " on" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label="加入文獻"
        aria-expanded={open}
        title="從文獻庫挑一份文獻放上這塊白板"
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
                    setOpen(false);
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