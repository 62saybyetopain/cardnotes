import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  base: "./", // 確保 GitHub Pages 子路徑相容
  // 原因：沒有 test 區塊時 vitest 預設 node 環境，用到 document 的測試全部噴 "document is not defined"
  test: { environment: "jsdom", setupFiles: ["./src/test-setup.ts"] },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});