// @depends-on ../lib/storage/index.ts (storage)
// @depends-on ../lib/p2p.ts (sendP2PPackage)
// @depends-on ../types.ts (BoardSummary, CardSummary, SyncPackage, Tag)
import { useRef, useState } from "react";
import { sendP2PPackage } from "../lib/p2p";
import { storage } from "../lib/storage";
import type { BoardSummary, CardSummary, SyncPackage, Tag } from "../types";

interface Props {
  cards: CardSummary[];
  selectedCardId: string | null;
  boardId: string | null;
  boards: BoardSummary[];
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
  boardId,
  boards,
  tags: _tags,
  onSelectCard,
  onCreateCard,
  onRefresh,
  report,
  info,
}: Props) {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [p2pModalOpen, setP2pModalOpen] = useState(false);
  const [pairingCodeInput, setPairingCodeInput] = useState("");
  const [p2pSending, setP2pSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const activeBoard = boards.find((b) => b.id === boardId);

  // 一鍵填入初始示範資料（讓首次打開 GitHub Pages 的 iPad 立即有標籤與抽屜可測）
  const loadSampleData = async () => {
    try {
      const now = new Date().toISOString();
      const demoPkg: SyncPackage = {
        version: 1,
        exported_at: now,
        source_device: "ipad_sample",
        cards: [
          {
            id: "sample-c1",
            title: "肩胛骨動作障礙評估",
            body: "# 肩胛骨動作障礙\n觀察肩胛骨在上舉過程中的翼狀或代償，評估菱形肌與前鋸肌的力偶平衡。",
            card_type: "concept",
            curation_status: "curated",
            created_at: now,
            updated_at: now,
            tags: [],
            links: [],
            boards: [],
            warnings: [],
          },
          {
            id: "sample-c2",
            title: "胸椎活動度矯正運動",
            body: "胸椎後伸活動度不足時，肩關節容易產生夾擠現象。\n相關動作參考：[肩胛骨動作障礙評估](card:sample-c1)",
            card_type: "method",
            curation_status: "curated",
            created_at: now,
            updated_at: now,
            tags: [],
            links: [],
            boards: [],
            warnings: [],
          },
        ],
        tags: [
          {
            id: "sample-t1",
            name: "肩膀與上肢",
            axis: "location",
            facet: null,
            definition: "上肢關節與肩胛力學收納抽屜",
            parent_id: null,
            aliases: ["上肢"],
          },
          {
            id: "sample-t2",
            name: "動作評估",
            axis: "concept",
            facet: "方法／工具",
            definition: "功能性動態評估手段",
            parent_id: null,
            aliases: [],
          },
        ],
        card_tags: [
          { card_id: "sample-c1", tag_id: "sample-t1" },
          { card_id: "sample-c1", tag_id: "sample-t2" },
          { card_id: "sample-c2", tag_id: "sample-t1" },
        ],
        links: [
          {
            source_id: "sample-c2",
            target_id: "sample-c1",
            relation_type: "support",
            status: "confirmed",
            reason: "改善胸椎活動度可支持肩胛力學穩定",
          },
        ],
        boards: [{ id: "sample-b1", name: "肩膀臨床評估專題" }],
        board_cards: [
          { board_id: "sample-b1", card_id: "sample-c1", x: 100, y: 100 },
          { board_id: "sample-b1", card_id: "sample-c2", x: 420, y: 100 },
        ],
      };
      if (typeof storage.importPackageOverwrite === "function") {
        await storage.importPackageOverwrite(demoPkg);
        info("已成功載入示範資料！已建立收納抽屜、概念標籤與關聯卡片。");
        onRefresh();
      }
    } catch (e) {
      report(e, "載入示範資料失敗");
    }
  };

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
      info("已匯出 iPad 變更檔案，可透過 AirDrop 傳送至電腦端合併。");
    } catch (e) {
      report(e, "匯出失敗");
    } finally {
      setExporting(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!window.confirm("確定要匯入此備份嗎？\n這將會完全覆蓋此 iPad 上的所有本機卡片與標籤！")) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    setImporting(true);
    try {
      const text = await file.text();
      const pkg = JSON.parse(text) as SyncPackage;
      if (!pkg || !Array.isArray(pkg.cards)) throw new Error("無效的備份檔案格式");
      if (typeof storage.importPackageOverwrite === "function") {
        await storage.importPackageOverwrite(pkg);
        info(`已完成還原！已同步載入 ${pkg.cards.length} 張卡片。`);
        onRefresh();
      }
    } catch (err) {
      report(err, "匯入覆蓋失敗");
    } finally {
      setImporting(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const startP2PSend = async () => {
    const code = pairingCodeInput.trim();
    if (!code || code.length !== 6) {
      alert("請輸入電腦畫面上顯示的 6 位數連線碼");
      return;
    }

    setP2pSending(true);
    try {
      const pkg = await storage.syncExport();
      sendP2PPackage(
        code,
        pkg,
        () => {
          setP2pSending(false);
          setP2pModalOpen(false);
          setPairingCodeInput("");
          info("⚡ 傳送成功！電腦端已收到同步封包，請在電腦端確認合併。");
        },
        (err) => {
          setP2pSending(false);
          report(err, "P2P 配對失敗，請確認電腦端是否已開啟配對視窗且連線碼正確");
        },
      );
    } catch (e) {
      setP2pSending(false);
      report(e, "讀取封包失敗");
    }
  };

  const startP2PPull = () => {
    const code = pairingCodeInput.trim();
    if (!code || code.length !== 6) {
      alert("請輸入電腦畫面上顯示的 6 位數連線碼");
      return;
    }

    if (!window.confirm("確定要從電腦下載完整資料嗎？\n這將會完全覆蓋此 iPad 上的所有本機卡片與標籤！")) {
      return;
    }

    setP2pSending(true);
    import("../lib/p2p").then(({ pullP2PPackageFromPc }) => {
      pullP2PPackageFromPc(
        code,
        async (pcPkg) => {
          try {
            if (typeof storage.importPackageOverwrite === "function") {
              await storage.importPackageOverwrite(pcPkg);
              info(`⚡ 同步成功！已載入電腦端 ${pcPkg.cards.length} 張卡片與所有抽屜！`);
              setP2pSending(false);
              setP2pModalOpen(false);
              setPairingCodeInput("");
              onRefresh();
            }
          } catch (e) {
            setP2pSending(false);
            report(e, "寫入 iPad 本機資料庫失敗");
          }
        },
        (err) => {
          setP2pSending(false);
          report(err, "P2P 連線失敗，請確認電腦端是否已開啟配對接收且連線碼正確");
        },
      );
    });
  };

  return (
    <div className="ipad-view">
      <div className="ipad-toolbar">
        <div className="ipad-toolbar-left">
          <span className="ipad-badge">iPad 卡片冊</span>
          {activeBoard ? (
            <span style={{ fontWeight: 600, color: "var(--accent)" }}>
              白板：{activeBoard.name}（{cards.length}）
            </span>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>全部卡片（{cards.length}）</span>
          )}
        </div>
        <div className="ipad-toolbar-actions">
          <button
            type="button"
            className="touch-btn primary"
            style={{ background: "#10b981", borderColor: "#10b981" }}
            onClick={() => setP2pModalOpen(true)}
            title="輸入電腦連線碼，免傳檔案直接對接傳送"
          >
            ⚡ P2P 傳送到電腦
          </button>
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
            ＋ {activeBoard ? `在「${activeBoard.name.slice(0, 6)}」新增` : "新增卡片"}
          </button>
        </div>
      </div>

      <div className="ipad-card-grid">
        {cards.length === 0 && (
          <div className="empty" style={{ gridColumn: "1 / -1", textAlign: "center", padding: "40px 0" }}>
            <p>目前尚無卡片。</p>
            <div style={{ display: "flex", gap: 10, justifyContent: "center", marginTop: 12 }}>
              <button type="button" className="touch-btn primary" onClick={onCreateCard}>
                ＋ 立即新增第一張卡片
              </button>
              <button type="button" className="touch-btn" onClick={() => void loadSampleData()}>
                載入示範卡片與抽屜標籤
              </button>
            </div>
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

      {p2pModalOpen && (
        <div className="modal" role="dialog" aria-label="P2P 直連配對傳送">
          <div className="modal-card" style={{ maxWidth: 360 }}>
            <h4>⚡ P2P 直連傳送到電腦</h4>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              請在電腦版點擊「同步／備份」➔「開啟 P2P 配對接收」，並在此輸入電腦畫面上顯示的 6 位數連線碼：
            </p>
            <input
              type="text"
              pattern="[0-9]*"
              maxLength={6}
              value={pairingCodeInput}
              onChange={(e) => setPairingCodeInput(e.target.value.replace(/\D/g, ""))}
              placeholder="例如：839201"
              autoFocus
              style={{ fontSize: 22, textAlign: "center", letterSpacing: 4, padding: "8px 0" }}
            />
            <div className="modal-actions" style={{ flexDirection: "column", gap: 8, marginTop: 12 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <button
                  type="button"
                  className="primary"
                  style={{ background: "#2563eb", borderColor: "#2563eb", padding: "10px 6px" }}
                  onClick={startP2PPull}
                  disabled={p2pSending || pairingCodeInput.length !== 6}
                  title="從電腦下載所有卡片與抽屜，完全覆蓋 iPad"
                >
                  {p2pSending ? "傳輸中…" : "📥 覆蓋同步到 iPad"}
                </button>
                <button
                  type="button"
                  className="primary"
                  style={{ background: "#10b981", borderColor: "#10b981", padding: "10px 6px" }}
                  onClick={() => void startP2PSend()}
                  disabled={p2pSending || pairingCodeInput.length !== 6}
                  title="將 iPad 新寫的卡片發給電腦合併"
                >
                  {p2pSending ? "傳輸中…" : "📤 發送變更給電腦"}
                </button>
              </div>
              <button type="button" onClick={() => setP2pModalOpen(false)} disabled={p2pSending}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}