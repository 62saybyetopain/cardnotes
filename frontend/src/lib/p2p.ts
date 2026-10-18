// @depends-on ../types.ts (SyncPackage)
import type { SyncPackage } from "../types";

const STORAGE_KEY = "cardboard_gdrive_credential";
const PC_BACKUP_FILENAME = "cardboard-pc-backup.json";
const IPAD_SYNC_FILENAME = "cardboard-ipad-sync.json";

let cachedAccessToken: string | null = null;
let cachedTokenExpiry = 0;
let cachedCredentialRaw = "";

function getEnvRecord(): Record<string, string | undefined> {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
}

/**
 * 取得目前已儲存的 Google Drive 金鑰（優先順序：localStorage > .env 組合變數 > .env 單一變數）
 */
export function getSavedCloudCredential(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)?.trim();
    if (saved) return saved;
  } catch {
    // 忽略無痕模式或 localStorage 存取限制
  }

  const env = getEnvRecord();
  const single = env.VITE_GDRIVE_CREDENTIAL?.trim() || env.VITE_P2P_SECRET?.trim();
  if (single) return single;

  const clientId = env.VITE_GDRIVE_CLIENT_ID?.trim();
  const clientSecret = env.VITE_GDRIVE_CLIENT_SECRET?.trim();
  const refreshToken = env.VITE_GDRIVE_REFRESH_TOKEN?.trim();
  if (clientId && clientSecret && refreshToken) {
    return `${clientId}|${clientSecret}|${refreshToken}`;
  }
  return "";
}

/**
 * 將使用者輸入的 Google Drive 金鑰持久化至 localStorage
 */
export function saveCloudCredential(credential: string): void {
  const trimmed = credential.trim();
  if (!trimmed) return;
  try {
    localStorage.setItem(STORAGE_KEY, trimmed);
  } catch {
    // 忽略 localStorage 寫入限制
  }
}

/**
 * 解析金鑰並取得有效的 Google Drive OAuth2 Access Token
 * 支援格式：
 * 1. "CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN"（永久有效，自動換取 Access Token）
 * 2. 直接傳入 OAuth2 Access Token（例如 "ya29.a0..."）
 */
async function resolveAccessToken(credentialInput?: string): Promise<string> {
  const raw = (credentialInput?.trim() || getSavedCloudCredential()).trim();
  if (!raw) {
    throw new Error(
      "尚未設定 Google Drive 雲端金鑰。請在輸入框貼上金鑰（格式：CLIENT_ID|CLIENT_SECRET|REFRESH_TOKEN），或於 .env 設定",
    );
  }

  saveCloudCredential(raw);

  if (cachedAccessToken && cachedCredentialRaw === raw && Date.now() < cachedTokenExpiry) {
    return cachedAccessToken;
  }

  const parts = raw.split("|").map((s) => s.trim());
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    const [clientId, clientSecret, refreshToken] = parts;
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Google OAuth 自動換證失敗 (${res.status})：請檢查 CLIENT_ID、SECRET 與 REFRESH_TOKEN 是否正確。${errText}`);
    }

    const data = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Error("Google OAuth 回傳缺少 access_token");
    }

    cachedAccessToken = data.access_token;
    cachedCredentialRaw = raw;
    cachedTokenExpiry = Date.now() + Math.max((data.expires_in ?? 3600) - 60, 60) * 1000;
    return cachedAccessToken;
  }

  // 若非三段式格式，視為直接傳入的 Access Token
  return raw;
}

async function findDriveFileId(accessToken: string, fileName: string): Promise<string | null> {
  const q = encodeURIComponent(`name = '${fileName}' and trashed = false`);
  const url = `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name,modifiedTime)&orderBy=modifiedTime%20desc&pageSize=1`;

  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`查詢 Google Drive 檔案失敗 (${res.status})：${errText}`);
  }

  const data = (await res.json()) as { files?: Array<{ id: string }> };
  return data.files?.[0]?.id ?? null;
}

async function uploadJsonToDrive(accessToken: string, fileName: string, pkg: SyncPackage): Promise<void> {
  let fileId = await findDriveFileId(accessToken, fileName);

  if (!fileId) {
    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify({
        name: fileName,
        mimeType: "application/json",
      }),
    });

    if (!createRes.ok) {
      const errText = await createRes.text().catch(() => "");
      throw new Error(`在 Google Drive 建立檔案失敗 (${createRes.status})：${errText}`);
    }

    const created = (await createRes.json()) as { id?: string };
    if (!created.id) {
      throw new Error("Google Drive 建立檔案後未回傳檔案 ID");
    }
    fileId = created.id;
  }

  const updateRes = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(pkg),
    },
  );

  if (!updateRes.ok) {
    const errText = await updateRes.text().catch(() => "");
    throw new Error(`上傳資料至 Google Drive 失敗 (${updateRes.status})：${errText}`);
  }
}

async function downloadJsonFromDrive(accessToken: string, fileName: string): Promise<SyncPackage> {
  const fileId = await findDriveFileId(accessToken, fileName);
  if (!fileId) {
    throw new Error(`Google Drive 上找不到「${fileName}」，請先在來源裝置點擊上傳備份`);
  }

  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`從 Google Drive 下載「${fileName}」失敗 (${res.status})：${errText}`);
  }

  const pkg = (await res.json()) as SyncPackage;
  if (!pkg || !Array.isArray(pkg.cards)) {
    throw new Error(`雲端檔案「${fileName}」格式無效或內容尚未完整上傳，請重新上傳後再試`);
  }
  return pkg;
}

/**
 * 電腦端：一鍵將電腦完整資料庫備份上傳至 Google Drive (cardboard-pc-backup.json)
 */
export async function uploadPcBackupToCloud(pkg: SyncPackage, credentialInput?: string): Promise<void> {
  const token = await resolveAccessToken(credentialInput);
  await uploadJsonToDrive(token, PC_BACKUP_FILENAME, pkg);
}

/**
 * 電腦端：從 Google Drive 拉取 iPad 上傳的變更封包 (cardboard-ipad-sync.json)
 */
export async function pullIpadPackageFromCloud(credentialInput?: string): Promise<SyncPackage> {
  const token = await resolveAccessToken(credentialInput);
  return await downloadJsonFromDrive(token, IPAD_SYNC_FILENAME);
}

/**
 * iPad 端：將 iPad 變更封包上傳至 Google Drive (cardboard-ipad-sync.json) 供電腦端拉取合併
 */
export function sendP2PPackage(
  credentialInput: string,
  pkg: SyncPackage,
  onSuccess: () => void,
  onError: (err: unknown) => void,
): void {
  void (async () => {
    try {
      const token = await resolveAccessToken(credentialInput);
      await uploadJsonToDrive(token, IPAD_SYNC_FILENAME, pkg);
      onSuccess();
    } catch (err) {
      onError(err);
    }
  })();
}

/**
 * iPad 端：從 Google Drive 下載電腦端最新完整資料庫 (cardboard-pc-backup.json) 覆蓋 iPad
 */
export function pullP2PPackageFromPc(
  credentialInput: string,
  onSuccess: (pcPkg: SyncPackage) => void,
  onError: (err: unknown) => void,
): void {
  void (async () => {
    try {
      const token = await resolveAccessToken(credentialInput);
      const pcPkg = await downloadJsonFromDrive(token, PC_BACKUP_FILENAME);
      onSuccess(pcPkg);
    } catch (err) {
      onError(err);
    }
  })();
}