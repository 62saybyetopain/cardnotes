// @depends-on ../api.ts (api)
// @depends-on ../types.ts (CardSummary)
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { CardSummary } from "../types";

interface Props {
  currentCardId: string;
  initialQuery?: string;
  onSelect(card: { id: string; title: string }): void | Promise<void>;
  onCancel(): void;
  report(e: unknown, prefix?: string): void;
}

export function MentionPopup({
  currentCardId,
  initialQuery = "",
  onSelect,
  onCancel,
  report,
}: Props) {
  const [query, setQuery] = useState(() => initialQuery.replace(/^[@＠]+/, ""));
  const [items, setItems] = useState<CardSummary[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setQuery(initialQuery.replace(/^[@＠]+/, ""));
  }, [initialQuery]);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        const len = el.value.length;
        el.setSelectionRange(len, len);
      }
    });
    return () => cancelAnimationFrame(id);
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const cleanQ = query.replace(/^[@＠]+/, "").trim();
    api
      .listCards({ q: cleanQ || undefined, limit: 20 })
      .then((res) => {
        if (!alive) return;
        const filtered = res.items.filter((c) => c.id !== currentCardId);
        setItems(filtered);
        setActiveIndex(0);
      })
      .catch((e) => {
        if (alive) report(e, "搜尋卡片失敗");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [query, currentCardId, report]);

  const choose = async (item: CardSummary | undefined) => {
    if (!item || submitting) return;
    setSubmitting(true);
    try {
      await onSelect({ id: item.id, title: item.title });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="mention-popup"
      role="dialog"
      aria-label="引用卡片"
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing || e.keyCode === 229) return;
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          if (items.length > 0) {
            setActiveIndex((i) => (i + 1) % items.length);
          }
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          if (items.length > 0) {
            setActiveIndex((i) => (i - 1 + items.length) % items.length);
          }
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          void choose(items[activeIndex]);
        }
      }}
    >
      <div className="mention-head">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="輸入關鍵字搜尋要引用的卡片…"
          aria-label="搜尋要引用的卡片"
          disabled={submitting}
        />
        <button type="button" onClick={onCancel} aria-label="取消引用">
          取消
        </button>
      </div>
      {loading && items.length === 0 && <div className="muted pad">搜尋中…</div>}
      {!loading && items.length === 0 && <div className="muted pad">找不到可引用的卡片</div>}
      {items.length > 0 && (
        <ul className="plain mention-list" role="listbox" aria-label="候選卡片清單">
          {items.map((item, idx) => (
            <li key={item.id} role="option" aria-selected={idx === activeIndex}>
              <button
                type="button"
                className={`mention-item${idx === activeIndex ? " active" : ""}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => void choose(item)}
                disabled={submitting}
              >
                <strong>{item.title || "（無標題）"}</strong>
                {item.snippet && <span className="snippet">{item.snippet}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}