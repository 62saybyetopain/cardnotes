// @depends-on ./storage/index.ts (setPreferredDriverType)
import { setPreferredDriverType } from "./storage";

export function isStandaloneMode(): boolean {
  if (typeof window === "undefined" || !window.location) return false;

  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  if (mode === "ipad" || mode === "standalone") return true;
  if (mode === "desktop") return false;

  // GitHub Pages 網域自動視為獨立純前端模式
  if (window.location.hostname.endsWith("github.io")) {
    return true;
  }

  // 儲存於 localStorage 的偏好設定
  try {
    const saved = localStorage.getItem("cardboard:app-mode");
    if (saved === "ipad") return true;
    if (saved === "desktop") return false;
  } catch {
    /* 忽略例外 */
  }

  // 偵測是否為 iPad / 平板觸控裝置（螢幕寬度小於等於 1024 且具備觸控點）
  const isTouch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  const isTabletWidth = window.innerWidth <= 1024;
  return isTouch && isTabletWidth;
}

export function initDeviceEnvironment(): boolean {
  const standalone = isStandaloneMode();
  if (standalone) {
    // 獨立模式自動將儲存驅動切換至 IndexedDB (Dexie)
    setPreferredDriverType("dexie");
  } else {
    // 非獨立模式明確切回後端，避免先前的 dexie 偏好殘留
    setPreferredDriverType("http");
  }
  return standalone;
}