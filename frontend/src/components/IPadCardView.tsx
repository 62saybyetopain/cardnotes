// @depends-on ../lib/storage/index.ts (storage)
// @depends-on ../types.ts (CardSummary, Tag)
import { useRef, useState } from "react";
import { storage } from "../lib/storage";
import type { CardSummary, SyncPackage, Tag } from "../types";

interface Props {
  cards: CardSummary[];
  selectedCardId: string | null;
  tags: Tag[];
  onSelectCard(id: string): void;
  onCreateCard(): void;
  onRefresh(): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

export function IPadCardView({
  cards,
  selectedCardId,
  tags: _tags,
  onSelectCard,
  onCreateCard,
  onRefresh,
  report,
  info,
}: Props) {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 匯出 iPad 變更封包（給電腦端比對合併用）
  const handleExport = async () => {
    setExporting(true);
    try {
      const pkg = await storage.syncExport();
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `cardboard-ipad-sync-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(url);
      info("已匯出 iPad 變更檔案，請透過 AirDrop 或雲端傳送至電腦端合併。");
    } catch (e) {
      report(e, "匯出失敗");
    } finally {
      setExporting(false);
    }
  };

  // 匯入電腦備份（直接覆蓋本機舊檔）
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!window.confirm("確定要匯入此備份嗎？\n注意：這將會完全覆蓋此 iPad 上的所有本機卡片與標籤！")) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setImporting(true);
    try {
      const text = await file.text();
      const pkg = JSON.parse(text) as SyncPackage;
      if (!pkg || !Array.isArray(pkg.cards)) {
        throw new Error("無效的備份檔案格式");
      }
      if (typeof storage.importPackageOverwrite === "function") {
        await storage.importPackageOverwrite(pkg);
        info(`已完成還原！已同步載入 ${pkg.cards.length} 張卡片。`);
        onRefresh();
      } else {
        throw new Error("目前儲存驅動不支援直接覆蓋匯入");
      }
    } catch (err) {
      report(err, "匯入覆蓋失敗");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="ipad-view">
      <div className="ipad-toolbar">
        <div className="ipad-toolbar-left">
          <span className="ipad-badge">iPad 卡片冊模式</span>
          <span className="muted" style={{ fontSize: 13 }}>共 {cards.length} 張卡片</span>
        </div>
        <div className="ipad-toolbar-actions">
          <button type="button" className="touch-btn" onClick={handleExport} disabled={exporting}>
            {exporting ? "匯出中…" : "📤 匯出變更"}
          </button>
          <button
            type="button"
            className="touch-btn"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            {importing ? "還原中…" : "📥 匯入電腦備份"}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={handleImportFile}
          />
          <button type="button" className="touch-btn primary" onClick={onCreateCard}>
            ＋ 新增卡片
          </button>
        </div>
      </div>

      <div className="ipad-card-grid">
        {cards.length === 0 && (
          <div className="empty" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px 0" }}>
            尚無卡片，點擊上方「＋ 新增卡片」開始記錄。
          </div>
        )}
        {cards.map((c) => {
          const isSelected = c.id === selectedCardId;
          const cardTags = (c.tags ?? []).map((t) => t.name);
          return (
            <div
              key={c.id}
              className={`ipad-card-item${isSelected ? " active" : ""}`}
              onClick={() => onSelectCard(c.id)}
              role="button"
              tabIndex={0}
            >
              <div className="ipad-card-item-title">{c.title || "（無標題卡片）"}</div>
              <div className="ipad-card-item-snippet">{c.snippet || "（空白內文）"}</div>
              <div className="ipad-card-item-footer">
                <span className="ipad-card-time">{new Date(c.updated_at).toLocaleDateString()}</span>
                {cardTags.length > 0 && (
                  <div className="ipad-card-tags">
                    {cardTags.slice(0, 2).map((tn, idx) => (
                      <span key={idx} className="facet-badge">{tn}</span>
                    ))}
                    {cardTags.length > 2 && <span className="muted">+{cardTags.length - 2}</span>}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}