// @depends-on ./driver.ts
// @depends-on ./httpDriver.ts
// @depends-on ./indexedDbDriver.ts
import type { StorageDriver } from "./driver";
import { HttpDriver } from "./httpDriver";
import { IndexedDbDriver } from "./indexedDbDriver";

export type StorageDriverType = "http" | "dexie";

const STORAGE_KEY = "cardboard:storage-driver";

export function getPreferredDriverType(): StorageDriverType {
  try {
    // 1. URL 參數優先：?storage=dexie 或 ?storage=http
    if (typeof window !== "undefined" && window.location) {
      const sp = new URLSearchParams(window.location.search);
      const val = sp.get("storage");
      if (val === "dexie" || val === "indexeddb") return "dexie";
      if (val === "http") return "http";
    }
    // 2. localStorage 偏好
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "dexie" || saved === "http") return saved;

    // 3. 環境自動感知：非 localhost / 127.0.0.1 之靜態環境（如 GitHub Pages）預設為 dexie
    if (typeof window !== "undefined" && window.location) {
      const host = window.location.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
      if (!isLocal) return "dexie";
    }
  } catch {
    /* 忽略例外 */
  }
  return "http";
}

export function setPreferredDriverType(type: StorageDriverType): void {
  try {
    localStorage.setItem(STORAGE_KEY, type);
  } catch {
    /* 忽略例外 */
  }
}

let activeDriver: StorageDriver | null = null;
let currentType: StorageDriverType = "http";

export function getStorageDriver(): StorageDriver {
  const preferred = getPreferredDriverType();
  if (!activeDriver || currentType !== preferred) {
    currentType = preferred;
    activeDriver = preferred === "dexie" ? new IndexedDbDriver() : new HttpDriver();
  }
  return activeDriver;
}

export const storage = new Proxy({} as StorageDriver, {
  get(_target, prop) {
    const driver = getStorageDriver();
    const val = (driver as any)[prop];
    return typeof val === "function" ? val.bind(driver) : val;
  },
});