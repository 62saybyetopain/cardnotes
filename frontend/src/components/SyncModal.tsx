// @depends-on ../api.ts (api)
// @depends-on ../lib/media.ts (mediaUrl)
// @depends-on ../lib/p2p.ts (getSavedCloudCredential, pullIpadPackageFromCloud, pullP2PPackageFromPc, saveCloudCredential, sendP2PPackage, uploadPcBackupToCloud)
// @depends-on ../lib/storage/index.ts (getPreferredDriverType, storage)
// @depends-on ../types.ts (CardDetail, SyncPackage, SyncDiffReport, SyncCardDiff)
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { mediaUrl } from "../lib/media";
import {
  getSavedCloudCredential,
  pullIpadPackageFromCloud,
  pullP2PPackageFromPc,
  saveCloudCredential,
  sendP2PPackage,
  uploadPcBackupToCloud,
} from "../lib/p2p";
import { getPreferredDriverType, storage } from "../lib/storage";
import type { CardDetail, SyncCardDiff, SyncDiffReport, SyncPackage } from "../types";

interface Props {
  onClose(): void;
  onApplied(): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

const IPAD_BASELINE_KEY = "cardboard:ipad-sync-baseline";

interface IpadSyncBaseline {
  imported_at: string;
  backup_exported_at: string;
  card_signatures: Record<string, string>;
}

function cardSignature(c: CardDetail, cardTags: { card_id: string; tag_id: string }[]): string {
  const tids = cardTags
    .filter((ct) => ct.card_id === c.id)
    .map((ct) => ct.tag_id)
    .sort()
    .join(",");
  return `${c.updated_at}|${c.title}|${tids}`;
}

function loadIpadBaseline(): IpadSyncBaseline | null {
  try {
    const raw = localStorage.getItem(IPAD_BASELINE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as IpadSyncBaseline;
    if (parsed && typeof parsed.imported_at === "string") return parsed;
  } catch {
    /* 忽略損毀資料 */
  }
  return null;
}

function saveIpadBaseline(pkg: SyncPackage): IpadSyncBaseline {
  const sigs: Record<string, string> = {};
  const cts = pkg.card_tags ?? [];
  for (const c of pkg.cards ?? []) {
    sigs[c.id] = cardSignature(c, cts);
  }
  const baseline: IpadSyncBaseline = {
    imported_at: new Date().toISOString(),
    backup_exported_at: pkg.exported_at || new Date().toISOString(),
    card_signatures: sigs,
  };
  try {
    localStorage.setItem(IPAD_BASELINE_KEY, JSON.stringify(baseline));
  } catch {
    /* 忽略 localStorage 寫入失敗 */
  }
  return baseline;
}

function toDatetimeLocalValue(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function overwriteIpadLocal(pkg: SyncPackage): Promise<boolean> {
  if (typeof storage.importPackageOverwrite !== "function" || typeof storage.findLocalOnlyCards !== "function") {
    throw new Error("目前儲存驅動不是 IndexedDB（dexie），無法執行 iPad 覆蓋匯入。");
  }
  const localOnly = await storage.findLocalOnlyCards(pkg);
  if (localOnly.length > 0) {
    const shown = localOnly
      .slice(0, 5)
      .map((c) => "・" + (c.title || "（無標題）"))
      .join("\n");
    const rest = localOnly.length > 5 ? "\n…另有 " + String(localOnly.length - 5) + " 張" : "";
    const proceed = window.confirm(
      "此 iPad 上有 " +
        String(localOnly.length) +
        " 張卡片不在要覆蓋的電腦備份中：\n" +
        shown +
        rest +
        "\n\n繼續覆蓋會永久刪除它們。\n按「確定」繼續覆蓋，按「取消」中止（iPad 資料不會變動）。",
    );
    if (!proceed) return false;
  }
  await storage.importPackageOverwrite(pkg);
  return true;
}

export function SyncModal({ onClose, onApplied, report, info }: Props) {
  const isIpad = getPreferredDriverType() === "dexie";

  // 共用金鑰與雲端忙碌狀態
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudCredential, setCloudCredential] = useState(() => getSavedCloudCredential());
  const [showKeyInput, setShowKeyInput] = useState(() => !getSavedCloudCredential());
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---- 電腦版專用狀態 ----
  const [pkg, setPkg] = useState<SyncPackage | null>(null);
  const [diff, setDiff] = useState<SyncDiffReport | null>(null);
  const [comparing, setComparing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [selectedNewCardIds, setSelectedNewCardIds] = useState<Set<string>>(new Set());
  const [selectedUpdateCardIds, setSelectedUpdateCardIds] = useState<Set<string>>(new Set());
  const [viewingDiffCard, setViewingDiffCard] = useState<SyncCardDiff | null>(null);

  // ---- iPad 版專用狀態（時間戳過濾與匯出預覽） ----
  const [ipadFullPkg, setIpadFullPkg] = useState<SyncPackage | null>(null);
  const [ipadBaseline, setIpadBaseline] = useState<IpadSyncBaseline | null>(() => loadIpadBaseline());
  const [onlyChangedAfterBaseline, setOnlyChangedAfterBaseline] = useState<boolean>(true);
  const [customCutoffLocal, setCustomCutoffLocal] = useState<string>(() => {
    const b = loadIpadBaseline();
    return b ? toDatetimeLocalValue(b.imported_at) : "";
  });

  const loadIpadCurrentPackage = useCallback(async () => {
    if (!isIpad) return;
    try {
      const data = await storage.syncExport();
      setIpadFullPkg(data);
    } catch (e) {
      report(e, "讀取 iPad 本機資料失敗");
    }
  }, [isIpad, report]);

  useEffect(() => {
    void loadIpadCurrentPackage();
  }, [loadIpadCurrentPackage]);

  // 計算 iPad 篩選後要匯出的卡片與封包
  const ipadFilteredExport = useMemo((): { pkg: SyncPackage | null; matchedCards: CardDetail[]; totalCount: number } => {
    if (!ipadFullPkg) return { pkg: null, matchedCards: [], totalCount: 0 };
    const allCards = ipadFullPkg.cards ?? [];
    const allCts = ipadFullPkg.card_tags ?? [];
    if (!onlyChangedAfterBaseline) {
      return { pkg: ipadFullPkg, matchedCards: allCards, totalCount: allCards.length };
    }

    const cutoffMs = customCutoffLocal ? new Date(customCutoffLocal).getTime() : NaN;
    const baselineLocalStr = ipadBaseline ? toDatetimeLocalValue(ipadBaseline.imported_at) : "";
    const isUsingExactBaseline = Boolean(ipadBaseline && customCutoffLocal === baselineLocalStr);

    const matchedCards = allCards.filter((c) => {
      // 1. 若有上次匯入備份的卡片簽章快照，且時間戳維持為上次匯入時間：直接比對是否為新增卡片或內容／標籤有異動
      if (isUsingExactBaseline && ipadBaseline) {
        const prevSig = ipadBaseline.card_signatures[c.id];
        if (!prevSig) return true; // 匯入備份後在 iPad 新建的卡片
        const curSig = cardSignature(c, allCts);
        if (curSig !== prevSig) return true; // 匯入備份後在 iPad 修改過內文、標題或標籤的卡片
        return false;
      }
      // 2. 若使用者手動調整了時間戳（或無快照僅有時間戳）：比對 created_at 或 updated_at 是否晚於該時間戳
      if (Number.isFinite(cutoffMs)) {
        const uMs = new Date(c.updated_at).getTime();
        const cMs = new Date(c.created_at).getTime();
        return uMs > cutoffMs || cMs > cutoffMs;
      }
      return true;
    });

    const matchedIds = new Set(matchedCards.map((c) => c.id));
    const filteredPkg: SyncPackage = {
      ...ipadFullPkg,
      exported_at: new Date().toISOString(),
      cards: matchedCards,
      // 僅附帶這些新增／修改卡片的標籤關聯，避免未修改舊卡片的舊標籤覆寫回電腦端
      card_tags: allCts.filter((ct) => matchedIds.has(ct.card_id)),
    };
    return { pkg: filteredPkg, matchedCards, totalCount: allCards.length };
  }, [customCutoffLocal, ipadBaseline, ipadFullPkg, onlyChangedAfterBaseline]);

  // ============================================================
  // iPad 專用操作：1. 從 Drive（或檔案）拉取電腦備份同步  2. 匯出／上傳 iPad 變更
  // ============================================================
  const handleIpadPullFromDrive = () => {
    const cred = cloudCredential.trim();
    if (!cred) {
      setShowKeyInput(true);
      report(new Error("請先填入 Google Drive 雲端金鑰"), "雲端同步");
      return;
    }
    if (!window.confirm("確定要從 Google Drive 拉取電腦版備份進行同步嗎？\n這將會覆蓋此 iPad 上的本機資料，並記錄本次同步時間戳。")) {
      return;
    }
    saveCloudCredential(cred);
    setCloudBusy(true);
    pullP2PPackageFromPc(
      cred,
      async (pcPkg) => {
        try {
          if (!(await overwriteIpadLocal(pcPkg))) {
            setCloudBusy(false);
            info("已取消同步，iPad 資料沒有任何變動。");
            return;
          }
          const newBase = saveIpadBaseline(pcPkg);
          setIpadBaseline(newBase);
          setCustomCutoffLocal(toDatetimeLocalValue(newBase.imported_at));
          await loadIpadCurrentPackage();
          setCloudBusy(false);
          info(`☁️ 已從 Drive 同步電腦版備份（共 ${pcPkg.cards.length} 張卡片），並已記錄基準時間戳！`);
          onApplied();
          onClose();
        } catch (e) {
          setCloudBusy(false);
          report(e, "寫入 iPad 本機資料庫失敗");
        }
      },
      (err) => {
        setCloudBusy(false);
        report(err, "從 Google Drive 拉取電腦備份失敗");
      },
    );
  };

  const handleIpadImportBackupFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!window.confirm("確定要匯入此電腦備份檔嗎？\n這將會覆蓋此 iPad 上的本機資料，並記錄本次匯入時間戳。")) {
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setCloudBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SyncPackage;
      if (!parsed || !Array.isArray(parsed.cards)) {
        throw new Error("無效的備份檔案格式（缺少 cards 陣列）");
      }
      if (!(await overwriteIpadLocal(parsed))) {
        info("已取消匯入，iPad 資料沒有任何變動。");
        return;
      }
      const newBase = saveIpadBaseline(parsed);
      setIpadBaseline(newBase);
      setCustomCutoffLocal(toDatetimeLocalValue(newBase.imported_at));
      await loadIpadCurrentPackage();
      info(`📥 已匯入電腦備份（共 ${parsed.cards.length} 張卡片），並已記錄基準時間戳！`);
      onApplied();
      onClose();
    } catch (err) {
      report(err, "匯入電腦備份檔失敗");
    } finally {
      setCloudBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleIpadUploadToDrive = () => {
    const cred = cloudCredential.trim();
    if (!cred) {
      setShowKeyInput(true);
      report(new Error("請先填入 Google Drive 雲端金鑰"), "上傳 iPad 資料");
      return;
    }
    if (!ipadFilteredExport.pkg) return;
    saveCloudCredential(cred);
    setCloudBusy(true);
    sendP2PPackage(
      cred,
      ipadFilteredExport.pkg,
      () => {
        setCloudBusy(false);
        info(
          `☁️ 已將 iPad 資料（${ipadFilteredExport.matchedCards.length} 張新增／修改卡片）上傳至 Google Drive！請在電腦版點選「拉取 iPad 資料」合併。`,
        );
        onClose();
      },
      (err) => {
        setCloudBusy(false);
        report(err, "上傳 iPad 資料至 Google Drive 失敗");
      },
    );
  };

  const handleIpadExportJson = () => {
    if (!ipadFilteredExport.pkg) return;
    try {
      const blob = new Blob([JSON.stringify(ipadFilteredExport.pkg, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = `cardboard-ipad-sync-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(url);
      info(`📤 已匯出 iPad 資料 JSON（含 ${ipadFilteredExport.matchedCards.length} 張卡片）。`);
    } catch (e) {
      report(e, "匯出 iPad JSON 失敗");
    }
  };

  // ============================================================
  // 電腦版專用操作：1. 匯出 JSON 備份  2. 上傳雲端備份  3. 拉取 iPad 資料
  // ============================================================
  const handleUploadPcBackupToCloud = async () => {
    const cred = cloudCredential.trim();
    if (!cred) {
      setShowKeyInput(true);
      report(new Error("請先填入 Google Drive 雲端金鑰"), "雲端備份");
      return;
    }
    setCloudBusy(true);
    try {
      saveCloudCredential(cred);

      const pcData = await api.syncExport();
      const loadBlob = async (id: string): Promise<Blob | null> => {
        const res = await fetch(mediaUrl(id));
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`讀取電腦端圖片 ${id} 失敗 (${res.status})`);
        return await res.blob();
      };
      const rep = await uploadPcBackupToCloud(pcData, cred, loadBlob);
      const imgNote = rep.total > 0 ? `、${rep.total} 張圖片（本次新上傳 ${rep.uploaded} 張）` : "";
      info(`☁️ 已成功將電腦端完整備份（${pcData.cards.length} 張卡片${imgNote}）上傳至 Google Drive！iPad 現在可隨時拉取同步。`);
      if (rep.missing.length > 0) {
        report(
          new Error(
            `有 ${rep.missing.length} 張圖片在電腦端找不到檔案，未上傳（編號開頭：${rep.missing
              .slice(0, 3)
              .map((m) => m.slice(0, 8))
              .join("、")}）`,
          ),
          "圖片備份不完整",
        );
      }
    } catch (err) {
      report(err, "上傳電腦備份至 Google Drive 失敗");
    } finally {
      setCloudBusy(false);
    }
  };

  const handlePullIpadFromCloud = async () => {
    const cred = cloudCredential.trim();
    if (!cred) {
      setShowKeyInput(true);
      report(new Error("請先填入 Google Drive 雲端金鑰"), "雲端同步");
      return;
    }
    setCloudBusy(true);
    setComparing(true);
    setDiff(null);
    setViewingDiffCard(null);
    try {
      saveCloudCredential(cred);
      const receivedPkg = await pullIpadPackageFromCloud(cred);
      setPkg(receivedPkg);
      const res: SyncDiffReport = await api.syncDiff(receivedPkg);
      setDiff(res);
      setSelectedNewCardIds(new Set(res.cards_new.map((c: { id: string }) => c.id)));
      setSelectedUpdateCardIds(new Set(res.cards_updated.map((c: SyncCardDiff) => c.id)));
      info(`☁️ 已從 Google Drive 載入 iPad 資料：${res.cards_new.length} 張新增、${res.cards_updated.length} 張待更新`);
    } catch (err) {
      report(err, "從 Google Drive 拉取 iPad 資料失敗");
    } finally {
      setCloudBusy(false);
      setComparing(false);
    }
  };

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
      diff.card_tags_new.length === 0 &&
      diff.board_cards_new.length === 0
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
        tag_ids_to_update: [], // 標籤沒有修改時間，無法判斷誰較新；套用會讓 iPad 的舊值回退電腦端的新改動
        card_tags_to_add: diff.card_tags_new,
        links_to_add: diff.links_new,
        board_cards_to_add: diff.board_cards_new,
        package: pkg,
      });
      const notes: string[] = [];
      if (res.applied.tags_merged) notes.push(`${res.applied.tags_merged} 個同名標籤已併入電腦端既有標籤`);
      if (res.applied.boards_created) notes.push(`已建立 ${res.applied.boards_created} 塊新白板`);
      if (res.applied.board_cards_skipped) {
        notes.push(`⚠️ ${res.applied.board_cards_skipped} 筆白板歸屬因電腦端沒有對應白板而未套用`);
      }
      info(
        `同步成功！新增 ${res.applied.cards_added} 張、更新 ${res.applied.cards_updated} 張、建立 ${res.applied.links_added} 條連結${notes.length > 0 ? "；" + notes.join("；") : ""}`,
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
          <h4>{isIpad ? "📱 iPad 資料同步與匯出" : "💻 電腦版資料同步與備份"}</h4>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <button
              type="button"
              onClick={() => setShowKeyInput((v) => !v)}
              title="設定或檢視 Google Drive 金鑰"
            >
              🔑 金鑰設定
            </button>
            <button type="button" onClick={onClose} aria-label="關閉視窗">
              ✕
            </button>
          </div>
        </div>

        {showKeyInput && (
          <div className="p2p-banner" style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 13 }}>Google Drive 金鑰（<code>CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN</code>）：</span>
            <input
              type="password"
              value={cloudCredential}
              onChange={(e) => {
                setCloudCredential(e.target.value);
                saveCloudCredential(e.target.value);
              }}
              placeholder="貼上金鑰（輸入一次即自動記憶於本機）"
              style={{ flex: 1, minWidth: 240, padding: "6px 8px" }}
            />
          </div>
        )}

        {isIpad ? (
          /* ==================== iPad 專屬介面 ==================== */
          <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 6 }}>
            <div className="resolve-box" style={{ padding: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                1. 從電腦版備份同步至 iPad（整庫覆蓋）
              </div>
              <p className="muted" style={{ margin: "0 0 10px 0", fontSize: 12 }}>
                從 Google Drive 拉取電腦版匯出的最新備份並同步至 iPad。同步完成後會自動記錄時間戳，作為後續匯出 iPad 新增／修改卡片的基準。
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  className="primary"
                  style={{ background: "#2563eb", borderColor: "transparent" }}
                  onClick={handleIpadPullFromDrive}
                  disabled={cloudBusy}
                >
                  {cloudBusy ? "雲端傳輸中…" : "☁️ 從 Drive 拉取電腦版備份同步"}
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={cloudBusy}
                >
                  📥 選取電腦備份檔 (.json) 同步…
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: "none" }}
                  onChange={(e) => void handleIpadImportBackupFile(e)}
                />
              </div>
            </div>

            <div className="resolve-box" style={{ padding: 12 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>
                2. 匯出 iPad 資料（依時間戳篩選新增或修改的卡片）
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                <label className="sync-check-row" style={{ fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={onlyChangedAfterBaseline}
                    onChange={(e) => setOnlyChangedAfterBaseline(e.target.checked)}
                  />
                  <span>僅匯出匯入備份時間戳之後建立或修改的卡片</span>
                </label>

                {onlyChangedAfterBaseline && (
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontSize: 12 }}>
                    <span className="muted">基準時間戳：</span>
                    <input
                      type="datetime-local"
                      step={1}
                      value={customCutoffLocal}
                      onChange={(e) => setCustomCutoffLocal(e.target.value)}
                      style={{ padding: "4px 6px", fontSize: 12 }}
                    />
                    {ipadBaseline && (
                      <button
                        type="button"
                        style={{ fontSize: 11, padding: "2px 6px" }}
                        onClick={() => setCustomCutoffLocal(toDatetimeLocalValue(ipadBaseline.imported_at))}
                        title="重設為上次匯入電腦備份的時間"
                      >
                        重設為上次匯入備份時間
                      </button>
                    )}
                    {!ipadBaseline && !customCutoffLocal && (
                      <span className="muted">（尚無匯入備份紀錄，可手動指定時間戳或直接匯出全部）</span>
                    )}
                  </div>
                )}

                <div className="sync-summary-bar" style={{ marginTop: 2 }}>
                  <span>
                    符合條件：<strong>{ipadFilteredExport.matchedCards.length}</strong> 張卡片
                    <span className="muted">（iPad 全庫共 {ipadFilteredExport.totalCount} 張）</span>
                  </span>
                </div>

                {onlyChangedAfterBaseline && ipadFilteredExport.matchedCards.length > 0 && (
                  <div className="sync-diff-list" style={{ maxHeight: 150, overflow: "auto" }}>
                    {ipadFilteredExport.matchedCards.map((c) => {
                      const isNewAfterBaseline = ipadBaseline && !ipadBaseline.card_signatures[c.id];
                      return (
                        <div key={c.id} className="sync-diff-item">
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span
                              className="facet-badge"
                              style={{
                                background: isNewAfterBaseline ? "rgba(16, 185, 129, 0.15)" : "rgba(59, 130, 246, 0.15)",
                                color: isNewAfterBaseline ? "#10b981" : "#3b82f6",
                              }}
                            >
                              {isNewAfterBaseline ? "新增" : "修改"}
                            </span>
                            <strong>{c.title || "（無標題）"}</strong>
                          </div>
                          <span className="muted" style={{ fontSize: 11 }}>
                            {new Date(c.updated_at).toLocaleString()}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                  <button
                    type="button"
                    className="primary"
                    style={{ background: "#10b981", borderColor: "transparent" }}
                    onClick={handleIpadUploadToDrive}
                    disabled={cloudBusy || ipadFilteredExport.matchedCards.length === 0}
                    title="將篩選後的 iPad 變更上傳至 Google Drive，供電腦版拉取合併"
                  >
                    {cloudBusy ? "雲端傳輸中…" : `☁️ 上傳 iPad 資料至 Drive（${ipadFilteredExport.matchedCards.length} 張）`}
                  </button>
                  <button
                    type="button"
                    onClick={handleIpadExportJson}
                    disabled={cloudBusy || ipadFilteredExport.matchedCards.length === 0}
                  >
                    📤 匯出 iPad 資料 (.json)
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-actions">
              <button type="button" onClick={onClose} disabled={cloudBusy}>
                關閉
              </button>
            </div>
          </div>
        ) : (
          /* ==================== 電腦版專屬介面 ==================== */
          <>
            <div className="sync-top-actions">
              <button type="button" onClick={() => void exportBackup()}>
                1. 📥 匯出 JSON 備份
              </button>
              <button
                type="button"
                className="primary"
                style={{ background: "#2563eb", borderColor: "transparent" }}
                onClick={() => void handleUploadPcBackupToCloud()}
                disabled={cloudBusy}
                title="將電腦完整資料庫上傳至 Google Drive，供 iPad 隨時下載覆蓋"
              >
                {cloudBusy ? "雲端處理中…" : "2. ☁️ 上傳雲端備份 (供 iPad 下載)"}
              </button>
              <button
                type="button"
                className="primary"
                style={{ background: "#10b981", borderColor: "transparent" }}
                onClick={() => void handlePullIpadFromCloud()}
                disabled={cloudBusy}
                title="從 Google Drive 讀取 iPad 發送的資料並進行差異比對（卡片、白板、標籤、連結）"
              >
                {cloudBusy ? "雲端處理中…" : "3. ☁️ 拉取 iPad 資料 (Drive)"}
              </button>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={cloudBusy}
                title="選取 iPad 匯出的 JSON 檔案進行差異比對與合併"
              >
                📂 選取 iPad JSON 檔比對…
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
                  <span>來源裝置：<strong>{diff.source_device || "iPad"}</strong></span>
                  <span>封包時間：{new Date(diff.exported_at).toLocaleString()}</span>
                  <span className="count">略過未變更／較舊卡片：{diff.cards_unchanged_count} 張</span>
                </div>

                {diff.tags_updated.length > 0 && (
                  <div className="muted" style={{ fontSize: 12, padding: "6px 0" }}>
                    ⚠️ {diff.tags_updated.length} 個標籤在 iPad 與電腦端內容不同，本次<strong>不會套用</strong>
                    （標籤沒有修改時間，無法判斷哪邊較新）：{diff.tags_updated.map((t) => t.name).join("、")}
                  </div>
                )}
                {!hasChanges ? (
                  <div className="empty">沒有可套用的變更。</div>
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
                        全選所有卡片變更（{diff.cards_new.length + diff.cards_updated.length} 張卡片）
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
                                <div className="diff-pane-head">iPad 新內容</div>
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
                  disabled={
                    applying ||
                    (selectedNewCardIds.size === 0 &&
                      selectedUpdateCardIds.size === 0 &&
                      diff.tags_new.length === 0 &&
                      diff.links_new.length === 0 &&
                      diff.card_tags_new.length === 0 &&
                      diff.board_cards_new.length === 0)
                  }
                  onClick={() => void applyChanges()}
                >
                  {applying ? "套用中…" : `確認套用所選變更（${selectedNewCardIds.size + selectedUpdateCardIds.size} 張卡片）`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}