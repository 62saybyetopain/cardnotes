// @depends-on ../types.ts (SyncPackage)
import { Peer, type DataConnection } from "peerjs";
import type { SyncPackage } from "../types";

const PEER_PREFIX = "cardboard-sync-room-";

export function generatePairingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 電腦端：以 6 位數連線碼監聽 iPad 連線，支援自動將電腦全庫發送給 iPad 或接收 iPad 變更
 */
export function startP2PReceiver(
  pairingCode: string,
  onPackageReceived: (pkg: SyncPackage, conn: DataConnection) => void,
  onProvidePcBackup: () => Promise<SyncPackage>,
  onError: (err: unknown) => void,
): () => void {
  const peerId = `${PEER_PREFIX}${pairingCode}`;
  const peer = new Peer(peerId);

  peer.on("connection", (conn) => {
    conn.on("data", async (data: unknown) => {
      const msg = data as { type: string; payload?: SyncPackage };
      if (msg.type === "REQUEST_PC_BACKUP") {
        if (!window.confirm("有裝置正在請求下載電腦的完整資料庫（所有卡片與標籤）。確定是你的 iPad 並允許嗎？")) {
          conn.send({ type: "ERROR", error: "電腦端已拒絕" });
          return;
        }
        try {
          const pcPkg = await onProvidePcBackup();
          conn.send({ type: "PC_BACKUP_PAYLOAD", payload: pcPkg });
        } catch (e) {
          console.error("P2P：電腦端匯出備份失敗", e);
          conn.send({ type: "ERROR", error: "電腦端匯出備份失敗" });
        }
      } else if (msg.type === "SYNC_PACKAGE" && msg.payload) {
        onPackageReceived(msg.payload, conn);
        conn.send({ type: "SYNC_ACK" });
      }
    });
  });

  peer.on("error", (err) => {
    onError(err);
  });

  return () => {
    peer.destroy();
  };
}

const CONNECT_TIMEOUT_MS = 20000;
const TRANSFER_TIMEOUT_MS = 120000;

/**
 * iPad 端：發送 iPad 變更封包給電腦；等電腦端回 SYNC_ACK 才算成功
 */
export function sendP2PPackage(
  pairingCode: string,
  pkg: SyncPackage,
  onSuccess: () => void,
  onError: (err: unknown) => void,
): void {
  const peer = new Peer();
  const targetPeerId = `${PEER_PREFIX}${pairingCode.trim()}`;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (err?: unknown) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    peer.destroy();
    if (err) onError(err);
    else onSuccess();
  };
  timer = setTimeout(() => finish(new Error("連線逾時：無法連到電腦端")), CONNECT_TIMEOUT_MS);

  peer.on("open", () => {
    const conn = peer.connect(targetPeerId, { reliable: true });

    conn.on("open", () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("電腦端未確認收到封包")), TRANSFER_TIMEOUT_MS);
      conn.send({ type: "SYNC_PACKAGE", payload: pkg });
    });

    conn.on("data", (data: unknown) => {
      if ((data as { type?: string } | null)?.type === "SYNC_ACK") finish();
    });

    conn.on("close", () => finish(new Error("連線在電腦端確認前中斷")));
    conn.on("error", (err) => finish(err));
  });

  peer.on("error", (err) => finish(err));
}

/**
 * iPad 端：向電腦請求完整資料庫覆蓋 iPad
 */
export function pullP2PPackageFromPc(
  pairingCode: string,
  onSuccess: (pcPkg: SyncPackage) => void,
  onError: (err: unknown) => void,
): void {
  const peer = new Peer();
  const targetPeerId = `${PEER_PREFIX}${pairingCode.trim()}`;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (err?: unknown, pcPkg?: SyncPackage) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    peer.destroy();
    if (err) onError(err);
    else if (pcPkg) onSuccess(pcPkg);
  };
  timer = setTimeout(() => finish(new Error("連線逾時：無法連到電腦端")), CONNECT_TIMEOUT_MS);

  peer.on("open", () => {
    const conn = peer.connect(targetPeerId, { reliable: true });

    conn.on("open", () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("電腦端未在時限內回傳資料")), TRANSFER_TIMEOUT_MS);
      conn.send({ type: "REQUEST_PC_BACKUP" });
    });

    conn.on("data", (data: unknown) => {
      const msg = data as { type: string; payload?: SyncPackage; error?: string };
      if (msg.type === "PC_BACKUP_PAYLOAD" && msg.payload) {
        finish(undefined, msg.payload);
      } else if (msg.type === "ERROR") {
        finish(new Error(msg.error || "電腦端拒絕發送"));
      }
    });

    conn.on("close", () => finish(new Error("連線在收到資料前中斷")));
    conn.on("error", (err) => finish(err));
  });

  peer.on("error", (err) => finish(err));
}