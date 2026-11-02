// @depends-on ../api.ts (listCardLiterature, putCardLiterature, patchLiteratureCitation, deleteLiteratureCitation, listLiterature；僅電腦端)
// @depends-on ../App.tsx (subscribeOpenLiterature：App 訂閱後才能從卡片側跳到文獻庫；沒有訂閱者時 requestOpenLiterature 會丟錯)
// @depends-on ../lib/storage (getPreferredDriverType：網頁／iPad 版（dexie）沒有文獻功能，整個區塊不渲染)
import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { getPreferredDriverType } from "../lib/storage";
import type { CardLiteratureRef, LiteratureSummary } from "../types";

// 比照 Markdown.tsx 的 notifyCardDeleted／subscribeCardTitle：模組層級的通道，避免 prop 一路傳進兩個 ContentTab
const openListeners = new Set<(id: string) => void>();

export function subscribeOpenLiterature(fn: (id: string) => void): () => void {
  openListeners.add(fn);
  return () => {
    openListeners.delete(fn);
  };
}

export function requestOpenLiterature(id: string): void {
  if (openListeners.size === 0) throw new Error("文獻庫尚未就緒，無法開啟");
  openListeners.forEach((fn) => fn(id));
}

interface Props {
  cardId: string;
  report(e: unknown, prefix?: string): void;
  info?(text: string): void;
}

export function LiteratureField(props: Props) {
  if (getPreferredDriverType() === "dexie") return null;
  return <LiteratureFieldInner {...props} />;
}

function LiteratureFieldInner({ cardId, report, info }: Props) {
  const [refs, setRefs] = useState<CardLiteratureRef[] | null>(null);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<LiteratureSummary[]>([]);
  const [picked, setPicked] = useState<LiteratureSummary | null>(null);
  const [locator, setLocator] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listCardLiterature(cardId)
      .then((r) => setRefs(r.citations))
      .catch((e) => report(e, "載入引用的文獻失敗"));
  }, [cardId, report]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const text = q.trim();
    if (!text) {
      setFound([]);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .listLiterature({ q: text, limit: 8 })
        .then((r) => alive && setFound(r.items))
        .catch((e) => alive && report(e, "搜尋文獻失敗"));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, report]);

  const add = async () => {
    if (!picked || busy) return;
    setBusy(true);
    try {
      const r = await api.putCardLiterature(cardId, { literature_id: picked.id, locator: locator.trim() });
      if (r.existed) info?.("這張卡片已經引用過這份文獻的相同位置");
      setPicked(null);
      setQ("");
      setFound([]);
      setLocator("");
      load();
    } catch (e) {
      report(e, "掛上文獻失敗");
    } finally {
      setBusy(false);
    }
  };

  const editLocator = async (r: CardLiteratureRef) => {
    const next = window.prompt("引用位置（頁碼、章節、影片時間點…；留空＝整份）", r.locator);
    if (next === null || next.trim() === r.locator) return;
    try {
      await api.patchLiteratureCitation(r.id, next.trim());
      load();
    } catch (e) {
      report(e, "修改引用位置失敗");
    }
  };

  const remove = async (r: CardLiteratureRef) => {
    try {
      await api.deleteLiteratureCitation(r.id);
      load();
    } catch (e) {
      report(e, "移除引用失敗");
    }
  };

  const open = (literatureId: string) => {
    try {
      requestOpenLiterature(literatureId);
    } catch (e) {
      report(e, "開啟文獻失敗");
    }
  };

  return (
    <div className="tag-section" style={{ marginTop: 8 }}>
      <div className="chips">
        <span className="muted">引用的文獻：</span>
        {refs === null && <span className="muted">載入中…</span>}
        {refs !== null && refs.length === 0 && <span className="muted">尚未掛任何文獻</span>}
      </div>
      {refs !== null && refs.length > 0 && (
        <ul className="results">
          {refs.map((r) => (
            <li key={r.id}>
              <button className="result-main" onClick={() => open(r.literature_id)} title="在文獻庫開啟這份文獻">
                <strong>{r.title || "（無標題）"}</strong>
                <span className="snippet">
                  {[r.author, r.locator ? `位置：${r.locator}` : "整份引用"].filter(Boolean).join(" · ")}
                </span>
              </button>
              <button onClick={() => void editLocator(r)} title="修改引用位置">
                改位置
              </button>
              <button onClick={() => void remove(r)} aria-label={`移除對 ${r.title} 的引用`}>
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="tag-pick">
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            if (picked) setPicked(null);
          }}
          placeholder="搜尋文獻（標題、內文、作者）以掛上"
          aria-label="搜尋要掛上的文獻"
        />
      </div>
      {!picked && found.length > 0 && (
        <ul className="results">
          {found.map((l) => (
            <li key={l.id}>
              <button className="result-main" onClick={() => setPicked(l)}>
                <strong>{l.title || "（無標題）"}</strong>
                <span className="snippet">{[l.author, l.captured_on].filter(Boolean).join(" · ") || "\u00A0"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {picked && (
        <div className="resolve-box">
          <div className="resolve-title">掛上：{picked.title || "（無標題）"}</div>
          <div className="field-row">
            <span className="muted">引用位置（選填，例如 p.34、第 2 章、12:30；留空＝整份）：</span>
            <input value={locator} onChange={(e) => setLocator(e.target.value)} maxLength={200} />
          </div>
          <div className="resolve-actions">
            <button className="primary" disabled={busy} onClick={() => void add()}>
              加入引用
            </button>
            <button onClick={() => setPicked(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  );
}