// @depends-on ../api.ts (api, ApiError)
// @depends-on ../lib/markdown.ts (HIGHLIGHT_COLOR_OPTIONS, cardIdFromHref, resolveLineInContext, type HighlightColor)
import {
  Children,
  cloneElement,
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import { api, ApiError } from "../api";
import {
  HIGHLIGHT_COLOR_OPTIONS,
  cardIdFromHref,
  resolveLineInContext,
  type HighlightColor,
} from "../lib/markdown";
import { mediaIdFromSrc, mediaUrl, urlTransform } from "../lib/media";
import type { MediaInfo } from "../types";

const infoCache = new Map<string, Promise<MediaInfo>>();
const mediaWidthCache = new Map<string, string>();
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

export function MediaEmbed({
  id,
  explicitWidth,
  onChangeWidth,
  onRemove,
}: {
  id: string;
  explicitWidth?: string;
  onChangeWidth?: (width: string) => void;
  onRemove?: () => void;
}) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [userWidth, setUserWidth] = useState<string | null>(
    () => explicitWidth || mediaWidthCache.get(id) || null,
  );
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setZoomed(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  useEffect(() => {
    if (explicitWidth) {
      mediaWidthCache.set(id, explicitWidth);
      setUserWidth(explicitWidth);
    }
  }, [explicitWidth, id]);

  const changeWidth = (w: string) => {
    mediaWidthCache.set(id, w);
    setUserWidth(w);
    onChangeWidth?.(w);
  };

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
    return (
      <video
        className="nodrag nowheel"
        style={{ width: userWidth ?? "100%", maxWidth: "100%", borderRadius: 4 }}
        src={mediaUrl(id)}
        controls
        preload="metadata"
        onError={onError}
      />
    );

  return (
    <span
      className="media-embed-wrap"
      style={
        userWidth
          ? { display: "block", width: userWidth, maxWidth: "100%" }
          : { display: "inline-block", maxWidth: "100%" }
      }
    >
      <img
        ref={(el) => {
          if (!el) return;
          el.style.setProperty("width", "100%", "important");
          el.style.setProperty("max-width", "100%", "important");
          el.style.setProperty("max-height", "none", "important");
          el.style.setProperty("height", "auto", "important");
          el.style.setProperty("object-fit", "unset", "important");
          el.style.setProperty("margin", "0", "important");
        }}
        src={mediaUrl(id)}
        alt=""
        loading="lazy"
        onError={onError}
        style={{
          width: "100%",
          maxWidth: "100%",
          maxHeight: "none",
          height: "auto",
          objectFit: "unset",
          margin: 0,
          borderRadius: 4,
          display: "block",
        }}
      />
      <span
        className="media-size-bar nodrag nowheel"
        style={{ display: "inline-flex", gap: 4, marginTop: 3 }}
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          style={{
            fontSize: 10,
            padding: "1px 5px",
            opacity: userWidth === "33%" ? 1 : 0.7,
            fontWeight: userWidth === "33%" ? 600 : 400,
            cursor: "pointer",
          }}
          onClick={() => changeWidth("33%")}
        >
          小
        </button>
        <button
          type="button"
          style={{
            fontSize: 10,
            padding: "1px 5px",
            opacity: userWidth === "60%" ? 1 : 0.7,
            fontWeight: userWidth === "60%" ? 600 : 400,
            cursor: "pointer",
          }}
          onClick={() => changeWidth("60%")}
        >
          中
        </button>
        <button
          type="button"
          style={{
            fontSize: 10,
            padding: "1px 5px",
            opacity: userWidth === "100%" ? 1 : 0.7,
            fontWeight: userWidth === "100%" ? 600 : 400,
            cursor: "pointer",
          }}
          onClick={() => changeWidth("100%")}
        >
          滿版
        </button>
        <button
          type="button"
          style={{ fontSize: 10, padding: "1px 5px", opacity: 0.7, cursor: "pointer" }}
          onClick={() => setZoomed(true)}
        >
          🔍 放大
        </button>
        {onRemove && (
          <button
            type="button"
            style={{ fontSize: 10, padding: "1px 5px", opacity: 0.85, color: "#f87171", cursor: "pointer" }}
            onClick={onRemove}
            title="從卡片內文移除此圖片"
          >
            🗑️ 移除
          </button>
        )}
      </span>
      {zoomed &&
        createPortal(
          <div
            className="nodrag nowheel"
            onClick={(e) => {
              e.stopPropagation();
              setZoomed(false);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
            style={{
              position: "fixed",
              inset: 0,
              zIndex: 10000,
              background: "rgba(0, 0, 0, 0.88)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "zoom-out",
            }}
          >
            <img
              src={mediaUrl(id)}
              alt=""
              style={{ width: "96vw", height: "96vh", objectFit: "contain" }}
            />
          </div>,
          document.body,
        )}
    </span>
  );
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

function parseAltWidth(alt: unknown): string | undefined {
  if (typeof alt !== "string") return undefined;
  const pipeIdx = alt.lastIndexOf("|");
  if (pipeIdx < 0) return undefined;
  const raw = alt.slice(pipeIdx + 1).trim();
  if (!raw) return undefined;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) {
    return String(Math.round(num)) + "px";
  }
  if (raw.endsWith("px") || raw.endsWith("%")) {
    const unitLen = raw.endsWith("px") ? -2 : -1;
    const prefix = raw.slice(0, unitLen).trim();
    const unitNum = Number(prefix);
    if (Number.isFinite(unitNum) && unitNum > 0) {
      return raw;
    }
  }
  return undefined;
}

function CodeBlockView({ info, codeText }: { info: string; codeText: string }) {
  const lines = codeText.split("\n");
  const lineCount = lines.length;
  const [collapsed, setCollapsed] = useState(lineCount > 25);
  const [copied, setCopied] = useState(false);

  let lang = info;
  let label = "";
  const colonIdx = info.indexOf(":");
  if (colonIdx >= 0) {
    lang = info.slice(0, colonIdx).trim();
    label = info.slice(colonIdx + 1).trim();
  }

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 忽略剪貼簿權限拒絕 */
    }
  };

  return (
    <div
      className="md-code-block nodrag"
      style={{
        border: "1px solid var(--line, #334155)",
        borderRadius: 6,
        margin: "8px 0",
        overflow: "hidden",
        background: "rgba(15, 23, 42, 0.55)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 8px",
          fontSize: 12,
          background: "rgba(30, 41, 59, 0.85)",
          borderBottom: collapsed ? "none" : "1px solid var(--line, #334155)",
          gap: 8,
        }}
      >
        <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {label ? "📄 " + label : "💻 代碼區塊"}
          <span className="muted" style={{ fontWeight: 400, marginLeft: 6 }}>
            ({lang ? lang + " · " : ""}
            {String(lineCount)} 行)
          </span>
        </span>
        <span style={{ display: "inline-flex", gap: 4, flexShrink: 0 }}>
          <button
            type="button"
            style={{ fontSize: 11, padding: "1px 6px", cursor: "pointer" }}
            onClick={(e) => {
              e.stopPropagation();
              setCollapsed((c) => !c);
            }}
          >
            {collapsed ? "▸ 展開 (" + String(lineCount) + "行)" : "▾ 摺疊"}
          </button>
          <button
            type="button"
            style={{ fontSize: 11, padding: "1px 6px", cursor: "pointer" }}
            onClick={(e) => void handleCopy(e)}
          >
            {copied ? "✓ 已複製" : "📋 複製"}
          </button>
        </span>
      </div>
      {!collapsed && (
        <pre
          className="nowheel"
          style={{
            margin: 0,
            padding: "8px 10px",
            maxHeight: 340,
            overflow: "auto",
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          <code>{codeText}</code>
        </pre>
      )}
    </div>
  );
}

// ---- 自訂清單樣式（◦/▪/▸/✓/(1)/a./A./i.）與行內底線（++...++）、螢光筆（==color:...==）渲染 ----

const CUSTOM_LIST_TOKEN_RE = /^\uE000(UL|OL):([^\uE001]+)\uE001 /;

function preprocessCustomLists(markdown: string): string {
  const FENCE = "`".repeat(3);
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (fenceLen > 0) {
      out.push(line);
      if (t.length >= fenceLen && t.replace(/`/g, "") === "") fenceLen = 0;
      continue;
    }
    if (t.startsWith(FENCE)) {
      let n = 0;
      while (t[n] === "`") n++;
      fenceLen = n;
      out.push(line);
      continue;
    }

    const p = resolveLineInContext(lines, i);
    if (p.type === "ul" && p.bulletStyle && p.bulletStyle !== "dash" && p.markerText) {
      out.push(`${" ".repeat(p.indent)}- \uE000UL:${p.markerText}\uE001 ${p.content}`);
    } else if (p.type === "ol" && p.orderedStyle && p.orderedStyle !== "decimal" && p.markerText) {
      out.push(`${" ".repeat(p.indent)}- \uE000OL:${p.markerText}\uE001 ${p.content}`);
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

function hasCustomListMarker(children: ReactNode): boolean {
  const arr = Children.toArray(children);
  for (const child of arr) {
    if (typeof child === "string") {
      if (CUSTOM_LIST_TOKEN_RE.test(child)) return true;
      if (child.trim().length > 0) return false;
    } else if (isValidElement(child)) {
      const el = child as ReactElement<{ children?: ReactNode }>;
      if (el.type === "ul" || el.type === "ol") return false;
      if (hasCustomListMarker(el.props.children)) return true;
    }
  }
  return false;
}

const HL_COLOR_MAP = new Map<string, (typeof HIGHLIGHT_COLOR_OPTIONS)[number]>(
  HIGHLIGHT_COLOR_OPTIONS.map((o) => [o.color, o]),
);
const COLOR_ALIAS: Record<string, HighlightColor> = {
  amber: "amber",
  yellow: "amber",
  黃: "amber",
  green: "green",
  綠: "green",
  blue: "blue",
  藍: "blue",
  purple: "purple",
  紫: "purple",
  pink: "pink",
  粉: "pink",
  紅: "pink",
};

type RichToken =
  | { kind: "text"; text: string }
  | { kind: "node"; node: ReactNode }
  | { kind: "list_marker"; listKind: "UL" | "OL"; marker: string }
  | { kind: "u_delim"; raw: string; canOpen: boolean; canClose: boolean }
  | { kind: "u_open_tag" }
  | { kind: "u_close_tag" }
  | { kind: "hl_open_explicit"; color: HighlightColor; raw: string }
  | { kind: "hl_delim"; raw: string; canOpen: boolean; canClose: boolean };

const INLINE_TOKEN_RE =
  /\uE000(UL|OL):([^\uE001]+)\uE001 |<\/?u>|==(?:(amber|yellow|green|blue|purple|pink|黃|綠|藍|紫|粉|紅)[:：])|==|\+\+/gi;

function tokenizeRichNodes(children: ReactNode): RichToken[] {
  const arr = Children.toArray(children);
  const tokens: RichToken[] = [];

  for (const child of arr) {
    if (typeof child !== "string") {
      tokens.push({ kind: "node", node: child });
      continue;
    }

    let lastIdx = 0;
    let m: RegExpExecArray | null;
    INLINE_TOKEN_RE.lastIndex = 0;
    while ((m = INLINE_TOKEN_RE.exec(child)) !== null) {
      if (m.index > lastIdx) {
        tokens.push({ kind: "text", text: child.slice(lastIdx, m.index) });
      }
      const raw = m[0];
      const prevChar = m.index > 0 ? child[m.index - 1] : "";
      const nextChar = m.index + raw.length < child.length ? child[m.index + raw.length] : "";

      if (m[1] && m[2]) {
        tokens.push({ kind: "list_marker", listKind: m[1] as "UL" | "OL", marker: m[2] });
      } else if (raw.toLowerCase() === "<u>") {
        tokens.push({ kind: "u_open_tag" });
      } else if (raw.toLowerCase() === "</u>") {
        tokens.push({ kind: "u_close_tag" });
      } else if (m[3]) {
        const cKey = COLOR_ALIAS[m[3].toLowerCase()] ?? "amber";
        tokens.push({ kind: "hl_open_explicit", color: cKey, raw });
      } else if (raw === "==") {
        // 修正：當下一個字元接續 ==color: 時，本處的 == 是前一個螢光筆的結尾，不應被誤判為 triple 等號
        const isNextColorOpen = /^(amber|yellow|green|blue|purple|pink|黃|綠|藍|紫|粉|紅)[:：]/i.test(
          child.slice(m.index + raw.length + 2),
        );
        const isPartOfTriple = (prevChar === "=" || nextChar === "=") && !isNextColorOpen;
        const canOpen = !isPartOfTriple && (nextChar === "" || !/\s/.test(nextChar));
        const canClose = !isPartOfTriple && (prevChar === "" || !/\s/.test(prevChar));
        tokens.push({ kind: "hl_delim", raw, canOpen, canClose });
      } else if (raw === "++") {
        const adjAlphaNum = /[A-Za-z0-9_+]/.test(prevChar) || /[A-Za-z0-9_+]/.test(nextChar);
        const canOpen = !adjAlphaNum && (nextChar === "" || !/\s/.test(nextChar));
        const canClose = !adjAlphaNum && (prevChar === "" || !/\s/.test(prevChar));
        tokens.push({ kind: "u_delim", raw, canOpen, canClose });
      }
      lastIdx = m.index + raw.length;
    }

    if (lastIdx < child.length) {
      tokens.push({ kind: "text", text: child.slice(lastIdx) });
    }
  }
  return tokens;
}

function parseRichTokenStream(tokens: RichToken[], keyPrefix = "r"): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;

  while (i < tokens.length) {
    const tok = tokens[i];

    if (tok.kind === "text") {
      out.push(tok.text);
      i++;
      continue;
    }
    if (tok.kind === "node") {
      if (isValidElement(tok.node)) {
        const el = tok.node as ReactElement<{ children?: ReactNode }>;
        if (el.type === "strong" || el.type === "em" || el.type === "del") {
          out.push(cloneElement(el, { key: `${keyPrefix}-el-${i}` }, renderRichChildren(el.props.children)));
          i++;
          continue;
        }
      }
      out.push(tok.node);
      i++;
      continue;
    }
    if (tok.kind === "list_marker") {
      const isOl = tok.listKind === "OL";
      out.push(
        <span
          key={`${keyPrefix}-lm-${i}`}
          className="custom-list-marker"
          style={{
            display: "inline-block",
            minWidth: isOl ? "1.9em" : "1.35em",
            marginLeft: isOl ? "-1.9em" : "-1.35em",
            color: "var(--accent, #60a5fa)",
            fontWeight: 600,
            userSelect: "none",
          }}
        >
          {tok.marker}{" "}
        </span>,
      );
      i++;
      continue;
    }

    if (tok.kind === "hl_open_explicit") {
      let closeIdx = -1;
      for (let j = i + 1; j < tokens.length; j++) {
        const cand = tokens[j];
        if (cand.kind === "hl_delim" && cand.canClose) {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx > i + 1) {
        const style = HL_COLOR_MAP.get(tok.color) ?? HIGHLIGHT_COLOR_OPTIONS[0];
        const inner = parseRichTokenStream(tokens.slice(i + 1, closeIdx), `${keyPrefix}-hl-${i}`);
        out.push(
          <mark
            key={`${keyPrefix}-mark-${i}`}
            className="md-highlight"
            style={{
              backgroundColor: style.bg,
              color: "inherit",
              borderBottom: `2px solid ${style.border}`,
              padding: "0 4px",
              borderRadius: 3,
            }}
          >
            {inner}
          </mark>,
        );
        i = closeIdx + 1;
        continue;
      }
      out.push(tok.raw);
      i++;
      continue;
    }

    if (tok.kind === "hl_delim") {
      if (tok.canOpen) {
        let closeIdx = -1;
        for (let j = i + 1; j < tokens.length; j++) {
          const cand = tokens[j];
          if (cand.kind === "hl_delim" && cand.canClose) {
            closeIdx = j;
            break;
          }
        }
        if (closeIdx > i + 1) {
          const style = HIGHLIGHT_COLOR_OPTIONS[0];
          const inner = parseRichTokenStream(tokens.slice(i + 1, closeIdx), `${keyPrefix}-hl-${i}`);
          out.push(
            <mark
              key={`${keyPrefix}-mark-${i}`}
              className="md-highlight"
              style={{
                backgroundColor: style.bg,
                color: "inherit",
                borderBottom: `2px solid ${style.border}`,
                padding: "0 4px",
                borderRadius: 3,
              }}
            >
              {inner}
            </mark>,
          );
          i = closeIdx + 1;
          continue;
        }
      }
      out.push(tok.raw);
      i++;
      continue;
    }

    if (tok.kind === "u_delim") {
      if (tok.canOpen) {
        let closeIdx = -1;
        for (let j = i + 1; j < tokens.length; j++) {
          const cand = tokens[j];
          if (cand.kind === "u_delim" && cand.canClose) {
            closeIdx = j;
            break;
          }
        }
        if (closeIdx > i + 1) {
          const inner = parseRichTokenStream(tokens.slice(i + 1, closeIdx), `${keyPrefix}-u-${i}`);
          out.push(
            <u
              key={`${keyPrefix}-u-${i}`}
              style={{
                textDecoration: "underline",
                textDecorationThickness: "1.5px",
                textUnderlineOffset: "3px",
              }}
            >
              {inner}
            </u>,
          );
          i = closeIdx + 1;
          continue;
        }
      }
      out.push(tok.raw);
      i++;
      continue;
    }

    if (tok.kind === "u_open_tag") {
      let closeIdx = -1;
      for (let j = i + 1; j < tokens.length; j++) {
        if (tokens[j].kind === "u_close_tag") {
          closeIdx = j;
          break;
        }
      }
      if (closeIdx > i + 1) {
        const inner = parseRichTokenStream(tokens.slice(i + 1, closeIdx), `${keyPrefix}-ut-${i}`);
        out.push(
          <u
            key={`${keyPrefix}-ut-${i}`}
            style={{
              textDecoration: "underline",
              textDecorationThickness: "1.5px",
              textUnderlineOffset: "3px",
            }}
          >
            {inner}
          </u>,
        );
        i = closeIdx + 1;
        continue;
      }
      i++;
      continue;
    }

    if (tok.kind === "u_close_tag") {
      i++;
      continue;
    }
  }

  return out;
}

function renderRichChildren(children: ReactNode): ReactNode {
  const tokens = tokenizeRichNodes(children);
  const hasSpecial = tokens.some((t) => t.kind !== "text" && t.kind !== "node");
  const hasFormattedElement = tokens.some(
    (t) =>
      t.kind === "node" &&
      isValidElement(t.node) &&
      (t.node.type === "strong" || t.node.type === "em" || t.node.type === "del"),
  );
  if (!hasSpecial && !hasFormattedElement) return children;
  return parseRichTokenStream(tokens);
}

export function Markdown({
  source,
  onOpenCard,
}: {
  source: string;
  onOpenCard?: (cardId: string) => void;
}) {
  const processedSource = useMemo(() => preprocessCustomLists(source), [source]);

  const components = useMemo<React.ComponentProps<typeof ReactMarkdown>["components"]>(
    () => ({
      pre: ({ children }) => <>{children}</>,
      p: ({ children }) => <p>{renderRichChildren(children)}</p>,
      h1: ({ children }) => <h1>{renderRichChildren(children)}</h1>,
      h2: ({ children }) => <h2>{renderRichChildren(children)}</h2>,
      h3: ({ children }) => <h3>{renderRichChildren(children)}</h3>,
      blockquote: ({ children }) => <blockquote>{renderRichChildren(children)}</blockquote>,
      li: ({ children }) => {
        const isCustom = hasCustomListMarker(children);
        return (
          <li style={isCustom ? { listStyleType: "none" } : undefined}>
            {renderRichChildren(children)}
          </li>
        );
      },
      code: ({ className, children }) => {
        const rawText = String(children ?? "");
        const cleanText = rawText.endsWith("\n") ? rawText.slice(0, -1) : rawText;
        const cls = typeof className === "string" ? className : "";
        const isBlock = cls.startsWith("language-") || cleanText.includes("\n");
        if (!isBlock) {
          return <code className={className}>{children}</code>;
        }
        const info = cls.startsWith("language-") ? cls.slice("language-".length) : "";
        return <CodeBlockView codeText={cleanText} info={info} />;
      },
      img: ({ src, alt }) => {
        const id = mediaIdFromSrc(typeof src === "string" ? src : undefined);
        const explicitWidth = parseAltWidth(alt);
        if (id) return <MediaEmbed explicitWidth={explicitWidth} id={id} />;
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
        const safeHref = typeof href === "string" ? href.trim() : "";
        if (!safeHref || safeHref === "#") {
          return <span className="muted">{children}</span>;
        }
        return (
          <a
            href={safeHref}
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </a>
        );
      },
    }),
    [onOpenCard],
  );

  return (
    <div className="md">
      <ReactMarkdown urlTransform={markdownUrlTransform} components={components}>
        {processedSource}
      </ReactMarkdown>
    </div>
  );
}
