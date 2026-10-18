// @depends-on ../types.ts (SyncPackage)
import { Peer, type DataConnection } from "peerjs";
import type { SyncPackage } from "../types";

const PEER_PREFIX = "cardboard-sync-room-";

/**
 * 將可能包含特殊符號的密碼轉為 PeerJS 合法的純英數 Peer ID（避免 invalid-id 錯誤並防止信令伺服器窺探明文密碼）
 */
function toSafePeerId(rawSecret: string): string {
  const trimmed = rawSecret.trim();
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (ch * 31), 0x85ebca6b) >>> 0;
  }
  const safeHash = `${h1.toString(36)}-${h2.toString(36)}-${trimmed.length.toString(36)}`;
  return `${PEER_PREFIX}${safeHash}`;
}

function getPeerConfig(): RTCConfiguration {
  const iceServers: RTCIceServer[] = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ];
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const turnUrls = env?.VITE_TURN_URLS
    ?.split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  if (turnUrls && turnUrls.length > 0) {
    iceServers.push({
      urls: turnUrls,
      username: env?.VITE_TURN_USERNAME,
      credential: env?.VITE_TURN_CREDENTIAL,
    });
  }
  return { iceServers };
}

function formatPeerError(err: unknown): Error {
  const peerErr = err as { type?: string; message?: string } | null;
  const errType = peerErr?.type;
  if (errType === "peer-unavailable") {
    return new Error("找不到電腦端：請確認密碼是否一致，且電腦端接收視窗仍保持開啟並連網（peer-unavailable）");
  }
  if (errType === "invalid-id") {
    return new Error("Peer ID 格式無效（invalid-id）");
  }
  if (errType === "network" || errType === "server-error" || errType === "socket-error" || errType === "socket-closed") {
    return new Error(`無法連上 P2P 信令伺服器（${errType}）：請確認網路未封鎖 WebSocket 外連`);
  }
  if (errType === "webrtc") {
    return new Error("WebRTC 通道建立失敗（webrtc）：請確認同區網未隔離，或跨網已設定 TURN");
  }
  return err instanceof Error ? err : new Error(String(peerErr?.message || err));
}

function attachIceFailureWatcher(conn: DataConnection, onIceFailed: (err: Error) => void): void {
  const checkIce = () => {
    const state = conn.peerConnection?.iceConnectionState;
    if (state === "failed") {
      onIceFailed(
        new Error(
          "NAT 穿透失敗（ICE failed）：無法建立點對點連線。若在家裡請確認電腦有線與 iPad Wi-Fi 為同一台分享器且電腦網路設為「私人網路」",
        ),
      );
    }
  };
  if (conn.peerConnection) {
    conn.peerConnection.addEventListener("iceconnectionstatechange", checkIce);
  } else {
    setTimeout(() => {
      conn.peerConnection?.addEventListener("iceconnectionstatechange", checkIce);
    }, 50);
  }
}

/**
 * 優先回傳環境變數 VITE_P2P_SECRET 設定的固定密碼（可含特殊符號＋數字）；若未設定則產生隨機碼
 */
export function generatePairingCode(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const fixedSecret = env?.VITE_P2P_SECRET?.trim();
  if (fixedSecret) {
    return fixedSecret;
  }
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * 電腦端：以密碼（支援特殊符號＋數字）監聽 iPad 連線，驗證密碼後自動允許遠端拉取全庫或接收 iPad 變更
 */
export function startP2PReceiver(
  pairingCode: string,
  onPackageReceived: (pkg: SyncPackage, conn: DataConnection) => void,
  onProvidePcBackup: () => Promise<SyncPackage>,
  onError: (err: unknown) => void,
): () => void {
  const expectedSecret = pairingCode.trim();
  const peerId = toSafePeerId(expectedSecret);
  const peer = new Peer(peerId, { config: getPeerConfig() });
  let destroyed = false;

  peer.on("connection", (conn) => {
    conn.on("data", async (data: unknown) => {
      const msg = data as { type: string; auth?: string; payload?: SyncPackage };
      if (msg.auth !== expectedSecret) {
        conn.send({ type: "ERROR", error: "密碼驗證失敗，電腦端拒絕存取" });
        return;
      }
      if (msg.type === "REQUEST_PC_BACKUP") {
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

  peer.on("disconnected", () => {
    if (!destroyed) {
      console.warn("P2P：電腦端與信令伺服器斷開，正在嘗試自動重連...");
      peer.reconnect();
    }
  });

  peer.on("error", (err) => {
    onError(formatPeerError(err));
  });

  return () => {
    destroyed = true;
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
  const secret = pairingCode.trim();
  const peer = new Peer({ config: getPeerConfig() });
  const targetPeerId = toSafePeerId(secret);
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
  timer = setTimeout(
    () =>
      finish(
        new Error(
          "連線逾時（20 秒）：無法建立點對點通道。若在家裡同分享器，請確認電腦與 Wi-Fi 為同網段且 Windows 網路設為私人網路",
        ),
      ),
    CONNECT_TIMEOUT_MS,
  );

  peer.on("open", () => {
    const conn = peer.connect(targetPeerId, { reliable: true });
    attachIceFailureWatcher(conn, (iceErr) => finish(iceErr));

    conn.on("open", () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("電腦端未確認收到封包（120 秒逾時）")), TRANSFER_TIMEOUT_MS);
      conn.send({ type: "SYNC_PACKAGE", auth: secret, payload: pkg });
    });

    conn.on("data", (data: unknown) => {
      const msg = data as { type?: string; error?: string } | null;
      if (msg?.type === "SYNC_ACK") {
        finish();
      } else if (msg?.type === "ERROR") {
        finish(new Error(msg.error || "電腦端拒絕接收"));
      }
    });

    conn.on("close", () => finish(new Error("連線在電腦端確認前中斷")));
    conn.on("error", (err) => finish(formatPeerError(err)));
  });

  peer.on("error", (err) => finish(formatPeerError(err)));
}

/**
 * iPad 端：向電腦請求完整資料庫覆蓋 iPad
 */
export function pullP2PPackageFromPc(
  pairingCode: string,
  onSuccess: (pcPkg: SyncPackage) => void,
  onError: (err: unknown) => void,
): void {
  const secret = pairingCode.trim();
  const peer = new Peer({ config: getPeerConfig() });
  const targetPeerId = toSafePeerId(secret);
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
  timer = setTimeout(
    () =>
      finish(
        new Error(
          "連線逾時（20 秒）：無法建立點對點通道。若在家裡同分享器，請確認電腦與 Wi-Fi 為同網段且 Windows 網路設為私人網路",
        ),
      ),
    CONNECT_TIMEOUT_MS,
  );

  peer.on("open", () => {
    const conn = peer.connect(targetPeerId, { reliable: true });
    attachIceFailureWatcher(conn, (iceErr) => finish(iceErr));

    conn.on("open", () => {
      clearTimeout(timer);
      timer = setTimeout(() => finish(new Error("電腦端未在時限內回傳資料（120 秒逾時）")), TRANSFER_TIMEOUT_MS);
      conn.send({ type: "REQUEST_PC_BACKUP", auth: secret });
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
    conn.on("error", (err) => finish(formatPeerError(err)));
  });

  peer.on("error", (err) => finish(formatPeerError(err)));
}