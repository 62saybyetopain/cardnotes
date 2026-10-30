// @depends-on ../api.ts (api)
// @depends-on ../lib/media.ts (mediaUrl)
// @depends-on ../lib/p2p.ts (getSavedCloudCredential, pullIpadPackageFromCloud, pullP2PPackageFromPc, saveCloudCredential, sendP2PPackage, uploadPcBackupToCloud)
// @depends-on ../lib/storage/index.ts (getPreferredDriverType, storage)
// @depends-on ../lib/storage/index.ts (getPreferredDriverType, storage)
// @depends-on ../types.ts (CARD_TYPE_LABELS, CardDetail, CardType, SyncPackage, SyncDiffReport, SyncCardDiff)
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
import {
  CARD_TYPE_LABELS,
  type CardDetail,
  type CardType,
  type SyncCardDiff,
  type SyncDiffReport,
  type SyncPackage,
} from "../types";

type ExtendedCardDiff = SyncCardDiff & {
  old_card_type?: string;
  new_card_type?: string;
  old_curation_status?: string;
  new_curation_status?: string;
  old_tags?: string[];
  new_tags?: string[];
  old_links?: string[];
  new_links?: string[];
  diff_fields?: string[];
  is_newer?: boolean;
};

function isCardNewer(c: ExtendedCardDiff): boolean {
  if (typeof c.is_newer === "boolean") return c.is_newer;
  return (c.new_updated_at || "") > (c.old_updated_at || "");
}

function formatSyncTime(iso: string | undefined): string {
  if (!iso) return "未知時間";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function formatCardType(t: string | undefined): string {
  if (!t) return "未分類";
  return CARD_TYPE_LABELS[t as CardType] ?? t;
}

function formatCuration(s: string | undefined): string {
  return s === "curated" ? "✓ 已整理" : "📥 待整理（收件夾）";
}

interface Props {
  onClose(): void;
  onApplied(): void;
  report(e: unknown, prefix?: string): void;
  info(text: string): void;
}

export const AUTO_BACKUP_CONFIG_KEY = "cardboard:auto-backup-config";
export const LAST_BACKUP_TIME_KEY = "cardboard:last-auto-backup-time";

export interface AutoBackupConfig {
  enabled: boolean;
  targetPath: string;
  scheduleType: "daily" | "interval";
  dailyTime: string; // "HH:mm"
  intervalHours: number; // 例如 4 小時
}

export function loadAutoBackupConfig(): AutoBackupConfig {
  try {
    const raw = localStorage.getItem(AUTO_BACKUP_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* 忽略損毀設定 */
  }
  return {
    enabled: false,
    targetPath: "",
    scheduleType: "daily",
    dailyTime: "22:00",
    intervalHours: 4,
  };
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

// 同步完成提示用：讓使用者一眼看出拉到的備份是否過期
function describeBackup(pkg: SyncPackage): string {
  const inbox = pkg.cards.filter((c) => (c.curation_status ?? "inbox") === "inbox").length;
  const t = pkg.exported_at ? new Date(pkg.exported_at).toLocaleString() : "未知";
  return `共 ${pkg.cards.length} 張卡片，其中 ${inbox} 張待整理；備份時間 ${t}`;
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
  const overwriteInputRef = useRef<HTMLInputElement>(null);

  // 定時自動備份設定
  const [autoBackupCfg, setAutoBackupCfg] = useState<AutoBackupConfig>(loadAutoBackupConfig);
  const [lastBackupTime, setLastBackupTime] = useState<string>(() => localStorage.getItem(LAST_BACKUP_TIME_KEY) || "");
  const [savingBackupNow, setSavingBackupNow] = useState(false);
  const [pickingBackupPath, setPickingBackupPath] = useState(false);

  const saveBackupSettings = (patch: Partial<AutoBackupConfig>) => {
    setAutoBackupCfg((prev) => {
      const next = { ...prev, ...patch };
      localStorage.setItem(AUTO_BACKUP_CONFIG_KEY, JSON.stringify(next));
      return next;
    });
  };

  const handlePickBackupPath = async () => {
    if (pickingBackupPath) return;
    setPickingBackupPath(true);
    try {
      const res = await api.pickSystemFile({
        mode: "save",
        title: "選擇定時自動備份儲存檔案 (.json)",
        initial_path: autoBackupCfg.targetPath || null,
        default_name: "cardboard_auto_backup.json",
      });
      if (!res.cancelled && res.path) {
        saveBackupSettings({ targetPath: res.path });
        info(`📁 已設定定時備份檔案位置：${res.path}`);
      }
    } catch (err) {
      report(err, "選取備份檔案位置失敗");
    } finally {
      setPickingBackupPath(false);
    }
  };

  const handleManualBackupNow = async () => {
    if (!autoBackupCfg.targetPath.trim()) {
      report(new Error("請先填寫本機固定備份檔案的完整路徑"), "固定路徑備份");
      return;
    }
    setSavingBackupNow(true);
    try {
      const res = await api.syncSaveToFile(autoBackupCfg.targetPath.trim());
      localStorage.setItem(LAST_BACKUP_TIME_KEY, res.exported_at);
      setLastBackupTime(res.exported_at);
      info(`💾 已成功覆寫備份至本機固定檔案：${res.path}`);
    } catch (err) {
      report(err, "手動覆寫備份失敗");
    } finally {
      setSavingBackupNow(false);
    }
  };

  const handlePcOverwriteImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (
      !window.confirm(
        "⚠️ 【警告：完整覆蓋還原】\n" +
          "此動作將會【完全清空】目前電腦端的資料庫，並以選取的備份檔案 100% 取代！\n" +
          "包含卡片、標籤、白板、分組框與關係句型皆會被此檔案完全覆寫。\n\n" +
          "確定要繼續覆蓋還原嗎？",
      )
    ) {
      if (overwriteInputRef.current) overwriteInputRef.current.value = "";
      return;
    }
    setApplying(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SyncPackage;
      if (!parsed || !Array.isArray(parsed.cards)) {
        throw new Error("無效的備份檔案格式（缺少 cards 陣列）");
      }
      const res = await api.syncOverwrite(parsed);
      info(`🎉 完整還原成功！已由備份檔重組 ${res.cards_count} 張卡片與資料庫結構。`);
      onApplied();
      onClose();
    } catch (err) {
      report(err, "本機完整覆蓋還原失敗");
    } finally {
      setApplying(false);
      if (overwriteInputRef.current) overwriteInputRef.current.value = "";
    }
  };

  // ---- 電腦版專用狀態 ----
  const [pkg, setPkg] = useState<SyncPackage | null>(null);
  const [diff, setDiff] = useState<SyncDiffReport | null>(null);
  const [activeTab, setActiveTab] = useState<"new" | "updated">("new");
  const [comparing, setComparing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [selectedNewCardIds, setSelectedNewCardIds] = useState<Set<string>>(new Set());
  const [selectedUpdateCardIds, setSelectedUpdateCardIds] = useState<Set<string>>(new Set());
  const [expandedDiffIds, setExpandedDiffIds] = useState<Set<string>>(new Set());

  const initDiffSelection = (res: SyncDiffReport) => {
    setDiff(res);
    setSelectedNewCardIds(new Set(res.cards_new.map((c: { id: string }) => c.id)));
    // 自動勾選匯入檔較新的卡片
    const newerIds = (res.cards_updated as ExtendedCardDiff[])
      .filter((c) => isCardNewer(c))
      .map((c) => c.id);
    setSelectedUpdateCardIds(new Set(newerIds));
    setExpandedDiffIds(new Set());
    if (res.cards_new.length === 0 && res.cards_updated.length > 0) {
      setActiveTab("updated");
    } else {
      setActiveTab("new");
    }
  };

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
          info(`☁️ 已從 Drive 同步電腦版備份（${describeBackup(pcPkg)}）。若與電腦端不符，請先在電腦版重新「上傳雲端備份」。`);
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
      info(`📥 已匯入電腦備份（${describeBackup(parsed)}）。若與電腦端不符，請先在電腦版重新匯出備份。`);
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

  const handleIpadExportJson = (fullBackup = false) => {
    const targetPkg = fullBackup ? ipadFullPkg : ipadFilteredExport.pkg;
    if (!targetPkg) return;
    try {
      const blob = new Blob([JSON.stringify(targetPkg, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      a.href = url;
      a.download = fullBackup
        ? `cardboard-full-backup-${dateStr}.json`
        : `cardboard-ipad-sync-${dateStr}.json`;
      a.click();
      URL.revokeObjectURL(url);
      info(
        fullBackup
          ? `📥 已匯出完整全庫備份 JSON（含全部 ${targetPkg.cards.length} 張卡片）。`
          : `📤 已匯出篩選變更 JSON（含 ${targetPkg.cards.length} 張卡片）。`,
      );
    } catch (e) {
      report(e, "匯出 JSON 失敗");
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
    try {
      saveCloudCredential(cred);
      const receivedPkg = await pullIpadPackageFromCloud(cred);
      setPkg(receivedPkg);
      const res: SyncDiffReport = await api.syncDiff(receivedPkg);
      initDiffSelection(res);
      info(`☁️ 已從 Google Drive 載入 iPad 資料：${res.cards_new.length} 張新卡片、${res.cards_updated.length} 張兩邊不一致`);
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
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as SyncPackage;
      if (!parsed || !Array.isArray(parsed.cards)) {
        throw new Error("無效的同步封包格式（缺少 cards 陣列）");
      }
      setPkg(parsed);
      const res: SyncDiffReport = await api.syncDiff(parsed);
      initDiffSelection(res);
      info(`已解析差異：${res.cards_new.length} 張新卡片、${res.cards_updated.length} 張兩邊不一致`);
    } catch (err) {
      report(err, "讀取或比對同步檔案失敗");
      setPkg(null);
    } finally {
      setComparing(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
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

  const toggleExpandDiff = (id: string) => {
    setExpandedDiffIds((prev) => {
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
        <div className="sync-head">
          <div className="sync-head-title">
            <h4>資料同步與備份</h4>
            <span className="facet-badge">{isIpad ? "iPad" : "電腦版"}</span>
          </div>
          <div className="sync-head-actions">
            <button
              type="button"
              onClick={() => setShowKeyInput((v) => !v)}
              aria-expanded={showKeyInput}
              title="設定或檢視 Google Drive 金鑰"
            >
              🔑 金鑰設定
            </button>
            <button type="button" className="icon-btn" onClick={onClose} aria-label="關閉視窗">
              ✕
            </button>
          </div>
        </div>

        {showKeyInput && (
          <label className="sync-section">
            <span className="sync-section-title">
              Google Drive 金鑰（<code>CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN</code>）
            </span>
            <input
              type="password"
              value={cloudCredential}
              onChange={(e) => {
                setCloudCredential(e.target.value);
                saveCloudCredential(e.target.value);
              }}
              placeholder="貼上金鑰（輸入一次即自動記憶於本機）"
              style={{ width: "100%" }}
            />
          </label>
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
                            <span className={`facet-badge sync-badge ${isNewAfterBaseline ? "green" : "blue"}`}>
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
                    onClick={handleIpadUploadToDrive}
                    disabled={cloudBusy || !ipadFilteredExport.pkg}
                    title="將篩選後的變更上傳至 Google Drive，供電腦版拉取合併"
                  >
                    {cloudBusy ? "雲端傳輸中…" : `☁️ 上傳變更至 Drive（${ipadFilteredExport.matchedCards.length} 張卡片）`}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleIpadExportJson(false)}
                    disabled={cloudBusy || !ipadFilteredExport.pkg}
                    title="匯出上方篩選條件的變更封包（供電腦端合併匯入）"
                  >
                    📤 匯出篩選變更 (.json, {ipadFilteredExport.matchedCards.length} 張)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleIpadExportJson(true)}
                    disabled={cloudBusy || !ipadFullPkg || ipadFilteredExport.totalCount === 0}
                    title="匯出瀏覽器內的完整資料庫備份（含全部卡片、白板與分組框）"
                  >
                    📥 匯出完整全庫備份 (.json, {ipadFilteredExport.totalCount} 張)
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
            <div className="sync-section">
              <div className="sync-section-title">本機檔案</div>
              <div className="sync-actions">
                <button type="button" onClick={() => void exportBackup()}>
                  📥 匯出 JSON 備份
                </button>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={cloudBusy}
                  title="選取本機 JSON 檔案比對差異並合併入目前資料庫"
                >
                  📂 合併匯入…
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => overwriteInputRef.current?.click()}
                  disabled={cloudBusy}
                  title="【危險】選取本機 JSON 備份檔，完全清空並 100% 覆蓋還原目前資料庫"
                >
                  ⚠️ 完整覆蓋還原…
                </button>
              </div>
            </div>

            <div className="sync-section">
              <div className="sync-section-title">Google Drive（與 iPad 同步）</div>
              <p className="sync-section-desc">
                先上傳電腦版完整備份供 iPad 拉取；iPad 上傳變更後，再從這裡拉取並比對合併。
              </p>
              <div className="sync-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() => void handleUploadPcBackupToCloud()}
                  disabled={cloudBusy}
                  title="將電腦完整資料庫上傳至 Google Drive，供 iPad 隨時下載覆蓋"
                >
                  {cloudBusy ? "雲端處理中…" : "☁️ 上傳雲端備份 (供 iPad)"}
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => void handlePullIpadFromCloud()}
                  disabled={cloudBusy}
                  title="從 Google Drive 讀取 iPad 發送的資料並進行差異比對"
                >
                  {cloudBusy ? "雲端處理中…" : "☁️ 拉取 iPad 資料 (Drive)"}
                </button>
              </div>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => void handleFileSelect(e)}
            />
            <input
              ref={overwriteInputRef}
              type="file"
              accept=".json,application/json"
              style={{ display: "none" }}
              onChange={(e) => void handlePcOverwriteImport(e)}
            />

            {/* 定時自動備份設定面板（選項 2-A） */}
            <div className="resolve-box" style={{ padding: 10, marginTop: 8, fontSize: 12 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
                  <input
                    type="checkbox"
                    checked={autoBackupCfg.enabled}
                    onChange={(e) => saveBackupSettings({ enabled: e.target.checked })}
                  />
                  <span>⏱️ 啟用本機固定檔案定時自動備份（支援開機錯時補償）</span>
                </label>
                {lastBackupTime && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    上次自動備份：{new Date(lastBackupTime).toLocaleString()}
                  </span>
                )}
              </div>

              {autoBackupCfg.enabled && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6 }}>
                  <div className="field-row" style={{ margin: 0, display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="muted" style={{ minWidth: 120 }}>本機固定備份檔案：</span>
                    <input
                      readOnly
                      value={autoBackupCfg.targetPath}
                      onClick={() => void handlePickBackupPath()}
                      placeholder="點擊右側「瀏覽選取…」指定備份 .json 檔案位置"
                      title={autoBackupCfg.targetPath || "點擊瀏覽選取備份檔案位置"}
                      style={{
                        flex: 1,
                        fontFamily: "monospace",
                        fontSize: 12,
                        padding: "4px 8px",
                        cursor: "pointer",
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => void handlePickBackupPath()}
                      disabled={pickingBackupPath || savingBackupNow}
                      style={{ fontSize: 12, padding: "4px 10px", flexShrink: 0 }}
                    >
                      {pickingBackupPath ? "選取中…" : "📂 瀏覽選取…"}
                    </button>
                    {autoBackupCfg.targetPath && (
                      <button
                        type="button"
                        onClick={() => saveBackupSettings({ targetPath: "" })}
                        disabled={pickingBackupPath || savingBackupNow}
                        title="清除備份路徑"
                        style={{ fontSize: 12, padding: "4px 8px", flexShrink: 0 }}
                      >
                        ✕
                      </button>
                    )}
                  </div>

                  <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="radio"
                        name="scheduleType"
                        checked={autoBackupCfg.scheduleType === "daily"}
                        onChange={() => saveBackupSettings({ scheduleType: "daily" })}
                      />
                      <span>每天固定時間：</span>
                      <input
                        type="time"
                        value={autoBackupCfg.dailyTime}
                        onChange={(e) => saveBackupSettings({ dailyTime: e.target.value })}
                        disabled={autoBackupCfg.scheduleType !== "daily"}
                        style={{ padding: "2px 4px", fontSize: 12 }}
                      />
                    </label>

                    <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="radio"
                        name="scheduleType"
                        checked={autoBackupCfg.scheduleType === "interval"}
                        onChange={() => saveBackupSettings({ scheduleType: "interval" })}
                      />
                      <span>每隔：</span>
                      <input
                        type="number"
                        min={0.5}
                        max={48}
                        step={0.5}
                        value={autoBackupCfg.intervalHours}
                        onChange={(e) => saveBackupSettings({ intervalHours: Number(e.target.value) || 1 })}
                        disabled={autoBackupCfg.scheduleType !== "interval"}
                        style={{ width: 52, padding: "2px 4px", fontSize: 12 }}
                      />
                      <span>小時</span>
                    </label>

                    <button
                      type="button"
                      onClick={() => void handleManualBackupNow()}
                      disabled={savingBackupNow || !autoBackupCfg.targetPath.trim()}
                      style={{ marginLeft: "auto", fontSize: 11, padding: "3px 8px" }}
                    >
                      {savingBackupNow ? "覆寫備份中…" : "立即覆寫備份一次"}
                    </button>
                  </div>
                </div>
              )}
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
                    <div className="tabs" role="tablist" style={{ marginBottom: 4 }}>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === "new"}
                        className={activeTab === "new" ? "on" : ""}
                        onClick={() => setActiveTab("new")}
                      >
                        🆕 新卡片（{diff.cards_new.length}） — 已選 {selectedNewCardIds.size}
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeTab === "updated"}
                        className={activeTab === "updated" ? "on" : ""}
                        onClick={() => setActiveTab("updated")}
                      >
                        🔄 既有卡片兩邊不一致（{diff.cards_updated.length}） — 已選 {selectedUpdateCardIds.size}
                      </button>
                    </div>

                    {activeTab === "new" ? (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                          <label className="sync-check-row" style={{ fontWeight: 600 }}>
                            <input
                              type="checkbox"
                              checked={
                                diff.cards_new.length > 0 &&
                                selectedNewCardIds.size === diff.cards_new.length
                              }
                              disabled={diff.cards_new.length === 0}
                              onChange={(e) =>
                                setSelectedNewCardIds(
                                  e.target.checked ? new Set(diff.cards_new.map((c) => c.id)) : new Set(),
                                )
                              }
                            />
                            全選所有新卡片（{diff.cards_new.length} 張）
                          </label>
                          <span className="muted" style={{ fontSize: 12 }}>
                            附帶追加：{diff.tags_new.length} 標籤 · {diff.board_cards_new.length} 白板歸屬
                          </span>
                        </div>

                        <div className="sync-diff-list">
                          {diff.cards_new.length === 0 && (
                            <div className="empty">本次匯入沒有新卡片。請切換至「既有卡片兩邊不一致」分頁檢視修改。</div>
                          )}
                          {diff.cards_new.map((c) => (
                            <div key={c.id} className="sync-diff-item">
                              <label className="sync-check-row">
                                <input
                                  type="checkbox"
                                  checked={selectedNewCardIds.has(c.id)}
                                  onChange={() => toggleNewCard(c.id)}
                                />
                                <span className="facet-badge sync-badge green">
                                  新增
                                </span>
                                <strong>{c.title || "（無標題）"}</strong>
                              </label>
                              <span className="snippet" style={{ maxWidth: 260 }}>
                                {c.body.slice(0, 50) || "（空內文）"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                          <label className="sync-check-row" style={{ fontWeight: 600 }}>
                            <input
                              type="checkbox"
                              checked={
                                diff.cards_updated.length > 0 &&
                                selectedUpdateCardIds.size === diff.cards_updated.length
                              }
                              disabled={diff.cards_updated.length === 0}
                              onChange={(e) =>
                                setSelectedUpdateCardIds(
                                  e.target.checked ? new Set(diff.cards_updated.map((c) => c.id)) : new Set(),
                                )
                              }
                            />
                            全選不一致卡片（{diff.cards_updated.length} 張）
                          </label>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <button
                              type="button"
                              style={{ fontSize: 11, padding: "2px 8px" }}
                              onClick={() => {
                                const newer = (diff.cards_updated as ExtendedCardDiff[])
                                  .filter((c) => isCardNewer(c))
                                  .map((c) => c.id);
                                setSelectedUpdateCardIds(new Set(newer));
                              }}
                              title="只勾選匯入檔最後修改時間較電腦端更新的卡片"
                            >
                              ⚡ 只勾選匯入檔較新
                            </button>
                          </div>
                        </div>

                        <div className="sync-diff-list">
                          {diff.cards_updated.length === 0 && (
                            <div className="empty">所有既有卡片在兩邊內容、標籤與連結皆完全一致。</div>
                          )}
                          {(diff.cards_updated as ExtendedCardDiff[]).map((c) => {
                            const newer = isCardNewer(c);
                            const isExpanded = expandedDiffIds.has(c.id);
                            const fields =
                              c.diff_fields && c.diff_fields.length > 0
                                ? c.diff_fields
                                : [
                                    ...(c.old_title !== c.new_title ? ["標題"] : []),
                                    ...(c.old_body !== c.new_body ? ["內容"] : []),
                                  ];
                            const titleDiff = c.old_title !== c.new_title;
                            const bodyDiff = c.old_body !== c.new_body;
                            const typeDiff =
                              c.old_card_type !== undefined &&
                              c.new_card_type !== undefined &&
                              c.old_card_type !== c.new_card_type;
                            const statusDiff =
                              c.old_curation_status !== undefined &&
                              c.new_curation_status !== undefined &&
                              c.old_curation_status !== c.new_curation_status;
                            const tagsDiff =
                              JSON.stringify(c.old_tags ?? []) !== JSON.stringify(c.new_tags ?? []);
                            const linksDiff =
                              JSON.stringify(c.old_links ?? []) !== JSON.stringify(c.new_links ?? []);

                            return (
                              <div
                                key={c.id}
                                className="sync-diff-item"
                                style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}
                              >
                                <div
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    gap: 8,
                                    flexWrap: "wrap",
                                  }}
                                >
                                  <label className="sync-check-row" style={{ flex: 1, minWidth: 200 }}>
                                    <input
                                      type="checkbox"
                                      checked={selectedUpdateCardIds.has(c.id)}
                                      onChange={() => toggleUpdateCard(c.id)}
                                    />
                                    <span className={`facet-badge sync-badge ${newer ? "green" : "amber"}`}>
                                      {newer ? "匯入檔較新" : "電腦端較新"}
                                    </span>
                                    <strong>{c.new_title || c.old_title || c.title || "（無標題）"}</strong>
                                    {fields.map((f) => (
                                      <span key={f} className="facet-badge">
                                        {f}
                                      </span>
                                    ))}
                                  </label>

                                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span className="muted" style={{ fontSize: 11, textAlign: "right" }}>
                                      匯入：{formatSyncTime(c.new_updated_at)}
                                      <br />
                                      電腦：{formatSyncTime(c.old_updated_at)}
                                    </span>
                                    <button
                                      type="button"
                                      style={{ fontSize: 12, padding: "2px 8px" }}
                                      onClick={() => toggleExpandDiff(c.id)}
                                    >
                                      {isExpanded ? "▴ 收合差異" : "▾ 展開差異"}
                                    </button>
                                  </div>
                                </div>

                                {isExpanded && (
                                  <div
                                    style={{
                                      display: "flex",
                                      flexDirection: "column",
                                      gap: 8,
                                      marginTop: 4,
                                      paddingTop: 8,
                                      borderTop: "1px dashed var(--line)",
                                      fontSize: 12,
                                    }}
                                  >
                                    {titleDiff && (
                                      <div className="diff-view-box" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                                        <div className="diff-pane">
                                          <div className="diff-pane-head">標題（電腦端）</div>
                                          <div>{c.old_title || "（無標題）"}</div>
                                        </div>
                                        <div className="diff-pane new">
                                          <div className="diff-pane-head">標題（匯入檔）</div>
                                          <div>{c.new_title || "（無標題）"}</div>
                                        </div>
                                      </div>
                                    )}

                                    {(typeDiff || statusDiff) && (
                                      <div className="diff-view-box" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                                        <div className="diff-pane">
                                          <div className="diff-pane-head">型態與整理狀態（電腦端）</div>
                                          <div>
                                            型態：{formatCardType(c.old_card_type)} ／ 狀態：{formatCuration(c.old_curation_status)}
                                          </div>
                                        </div>
                                        <div className="diff-pane new">
                                          <div className="diff-pane-head">型態與整理狀態（匯入檔）</div>
                                          <div>
                                            型態：{formatCardType(c.new_card_type)} ／ 狀態：{formatCuration(c.new_curation_status)}
                                          </div>
                                        </div>
                                      </div>
                                    )}

                                    {tagsDiff && (
                                      <div className="diff-view-box" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                                        <div className="diff-pane">
                                          <div className="diff-pane-head">標籤（電腦端）</div>
                                          <div className="chips">
                                            {(c.old_tags ?? []).length === 0 ? (
                                              <span className="muted">無標籤</span>
                                            ) : (
                                              (c.old_tags ?? []).map((t) => (
                                                <span key={t} className="chip">
                                                  {t}
                                                </span>
                                              ))
                                            )}
                                          </div>
                                        </div>
                                        <div className="diff-pane new">
                                          <div className="diff-pane-head">標籤（匯入檔）</div>
                                          <div className="chips">
                                            {(c.new_tags ?? []).length === 0 ? (
                                              <span className="muted">無標籤</span>
                                            ) : (
                                              (c.new_tags ?? []).map((t) => (
                                                <span key={t} className="chip">
                                                  {t}
                                                </span>
                                              ))
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    )}

                                    {linksDiff && (
                                      <div className="diff-view-box" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                                        <div className="diff-pane">
                                          <div className="diff-pane-head">語意連結（電腦端）</div>
                                          {(c.old_links ?? []).length === 0 ? (
                                            <span className="muted">無連結</span>
                                          ) : (
                                            <ul className="plain" style={{ fontSize: 11 }}>
                                              {(c.old_links ?? []).map((l, idx) => (
                                                <li key={idx}>{l}</li>
                                              ))}
                                            </ul>
                                          )}
                                        </div>
                                        <div className="diff-pane new">
                                          <div className="diff-pane-head">語意連結（匯入檔）</div>
                                          {(c.new_links ?? []).length === 0 ? (
                                            <span className="muted">無連結</span>
                                          ) : (
                                            <ul className="plain" style={{ fontSize: 11 }}>
                                              {(c.new_links ?? []).map((l, idx) => (
                                                <li key={idx}>{l}</li>
                                              ))}
                                            </ul>
                                          )}
                                        </div>
                                      </div>
                                    )}

                                    {bodyDiff && (
                                      <div className="diff-view-box" style={{ marginTop: 0, paddingTop: 0, borderTop: "none" }}>
                                        <div className="diff-pane">
                                          <div className="diff-pane-head">內文（電腦端目前內容）</div>
                                          <pre className="diff-pane-body">{c.old_body || "（空）"}</pre>
                                        </div>
                                        <div className="diff-pane new">
                                          <div className="diff-pane-head">內文（匯入檔案新內容）</div>
                                          <pre className="diff-pane-body">{c.new_body || "（空）"}</pre>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}
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
                  {applying
                    ? "套用中…"
                    : `確認套用所選變更（新卡 ${selectedNewCardIds.size}＋更新 ${selectedUpdateCardIds.size}）`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}