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
        try {
          const pcPkg = await onProvidePcBackup();
          conn.send({ type: "PC_BACKUP_PAYLOAD", payload: pcPkg });
        } catch (e) {
          conn.send({ type: "ERROR", error: "電腦端匯出備份失敗" });
        }
      } else if (msg.type === "SYNC_PACKAGE" && msg.payload) {
        onPackageReceived(msg.payload, conn);
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

/**
 * iPad 端：發送 iPad 變更封包給電腦
 */
export function sendP2PPackage(
  pairingCode: string,
  pkg: SyncPackage,
  onSuccess: () => void,
  onError: (err: unknown) => void,
): void {
  const peer = new Peer();
  const targetPeerId = `${PEER_PREFIX}${pairingCode.trim()}`;

  peer.on("open", () => {
    const conn = peer.connect(targetPeerId, { reliable: true });

    conn.on("open", () => {
      conn.send({ type: "SYNC_PACKAGE", payload: pkg });
      onSuccess();
      setTimeout(() => peer.destroy(), 3000);
    });

    conn.on("error", (err) => {
      onError(err);
      peer.destroy();
    });
  });

  peer.on("error", (err) => {
    onError(err);
    peer.destroy();
  });
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

  peer.on("open", () => {
    const conn = peer.connect(targetPeerId, { reliable: true });

    conn.on("open", () => {
      conn.send({ type: "REQUEST_PC_BACKUP" });
    });

    conn.on("data", (data: unknown) => {
      const msg = data as { type: string; payload?: SyncPackage; error?: string };
      if (msg.type === "PC_BACKUP_PAYLOAD" && msg.payload) {
        onSuccess(msg.payload);
        setTimeout(() => peer.destroy(), 1500);
      } else if (msg.type === "ERROR") {
        onError(new Error(msg.error || "電腦端拒絕發送"));
        peer.destroy();
      }
    });

    conn.on("error", (err) => {
      onError(err);
      peer.destroy();
    });
  });

  peer.on("error", (err) => {
    onError(err);
    peer.destroy();
  });
}