import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { ApiError } from "./api";

interface Toast {
  id: number;
  kind: "error" | "info";
  text: string;
}
interface Notifier {
  report: (e: unknown, prefix?: string) => void;
  info: (text: string) => void;
}

const Ctx = createContext<Notifier | null>(null);
let seq = 0;

export function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function NotifyProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = ++seq;
    setToasts((t) => [...t, { id, kind, text }]);
    // 錯誤停留較久；使用者也可以手動關閉
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 8000 : 3500);
  }, []);
  const value = useMemo<Notifier>(
    () => ({
      report: (e, prefix) => {
        console.error(prefix ?? "錯誤", e);
        push("error", prefix ? `${prefix}：${messageOf(e)}` : messageOf(e));
      },
      info: (text) => push("info", text),
    }),
    [push],
  );
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useNotify(): Notifier {
  const v = useContext(Ctx);
  if (!v) throw new Error("useNotify 必須在 NotifyProvider 內使用");
  return v;
}
