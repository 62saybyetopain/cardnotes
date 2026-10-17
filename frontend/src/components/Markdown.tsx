// @depends-on ../api.ts (api, ApiError)
// @depends-on ../lib/markdown.ts (cardIdFromHref)
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import { api, ApiError } from "../api";
import { cardIdFromHref } from "../lib/markdown";
import { mediaIdFromSrc, mediaUrl, urlTransform } from "../lib/media";
import type { MediaInfo } from "../types";

const infoCache = new Map<string, Promise<MediaInfo>>();
function getInfo(id: string): Promise<MediaInfo> {
  let p = infoCache.get(id);
  if (!p) {
    p = api.mediaInfo(id);
    infoCache.set(id, p);
    p.catch(() => infoCache.delete(id)); // 失敗不快取，之後補上檔案就能恢復
  }
  return p;
}

type State = { status: "loading" } | { status: "ok"; info: MediaInfo } | { status: "missing" };

export function MediaEmbed({ id }: { id: string }) {
  const [state, setState] = useState<State>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    getInfo(id).then(
      (info) => alive && setState({ status: "ok", info }),
      () => alive && setState({ status: "missing" }),
    );
    return () => {
      alive = false;
    };
  }, [id]);

  if (state.status === "loading") return <span className="media-loading">載入中…</span>;
  // 遺失一律顯示明確標示，不能是空白
  if (state.status === "missing")
    return (
      <span className="media-missing" role="img" aria-label="圖片遺失">
        圖片遺失：{id.slice(0, 8)}
      </span>
    );
  const onError = () => {
    infoCache.delete(id);
    setState({ status: "missing" });
  };
  if (state.info.kind === "video")
    return <video className="nodrag nowheel" src={mediaUrl(id)} controls preload="metadata" onError={onError} />;
  return <img src={mediaUrl(id)} alt="" loading="lazy" onError={onError} />;
}

// ---- 卡片引用（@ 引用）狀態快取、開啟卡片通道與改名／刪除即時通知 ----
type CardRefResolution =
  | { status: "ok"; title: string }
  | { status: "deleted" }
  | { status: "fallback" };

const cardRefCache = new Map<string, Promise<CardRefResolution>>();
const cardRefListeners = new Map<string, Set<(res: CardRefResolution) => void>>();

function isNotFoundError(e: unknown): boolean {
  if (e instanceof ApiError) {
    return e.status === 404 || e.code === "NOT_FOUND";
  }
  if (e && typeof e === "object") {
    const rec = e as { code?: unknown; status?: unknown };
    return rec.code === "NOT_FOUND" || rec.status === 404;
  }
  return false;
}

function resolveCardTitle(id: string): Promise<CardRefResolution> {
  let p = cardRefCache.get(id);
  if (!p) {
    p = api.cardTitle(id).then(
      (r): CardRefResolution => ({ status: "ok", title: r.title }),
      (e): CardRefResolution => {
        if (isNotFoundError(e)) {
          return { status: "deleted" };
        }
        // 暫時連不上伺服器或非 404 錯誤：不快取失敗，退回顯示原本的文字，絕不誤判成已刪除
        cardRefCache.delete(id);
        return { status: "fallback" };
      },
    );
    cardRefCache.set(id, p);
  }
  return p;
}

export function notifyCardTitleUpdated(id: string, title: string): void {
  const res: CardRefResolution = { status: "ok", title };
  cardRefCache.set(id, Promise.resolve(res));
  cardRefListeners.get(id)?.forEach((fn) => fn(res));
}

export function notifyCardDeleted(id: string): void {
  const res: CardRefResolution = { status: "deleted" };
  cardRefCache.set(id, Promise.resolve(res));
  cardRefListeners.get(id)?.forEach((fn) => fn(res));
}

export function clearCardRefCache(): void {
  cardRefCache.clear();
}

const CardOpenContext = createContext<((cardId: string) => void) | undefined>(undefined);

export function CardOpenProvider({
  onOpenCard,
  children,
}: {
  onOpenCard?: (cardId: string) => void;
  children: ReactNode;
}) {
  return <CardOpenContext.Provider value={onOpenCard}>{children}</CardOpenContext.Provider>;
}

export function CardRef({
  id,
  children,
  onOpenCard,
}: {
  id: string;
  children: ReactNode;
  onOpenCard?: (cardId: string) => void;
}) {
  const ctxOpen = useContext(CardOpenContext);
  const open = onOpenCard ?? ctxOpen;
  const [res, setRes] = useState<CardRefResolution | null>(null);

  useEffect(() => {
    let alive = true;
    resolveCardTitle(id).then((r) => {
      if (alive) setRes(r);
    });
    let set = cardRefListeners.get(id);
    if (!set) {
      set = new Set();
      cardRefListeners.set(id, set);
    }
    const listener = (next: CardRefResolution) => {
      if (alive) setRes(next);
    };
    set.add(listener);
    return () => {
      alive = false;
      set?.delete(listener);
    };
  }, [id]);

  if (res?.status === "deleted") {
    return (
      <span className="card-ref deleted" data-testid={`card-ref-deleted-${id}`}>
        （已刪除的卡片）
      </span>
    );
  }

  const display =
    res?.status === "ok" ? res.title || "（無標題）" : children;

  return (
    <a
      href={`#card:${id}`}
      className="card-ref nodrag"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open?.(id);
      }}
    >
      {display}
    </a>
  );
}

function markdownUrlTransform(url: string, key?: string, node?: unknown): string {
  if (typeof url === "string" && url.startsWith("card:")) {
    return url;
  }
  return (urlTransform as (u: string, k?: string, n?: unknown) => string)(url, key, node);
}

export function Markdown({
  source,
  onOpenCard,
}: {
  source: string;
  onOpenCard?: (cardId: string) => void;
}) {
  return (
    <div className="md">
      <ReactMarkdown
        urlTransform={markdownUrlTransform}
        components={{
          img: ({ src, alt }) => {
            const id = mediaIdFromSrc(typeof src === "string" ? src : undefined);
            if (id) return <MediaEmbed id={id} />;
            if (typeof src === "string" && src) {
              // 外部網址的圖片不載入（避免對外連線），顯示成一般連結
              return (
                <a href={src} target="_blank" rel="noreferrer noopener">
                  [外部圖片：{alt || src}]
                </a>
              );
            }
            return <span className="media-missing">（無效的圖片連結）</span>;
          },
          a: ({ href, children }) => {
            const cardId = cardIdFromHref(typeof href === "string" ? href : undefined);
            if (cardId) {
              return (
                <CardRef id={cardId} onOpenCard={onOpenCard}>
                  {children}
                </CardRef>
              );
            }
            return (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            );
          },
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
