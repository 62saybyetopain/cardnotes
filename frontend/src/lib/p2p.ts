// @depends-on ../types.ts (SyncPackage)
import { Peer, type DataConnection } from "peerjs";
import type { SyncPackage } from "../types";

const PEER_PREFIX = "cardboard-sync-room-";

export function generatePairingCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 電腦端：建立 Peer 並以 6 位數連線碼監聽來自 iPad 的傳輸
 */
export function startP2PReceiver(
  pairingCode: string,
  onPackageReceived: (pkg: SyncPackage, conn: DataConnection) => void,
  onError: (err: unknown) => void,
): () => void {
  const peerId = `${PEER_PREFIX}${pairingCode}`;
  const peer = new Peer(peerId);

  peer.on("connection", (conn) => {
    conn.on("data", (data: unknown) => {
      const msg = data as { type: string; payload: SyncPackage };
      if (msg && msg.type === "SYNC_PACKAGE" && msg.payload) {
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
 * iPad 端：輸入電腦顯示的 6 位數連線碼，對接後直接將本機封包傳送給電腦
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