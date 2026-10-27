// @depends-on ./RightPanel.tsx (ContentTab.updateSources：onSave 失敗時必須 throw，這裡靠它判斷有沒有存成功)
// @depends-on ../types.ts (CardDetail.sources)
import { useEffect, useRef, useState, type ReactNode } from "react";

// 只認 http/https；遇空白、尖括號、引號與全形標點停止（中文字不當結尾，網址可能含中文路徑）
const URL_RE = /https?:\/\/[^\s<>"'\u3000-\u303F\uFF00-\uFFEF]+/gi;
const TRAILING_PUNCT = /[.,;:!?)\]]+$/;

function renderLinked(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(URL_RE)) {
    const at = m.index ?? 0;
    const url = m[0].replace(TRAILING_PUNCT, "");
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <a
        key={n++}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        style={{ color: "var(--accent)" }}
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>,
    );
    last = at + url.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function SourcesField({ sources, onSave }: { sources: string[]; onSave(next: string[]): Promise<void> }) {
  const [items, setItems] = useState<string[]>(() => (sources.length ? sources : [""]));
  const [editing, setEditing] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const committed = useRef(JSON.stringify(sources));

  // 只有外部帶來不同內容（重新載入、別處更新）才重設草稿；自己存成功的內容已寫進 committed，不會觸發
  useEffect(() => {
    const incoming = JSON.stringify(sources);
    if (incoming === committed.current) return;
    committed.current = incoming;
    setItems(sources.length ? sources : [""]);
    setEditing(null);
  }, [sources]);

  const commit = async (next: string[]) => {
    const cleaned = next.map((s) => s.trim()).filter(Boolean);
    const json = JSON.stringify(cleaned);
    if (json === committed.current) return;
    setSaving(true);
    try {
      await onSave(cleaned);
      committed.current = json; // 成功才記錄；失敗時草稿保留，下次失焦會重試
    } catch {
      /* onSave 已回報錯誤 */
    } finally {
      setSaving(false);
    }
  };

  const add = () => {
    setEditing(items.length);
    setItems((cur) => [...cur, ""]);
  };

  const remove = (i: number) => {
    const next = items.filter((_, k) => k !== i);
    const kept = next.length ? next : [""];
    setItems(kept);
    setEditing(null);
    void commit(kept);
  };

  return (
    <div className="field-row">
      <span className="muted">出處（這張卡片的資料來自哪裡，網址會自動變成連結）：</span>
      {items.map((text, i) => {
        const isEditing = editing === i || text.trim() === "";
        return (
          <div key={i} style={{ display: "flex", gap: 4, alignItems: "flex-start", marginBottom: 4 }}>
            {isEditing ? (
              <textarea
                rows={2}
                value={text}
                autoFocus={editing === i}
                placeholder="貼上網址，或寫書名、作者、頁碼…"
                aria-label={`出處 ${i + 1}`}
                onChange={(e) => setItems((cur) => cur.map((s, k) => (k === i ? e.target.value : s)))}
                onBlur={() => {
                  setEditing(null);
                  void commit(items);
                }}
                style={{ flex: 1, resize: "vertical" }}
              />
            ) : (
              <div
                role="button"
                tabIndex={0}
                title="點擊編輯"
                onClick={() => setEditing(i)}
                onKeyDown={(e) => e.key === "Enter" && setEditing(i)}
                style={{
                  flex: 1,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  cursor: "text",
                  padding: "5px 8px",
                  border: "1px solid var(--line)",
                  borderRadius: 6,
                  background: "var(--panel)",
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {renderLinked(text)}
              </div>
            )}
            {(items.length > 1 || text.trim() !== "") && (
              <button type="button" onClick={() => remove(i)} disabled={saving} aria-label={`移除出處 ${i + 1}`} title="移除此出處">
                ✕
              </button>
            )}
          </div>
        );
      })}
      <button type="button" onClick={add} disabled={saving || items.some((s) => s.trim() === "")}>
        ＋ 新增出處
      </button>
    </div>
  );
}