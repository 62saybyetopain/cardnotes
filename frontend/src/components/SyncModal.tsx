// @depends-on ../api.ts (api)
// @depends-on ../types.ts (SyncPackage, SyncDiffReport, SyncCardDiff)
import { useRef, useState } from "react";
import { api } from "../api";
import type { SyncCardDiff, SyncDiffReport, SyncPackage } from "../types";

interface Props {
  onClose(): void;
  onApplied(): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

export function SyncModal({ onClose, onApplied, report, info }: Props) {
  const [pkg, setPkg] = useState<SyncPackage | null>(null);
  const [diff, setDiff] = useState<SyncDiffReport | null>(null);
  const [comparing, setComparing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [selectedNewCardIds, setSelectedNewCardIds] = useState<Set<string>>(new Set());
  const [selectedUpdateCardIds, setSelectedUpdateCardIds] = useState<Set<string>>(new Set());
  const [viewingDiffCard, setViewingDiffCard] = useState<SyncCardDiff | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportBackup = async () => {
    try {
      const data = await api.syncExport();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `cardboard-backup-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(url);
      info("已成功匯出電腦端完整備份 JSON");
    } catch (e) {
      report(e, "匯出備份失敗");
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setComparing(true);
    setDiff(null);
    setViewingDiffCard(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SyncPackage;
      if (!parsed || !Array.isArray(parsed.cards)) {
        throw new Error("無效的同步封包格式（缺少 cards 陣列）");
      }
      setPkg(parsed);
      const res: SyncDiffReport = await api.syncDiff(parsed);
      setDiff(res);
      setSelectedNewCardIds(new Set(res.cards_new.map((c: { id: string }) => c.id)));
      setSelectedUpdateCardIds(new Set(res.cards_updated.map((c: SyncCardDiff) => c.id)));
      info(`已解析差異：${res.cards_new.length} 張新增、${res.cards_updated.length} 張待更新`);
    } catch (err) {
      report(err, "讀取或比對同步檔案失敗");
      setPkg(null);
    } finally {
      setComparing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const toggleSelectAll = (checked: boolean) => {
    if (!diff) return;
    if (checked) {
      setSelectedNewCardIds(new Set(diff.cards_new.map((c) => c.id)));
      setSelectedUpdateCardIds(new Set(diff.cards_updated.map((c) => c.id)));
    } else {
      setSelectedNewCardIds(new Set());
      setSelectedUpdateCardIds(new Set());
    }
  };

  const toggleNewCard = (id: string) => {
    setSelectedNewCardIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleUpdateCard = (id: string) => {
    setSelectedUpdateCardIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const applyChanges = async () => {
    if (!pkg || !diff) return;
    const totalSelected = selectedNewCardIds.size + selectedUpdateCardIds.size;
    if (
      totalSelected === 0 &&
      diff.tags_new.length === 0 &&
      diff.links_new.length === 0 &&
      diff.card_tags_new.length === 0
    ) {
      info("未選取任何欲套用的變更項目");
      return;
    }

    setApplying(true);
    try {
      const res = await api.syncApply({
        card_ids_to_add: Array.from(selectedNewCardIds),
        card_ids_to_update: Array.from(selectedUpdateCardIds),
        tag_ids_to_add: diff.tags_new.map((t) => t.id),
        tag_ids_to_update: diff.tags_updated.map((t) => t.id),
        card_tags_to_add: diff.card_tags_new,
        links_to_add: diff.links_new,
        board_cards_to_add: diff.board_cards_new,
        package: pkg,
      });
      info(
        `同步成功！新增 ${res.applied.cards_added} 張、更新 ${res.applied.cards_updated} 張、建立 ${res.applied.links_added} 條連結`,
      );
      onApplied();
      onClose();
    } catch (e) {
      report(e, "套用同步變更失敗");
    } finally {
      setApplying(false);
    }
  };

  const hasChanges =
    diff &&
    (diff.cards_new.length > 0 ||
      diff.cards_updated.length > 0 ||
      diff.tags_new.length > 0 ||
      diff.links_new.length > 0 ||
      diff.card_tags_new.length > 0 ||
      diff.board_cards_new.length > 0);

  return (
    <div className="modal" role="dialog" aria-label="資料同步與備份">
      <div className="modal-card sync-modal-card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h4>資料同步與備份</h4>
          <button type="button" onClick={onClose} aria-label="關閉視窗">
            ✕
          </button>
        </div>

        <div className="sync-top-actions">
          <button type="button" onClick={() => void exportBackup()}>
            📥 匯出電腦端完整備份 (JSON)
          </button>
          <button type="button" className="primary" onClick={() => fileInputRef.current?.click()}>
            📤 讀取 iPad / 備份檔案比對…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(e) => void handleFileSelect(e)}
          />
        </div>

        {comparing && <div className="muted pad">正在比對資料庫差異…</div>}

        {diff && (
          <div className="sync-diff-container">
            <div className="sync-summary-bar">
              <span>來源裝置：<strong>{diff.source_device || "行動端"}</strong></span>
              <span>封包時間：{new Date(diff.exported_at).toLocaleString()}</span>
              <span className="count">略過未變更／較舊卡片：{diff.cards_unchanged_count} 張</span>
            </div>

            {!hasChanges ? (
              <div className="empty">此檔案與電腦端資料完全一致，無需更新。</div>
            ) : (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <label className="sync-check-row" style={{ fontWeight: 600 }}>
                    <input
                      type="checkbox"
                      checked={
                        selectedNewCardIds.size === diff.cards_new.length &&
                        selectedUpdateCardIds.size === diff.cards_updated.length
                      }
                      onChange={(e) => toggleSelectAll(e.target.checked)}
                    />
                    全選所有變更（{diff.cards_new.length + diff.cards_updated.length} 張卡片）
                  </label>
                  <span className="muted" style={{ fontSize: 12 }}>
                    附帶追加：{diff.tags_new.length} 標籤 · {diff.links_new.length} 連結 · {diff.board_cards_new.length} 白板歸屬
                  </span>
                </div>

                <div className="sync-diff-list">
                  {diff.cards_new.map((c) => (
                    <div key={c.id} className="sync-diff-item">
                      <label className="sync-check-row">
                        <input
                          type="checkbox"
                          checked={selectedNewCardIds.has(c.id)}
                          onChange={() => toggleNewCard(c.id)}
                        />
                        <span className="facet-badge" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#10b981" }}>
                          新增
                        </span>
                        <strong>{c.title || "（無標題）"}</strong>
                      </label>
                      <span className="snippet" style={{ maxWidth: 240 }}>
                        {c.body.slice(0, 40) || "（空內文）"}
                      </span>
                    </div>
                  ))}

                  {diff.cards_updated.map((c) => (
                    <div key={c.id} className="sync-diff-item" style={{ flexDirection: "column", alignItems: "stretch" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <label className="sync-check-row">
                          <input
                            type="checkbox"
                            checked={selectedUpdateCardIds.has(c.id)}
                            onChange={() => toggleUpdateCard(c.id)}
                          />
                          <span className="facet-badge" style={{ background: "rgba(59, 130, 246, 0.15)", color: "#3b82f6" }}>
                            修改
                          </span>
                          <strong>{c.new_title || c.title || "（無標題）"}</strong>
                        </label>
                        <button
                          type="button"
                          onClick={() => setViewingDiffCard((cur) => (cur?.id === c.id ? null : c))}
                        >
                          {viewingDiffCard?.id === c.id ? "收合對照" : "比對差異 (Diff)"}
                        </button>
                      </div>

                      {viewingDiffCard?.id === c.id && (
                        <div className="diff-view-box">
                          <div className="diff-pane">
                            <div className="diff-pane-head">電腦端目前內容</div>
                            <div className="diff-pane-title">標題：{c.old_title || "（無標題）"}</div>
                            <pre className="diff-pane-body">{c.old_body || "（空）"}</pre>
                          </div>
                          <div className="diff-pane new">
                            <div className="diff-pane-head">匯入檔案新內容</div>
                            <div className="diff-pane-title">標題：{c.new_title || "（無標題）"}</div>
                            <pre className="diff-pane-body">{c.new_body || "（空）"}</pre>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 8 }}>
          <button type="button" onClick={onClose} disabled={applying}>
            取消
          </button>
          {hasChanges && (
            <button
              type="button"
              className="primary"
              disabled={applying || (selectedNewCardIds.size === 0 && selectedUpdateCardIds.size === 0)}
              onClick={() => void applyChanges()}
            >
              {applying ? "套用中…" : `確認套用所選變更（${selectedNewCardIds.size + selectedUpdateCardIds.size}）`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}