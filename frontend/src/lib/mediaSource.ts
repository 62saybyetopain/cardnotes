// @depends-on ./p2p.ts (downloadMediaFromCloud)
// @depends-on ./storage/dexieDb.ts (db.media)
// @depends-on ../types.ts (MediaInfo)
// @depends-on schema.sql::media（同一個 id 的內容不可變；本機快取直接沿用以此為前提）
import type { MediaInfo } from "../types";
import { downloadMediaFromCloud } from "./p2p";
import { db } from "./storage/dexieDb";

export interface OpenedMedia {
  info: MediaInfo;
  src: string;
  revoke(): void;
}

// 同一張圖可能同時出現在畫面多處：合併成一次下載
const inflight = new Map<string, Promise<Blob | null>>();

async function fetchAndCache(id: string): Promise<Blob | null> {
  const blob = await downloadMediaFromCloud(id);
  if (!blob) return null;
  try {
    await db.media.put({
      id,
      kind: blob.type.startsWith("video/") ? "video" : "image",
      mime: blob.type,
      byte_size: blob.size,
      data_blob: blob,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    // 寫不進快取（例如空間不足）不影響這次顯示，但要留下紀錄，下次會重新下載
    console.error(`圖片 ${id} 寫入本機快取失敗`, e);
  }
  return blob;
}

/**
 * iPad／網頁版：先讀本機 db.media，沒有才從 Drive 下載並快取。
 * 回傳 null＝雲端也確定沒有（真的遺失）；下載失敗（沒金鑰、離線、HTTP 錯誤）一律丟錯，
 * 呼叫端要顯示成「尚未下載」而不是「遺失」。
 */
export async function openLocalMedia(rawId: string): Promise<OpenedMedia | null> {
  const id = rawId.toLowerCase(); // 上傳端的雲端檔名與本機主鍵都是小寫
  let blob: Blob | null = (await db.media.get(id))?.data_blob ?? null;
  if (!blob) {
    let p = inflight.get(id);
    if (!p) {
      p = fetchAndCache(id).finally(() => inflight.delete(id));
      inflight.set(id, p);
    }
    blob = await p;
    if (!blob) return null;
  }
  const url = URL.createObjectURL(blob);
  return {
    info: {
      id,
      kind: blob.type.startsWith("video/") ? "video" : "image",
      mime: blob.type,
      byte_size: blob.size,
      width: null,
      height: null,
    },
    src: url,
    revoke: () => URL.revokeObjectURL(url),
  };
}