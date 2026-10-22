// @depends-on ../lib/markdown.ts (BULLET_STYLE_OPTIONS, HIGHLIGHT_COLOR_OPTIONS, ORDERED_STYLE_OPTIONS, applyHighlight, applyInlineWrap, applyLineType, detectAtTrigger, detectLineType, detectListStyleAtCursor, formatCardRef, handleListEnter, indentListLines, transformPasteContent)
// @depends-on ./MentionPopup.tsx (MentionPopup)
// @depends-on ./Markdown.tsx (Markdown)
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import {
  BULLET_STYLE_OPTIONS,
  HIGHLIGHT_COLOR_OPTIONS,
  ORDERED_STYLE_OPTIONS,
  applyHighlight,
  applyInlineWrap,
  applyLineType,
  detectAtTrigger,
  detectLineType,
  detectListStyleAtCursor,
  formatCardRef,
  handleListEnter,
  indentListLines,
  transformPasteContent,
  type BulletStyle,
  type EditPatch,
  type HighlightColor,
  type LineType,
  type OrderedStyle,
} from "../lib/markdown";
import { insertAtCursor, isAcceptedMime, mediaRef } from "../lib/media";
import { messageOf } from "../notify";
import type { BoardLink, CardDetail } from "../types";
import { Markdown, MediaEmbed } from "./Markdown";
import { MentionPopup } from "./MentionPopup";

type Status = "saved" | "dirty" | "saving" | "error" | "conflict";

interface Props {
  card: CardDetail;
  compact?: boolean;
  onSaved(card: CardDetail): void;
  onReload(): void;
  onLinkAdded?(sourceId: string, targetId: string, extra?: Partial<BoardLink>): void;
  onOpenCard?(cardId: string): void;
  report(e: unknown, prefix?: string): void;
}

type BodySegment =
  | { kind: "text"; text: string; start: number; end: number }
  | {
      kind: "media";
      mediaId: string;
      alt: string;
      explicitWidth?: string;
      rawStart: number;
      rawEnd: number;
      removeStart: number;
      removeEnd: number;
    };

const INLINE_MEDIA_RE = /!\[([^\]]*)\]\(media:([0-9a-fA-F-]{36})\)/g;

function extractWidthFromAlt(alt: string): { baseAlt: string; width?: string } {
  const pipeIdx = alt.lastIndexOf("|");
  if (pipeIdx < 0) return { baseAlt: alt };
  const raw = alt.slice(pipeIdx + 1).trim();
  const baseAlt = alt.slice(0, pipeIdx);
  if (/^\d+(px|%)?$/.test(raw)) {
    return { baseAlt, width: raw.endsWith("px") || raw.endsWith("%") ? raw : `${raw}px` };
  }
  return { baseAlt: alt };
}

function splitBodySegments(body: string): BodySegment[] {
  const matches: { index: number; end: number; alt: string; mediaId: string }[] = [];
  let m: RegExpExecArray | null;
  INLINE_MEDIA_RE.lastIndex = 0;
  while ((m = INLINE_MEDIA_RE.exec(body)) !== null) {
    matches.push({
      index: m.index,
      end: m.index + m[0].length,
      alt: m[1] ?? "",
      mediaId: m[2],
    });
  }
  if (matches.length === 0) {
    return [{ kind: "text", text: body, start: 0, end: body.length }];
  }

  const segments: BodySegment[] = [];
  let prevEnd = 0;
  for (const hit of matches) {
    const sepBefore = hit.index > prevEnd && body[hit.index - 1] === "\n" ? 1 : 0;
    const textEnd = hit.index - sepBefore;
    segments.push({
      kind: "text",
      text: body.slice(prevEnd, textEnd),
      start: prevEnd,
      end: textEnd,
    });

    const sepAfter = hit.end < body.length && body[hit.end] === "\n" ? 1 : 0;
    const { width } = extractWidthFromAlt(hit.alt);
    segments.push({
      kind: "media",
      mediaId: hit.mediaId,
      alt: hit.alt,
      explicitWidth: width,
      rawStart: hit.index,
      rawEnd: hit.end,
      removeStart: hit.index - sepBefore,
      removeEnd: sepBefore === 0 ? hit.end + sepAfter : hit.end,
    });
    prevEnd = hit.end + sepAfter;
  }

  segments.push({
    kind: "text",
    text: body.slice(prevEnd),
    start: prevEnd,
    end: body.length,
  });
  return segments;
}

const STATUS_TEXT: Record<Status, string> = {
  saved: "已儲存",
  dirty: "未儲存",
  saving: "儲存中…",
  error: "儲存失敗",
  conflict: "版本衝突",
};

const LINE_TYPE_BUTTONS: readonly { type: LineType; label: string }[] = [
  { type: "p", label: "段落" },
  { type: "h1", label: "標題 1" },
  { type: "h2", label: "標題 2" },
  { type: "h3", label: "標題 3" },
];

export function Editor({ card, compact = false, onSaved, onReload, onLinkAdded, onOpenCard, report }: Props) {
  const [title, setTitle] = useState(card.title);
  const [body, setBody] = useState(card.body);
  const [cursorPos, setCursorPos] = useState(0);
  const [previewing, setPreviewing] = useState(false);
  const [status, setStatus] = useState<Status>("saved");
  const [errorMsg, setErrorMsg] = useState("");
  const [uploading, setUploading] = useState(0);
  const [warnings, setWarnings] = useState(card.warnings);
  const [mentionState, setMentionState] = useState<{
    replaceFrom: number;
    replaceTo: number;
    initialQuery: string;
  } | null>(null);

  const versionRef = useRef(card.updated_at);
  const latest = useRef({ title: card.title, body: card.body });
  const savingRef = useRef(false);
  const pendingRef = useRef(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const statusRef = useRef<Status>("saved");
  statusRef.current = status;

  const markDirty = () => setStatus((s) => (s === "conflict" ? s : "dirty"));

  const saveRef = useRef<(() => Promise<void>) | undefined>(undefined);
  saveRef.current = async () => {
    if (savingRef.current) {
      pendingRef.current = true;
      return;
    }
    savingRef.current = true;
    setStatus("saving");
    const snap = { ...latest.current };
    try {
      const updated = await api.patchCard(card.id, snap, versionRef.current);
      versionRef.current = updated.updated_at;
      setWarnings(updated.warnings);
      onSaved(updated);
      const unchanged = latest.current.title === snap.title && latest.current.body === snap.body;
      setStatus(unchanged ? "saved" : "dirty");
    } catch (e) {
      if (e instanceof ApiError && e.code === "STALE_VERSION") setStatus("conflict");
      else {
        setStatus("error");
        setErrorMsg(messageOf(e));
      }
      pendingRef.current = false;
    } finally {
      savingRef.current = false;
      if (pendingRef.current) {
        pendingRef.current = false;
        void saveRef.current?.();
      }
    }
  };

  useEffect(() => {
    if (status !== "dirty" || uploading > 0) return;
    const t = setTimeout(() => void saveRef.current?.(), 1000);
    return () => clearTimeout(t);
  }, [title, body, status, uploading]);

  // 元件卸載（例如在白板結束內嵌編輯或切換卡片）時，若仍有未儲存變更則立即沖刷存檔
  useEffect(() => {
    return () => {
      if (statusRef.current === "dirty" && !savingRef.current) {
        void saveRef.current?.();
      }
    };
  }, []);

  useEffect(() => {
    const unsafe = status !== "saved" || uploading > 0;
    if (!unsafe) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [status, uploading]);

  const onTitle = (v: string) => {
    latest.current.title = v;
    setTitle(v);
    markDirty();
  };
  const onBody = (v: string) => {
    latest.current.body = v;
    setBody(v);
    markDirty();
  };

  const activeSegStartRef = useRef(0);
  const segRefs = useRef<Map<number, HTMLTextAreaElement>>(new Map());

  const getGlobalSelection = (): { start: number; end: number } => {
    const el = textRef.current;
    const offset = activeSegStartRef.current;
    if (el && document.activeElement === el) {
      return {
        start: offset + (el.selectionStart ?? 0),
        end: offset + (el.selectionEnd ?? el.selectionStart ?? 0),
      };
    }
    return { start: cursorPos, end: cursorPos };
  };

  const applyEditPatch = useCallback((patch: EditPatch) => {
    onBody(patch.text);
    setCursorPos(patch.selectionStart);
    requestAnimationFrame(() => {
      const nextSegs = splitBodySegments(patch.text);
      for (const s of nextSegs) {
        if (s.kind === "text" && patch.selectionStart >= s.start && patch.selectionStart <= s.end) {
          const el = segRefs.current.get(s.start);
          if (el) {
            textRef.current = el;
            activeSegStartRef.current = s.start;
            el.focus();
            const localStart = Math.max(0, patch.selectionStart - s.start);
            const localEnd = Math.max(localStart, Math.min(s.end - s.start, patch.selectionEnd - s.start));
            el.setSelectionRange(localStart, localEnd);
          }
          break;
        }
      }
    });
  }, []);

  const [bulletStyle, setBulletStyle] = useState<BulletStyle>("dash");
  const [orderedStyle, setOrderedStyle] = useState<OrderedStyle>("decimal");
  const [highlightColor, setHighlightColor] = useState<HighlightColor>("amber");

  const handleToolbarLineType = (
    targetType: LineType,
    styleOpts?: { bulletStyle?: BulletStyle; orderedStyle?: OrderedStyle },
  ) => {
    const { start: selStart, end: selEnd } = getGlobalSelection();
    const patch = applyLineType(latest.current.body, selStart, selEnd, targetType, styleOpts);
    applyEditPatch(patch);
  };

  const handleToolbarInlineWrap = (marker: "**" | "++", placeholder: string) => {
    const { start: selStart, end: selEnd } = getGlobalSelection();
    const patch = applyInlineWrap(latest.current.body, selStart, selEnd, marker, placeholder);
    applyEditPatch(patch);
  };

  const handleToolbarHighlight = (color: HighlightColor | null) => {
    const { start: selStart, end: selEnd } = getGlobalSelection();
    if (color) setHighlightColor(color);
    const patch = applyHighlight(latest.current.body, selStart, selEnd, color);
    if (patch) applyEditPatch(patch);
  };

  const handleToolbarIndent = (direction: 1 | -1) => {
    const { start: selStart, end: selEnd } = getGlobalSelection();
    const patch = indentListLines(latest.current.body, selStart, selEnd, direction);
    if (patch) applyEditPatch(patch);
  };

  const openMentionFromToolbar = () => {
    const { start, end } = getGlobalSelection();
    setMentionState({ replaceFrom: start, replaceTo: end, initialQuery: "" });
  };

  const handleSelectMention = async (target: { id: string; title: string }) => {
    if (!mentionState) return;
    try {
      const link = await api.putLink(card.id, target.id, {
        relation_type: "extend",
        status: "confirmed",
        reason: "",
      });
      const refMarkdown = formatCardRef(target.id, target.title);
      const curBody = latest.current.body;
      const from = Math.max(0, Math.min(curBody.length, mentionState.replaceFrom));
      const to = Math.max(from, Math.min(curBody.length, mentionState.replaceTo));
      const nextText = curBody.slice(0, from) + refMarkdown + curBody.slice(to);
      const nextCursor = from + refMarkdown.length;

      setMentionState(null);
      applyEditPatch({
        text: nextText,
        selectionStart: nextCursor,
        selectionEnd: nextCursor,
        replaceFrom: from,
        replaceTo: to,
        insertText: refMarkdown,
      });
      onLinkAdded?.(card.id, target.id, link);
    } catch (e) {
      report(e, "建立引用連結失敗");
    }
  };

  const uploadFiles = async (files: File[], at: number) => {
    setUploading((n) => n + files.length);
    let cursor = at;
    for (const f of files) {
      try {
        const info = await api.uploadMedia(f);
        const r = insertAtCursor(latest.current.body, cursor, cursor, mediaRef(info.id) + "\n");
        cursor = r.cursor;
        onBody(r.text);
        requestAnimationFrame(() => textRef.current?.setSelectionRange(r.cursor, r.cursor));
      } catch (e) {
        report(e, `上傳「${f.name}」失敗，未插入任何內容`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const takeFiles = (list: FileList | null | undefined): File[] => {
    const all = Array.from(list ?? []);
    if (!all.length) return [];
    const ok = all.filter((f) => isAcceptedMime(f.type));
    if (ok.length < all.length) {
      report(new Error("支援 PNG／JPEG／WebP／GIF 圖片與 MP4／WebM 影片"), "已略過不支援的檔案");
    }
    return ok;
  };

  const copyMine = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(`${latest.current.title}\n\n${latest.current.body}`);
    } catch (e) {
      report(e, "複製失敗");
    }
  }, [report]);

  const [codePatchOpen, setCodePatchOpen] = useState(false);

  const insertCodeBlock = () => {
    const label = window.prompt("輸入代碼塊名稱或檔名（例如 Board.tsx，可留空）", "");
    if (label === null) return;
    const cleanLabel = label.trim().replace(/\s+/g, "_");
    const extIdx = cleanLabel.lastIndexOf(".");
    const ext = extIdx >= 0 ? cleanLabel.slice(extIdx + 1).toLowerCase() : "tsx";
    const lang = ext || "tsx";
    const header = cleanLabel ? "```" + lang + ":" + cleanLabel : "```" + lang;

    const cur = latest.current.body;
    const { start: from, end: to } = getGlobalSelection();
    const selectedText = cur.slice(from, to);
    const prefixNewline = from > 0 && cur[from - 1] !== "\n" ? "\n\n" : "";
    const insertText = prefixNewline + header + "\n" + selectedText + "\n```\n";
    const nextText = cur.slice(0, from) + insertText + cur.slice(to);
    const cursorInside = from + prefixNewline.length + header.length + 1 + selectedText.length;

    applyEditPatch({
      text: nextText,
      selectionStart: cursorInside,
      selectionEnd: cursorInside,
      replaceFrom: from,
      replaceTo: to,
      insertText,
    });
  };

  const currentLineType = detectLineType(body, cursorPos);
  const currentListStyle = detectListStyleAtCursor(body, cursorPos);
  const activeBulletStyle = currentListStyle.bulletStyle ?? bulletStyle;
  const activeOrderedStyle = currentListStyle.orderedStyle ?? orderedStyle;
  const activeHighlightMeta =
    HIGHLIGHT_COLOR_OPTIONS.find((c) => c.color === highlightColor) ?? HIGHLIGHT_COLOR_OPTIONS[0];
  const missingMediaCount = warnings
    .filter((w) => w.code === "MISSING_MEDIA")
    .reduce((n, w) => n + w.ids.length, 0);
  const missingCardCount = warnings
    .filter((w) => w.code === "MISSING_CARD")
    .reduce((n, w) => n + w.ids.length, 0);

  return (
    <div className="editor">
      <div className="editor-head">
        <input
          className="title-input"
          value={title}
          placeholder="卡片標題"
          onChange={(e) => onTitle(e.target.value)}
          aria-label="卡片標題"
        />
        <span className={`status ${status}`} data-testid="save-status">
          {uploading > 0 ? `上傳中（${uploading}）…` : STATUS_TEXT[status]}
        </span>
      </div>
      {status === "conflict" && (
        <div className="banner danger" role="alert">
          這張卡片已在別處被修改，你的修改尚未儲存。
          <button onClick={onReload}>重新載入（捨棄我的修改）</button>
          <button onClick={() => void copyMine()}>複製我的內容</button>
        </div>
      )}
      {status === "error" && (
        <div className="banner danger" role="alert">
          儲存失敗：{errorMsg}（內容仍保留在這裡）
          <button onClick={() => void saveRef.current?.()}>重試</button>
        </div>
      )}
      {missingMediaCount > 0 && (
        <div className="banner warn" role="alert">
          內文引用了 {missingMediaCount} 個不存在的媒體。
        </div>
      )}
      {missingCardCount > 0 && (
        <div className="banner warn" role="alert">
          內文引用了 {missingCardCount} 張不存在的卡片。
        </div>
      )}

      <div className="editor-toolbar" role="toolbar" aria-label="格式與引用工具列">
        {!previewing && (
          <>
            {LINE_TYPE_BUTTONS.map((btn) => (
              <button
                key={btn.type}
                type="button"
                className={currentLineType === btn.type ? "on" : ""}
                aria-pressed={currentLineType === btn.type}
                onClick={() => handleToolbarLineType(btn.type)}
              >
                {btn.label}
              </button>
            ))}

            {/* 項目符號（主按鈕＋5 種樣式選單） */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
              <button
                type="button"
                className={currentLineType === "ul" ? "on" : ""}
                aria-pressed={currentLineType === "ul"}
                onClick={() => handleToolbarLineType("ul", { bulletStyle: activeBulletStyle })}
                title="套用或取消項目符號"
              >
                項目符號
              </button>
              <select
                value={activeBulletStyle}
                aria-label="選擇項目符號樣式"
                title="切換項目符號樣式（• / ◦ / ▪ / ▸ / ✓）"
                style={{ padding: "2px 2px", fontSize: 12, maxWidth: 54 }}
                onChange={(e) => {
                  const next = e.target.value as BulletStyle;
                  setBulletStyle(next);
                  handleToolbarLineType("ul", { bulletStyle: next });
                }}
              >
                {BULLET_STYLE_OPTIONS.map((o) => (
                  <option key={o.style} value={o.style}>
                    {o.label}
                  </option>
                ))}
              </select>
            </span>

            {/* 編號清單（主按鈕＋5 種樣式選單） */}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
              <button
                type="button"
                className={currentLineType === "ol" ? "on" : ""}
                aria-pressed={currentLineType === "ol"}
                onClick={() => handleToolbarLineType("ol", { orderedStyle: activeOrderedStyle })}
                title="套用或取消編號清單"
              >
                編號
              </button>
              <select
                value={activeOrderedStyle}
                aria-label="選擇編號清單樣式"
                title="切換編號樣式（1. / (1) / a. / A. / i.）"
                style={{ padding: "2px 2px", fontSize: 12, maxWidth: 58 }}
                onChange={(e) => {
                  const next = e.target.value as OrderedStyle;
                  setOrderedStyle(next);
                  handleToolbarLineType("ol", { orderedStyle: next });
                }}
              >
                {ORDERED_STYLE_OPTIONS.map((o) => (
                  <option key={o.style} value={o.style}>
                    {o.label}
                  </option>
                ))}
              </select>
            </span>

            <button
              type="button"
              onClick={() => handleToolbarIndent(1)}
              disabled={currentLineType !== "ul" && currentLineType !== "ol"}
            >
              縮排
            </button>
            <button
              type="button"
              onClick={() => handleToolbarIndent(-1)}
              disabled={currentLineType !== "ul" && currentLineType !== "ol"}
            >
              取消縮排
            </button>

            {/* 粗體與底線 */}
            <button
              type="button"
              onClick={() => handleToolbarInlineWrap("**", "粗體文字")}
              title="粗體 (**文字**，快捷鍵 Ctrl+B)"
              style={{ fontWeight: 700 }}
            >
              B 粗體
            </button>
            <button
              type="button"
              onClick={() => handleToolbarInlineWrap("++", "底線文字")}
              title="底線 (++文字++，快捷鍵 Ctrl+U)"
              style={{ textDecoration: "underline" }}
            >
              U 底線
            </button>

            {/* 螢光筆重點（主按鈕＋5 種深色主題色點＋清除） */}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                padding: "1px 6px",
                borderRadius: 6,
                border: "1px solid var(--line, #334155)",
                background: "rgba(15, 23, 42, 0.45)",
              }}
            >
              <button
                type="button"
                onClick={() => handleToolbarHighlight(highlightColor)}
                title={`套用或取消螢光筆（目前顏色：${activeHighlightMeta.label}）`}
                style={{
                  border: "none",
                  background: "transparent",
                  padding: "1px 4px",
                  borderBottom: `3px solid ${activeHighlightMeta.dotColor}`,
                  cursor: "pointer",
                }}
              >
                🖍 螢光筆
              </button>
              {HIGHLIGHT_COLOR_OPTIONS.map((c) => (
                <button
                  key={c.color}
                  type="button"
                  aria-label={`螢光筆：${c.label}`}
                  title={`螢光筆：${c.label}（選取文字後點擊直接套用或換色）`}
                  onClick={() => handleToolbarHighlight(c.color)}
                  style={{
                    width: 14,
                    height: 14,
                    padding: 0,
                    borderRadius: "50%",
                    background: c.dotColor,
                    border:
                      highlightColor === c.color
                        ? "2px solid #ffffff"
                        : "1px solid rgba(255,255,255,0.25)",
                    cursor: "pointer",
                  }}
                />
              ))}
              <button
                type="button"
                onClick={() => handleToolbarHighlight(null)}
                title="移除選取文字的螢光筆標記"
                style={{ fontSize: 11, padding: "0 4px", cursor: "pointer" }}
              >
                ✕
              </button>
            </span>

            <button type="button" onClick={openMentionFromToolbar}>
              @ 引用
            </button>
            <button type="button" onClick={insertCodeBlock} title="在卡片中插入可命名的代碼區塊">
              ＋ 代碼塊
            </button>
            <button
              type="button"
              onClick={() => setCodePatchOpen(true)}
              title="對卡片內的代碼塊或外部代碼執行精確定位與自動取代"
            >
              定位取代
            </button>
          </>
        )}
        <button
          type="button"
          className={`preview-toggle-btn${previewing ? " on" : ""}`}
          onClick={() => {
            setPreviewing((p) => {
              const next = !p;
              if (next) setMentionState(null);
              return next;
            });
          }}
        >
          {previewing ? "✎ 返回編輯" : "👁 預覽"}
        </button>
      </div>

      {!previewing && mentionState && (
        <MentionPopup
          currentCardId={card.id}
          initialQuery={mentionState.initialQuery}
          onSelect={handleSelectMention}
          onCancel={() => {
            setMentionState(null);
            textRef.current?.focus();
          }}
          report={report}
        />
      )}

      {codePatchOpen && (
        <CodeReplaceModal
          cardBody={body}
          cursorPos={cursorPos}
          onClose={() => setCodePatchOpen(false)}
          onApplyPatch={(patch) => {
            applyEditPatch(patch);
          }}
        />
      )}

      {!previewing ? (
        (() => {
          const segments = splitBodySegments(body);
          const hasMedia = segments.length > 1;
          return (
            <div
              className={hasMedia ? "body-input segmented-editor" : "segmented-editor-single"}
              style={
                hasMedia
                  ? {
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      overflowY: "auto",
                      padding: 8,
                      minHeight: compact ? 120 : 220,
                    }
                  : { display: "flex", flexDirection: "column", flex: 1, minHeight: compact ? 120 : undefined }
              }
            >
              {segments.map((seg, idx) => {
                if (seg.kind === "media") {
                  return (
                    <div
                      key={`media-${seg.mediaId}-${seg.rawStart}`}
                      style={{
                        padding: "4px 6px",
                        borderRadius: 6,
                        background: "rgba(15, 23, 42, 0.35)",
                        border: "1px solid var(--line, #334155)",
                      }}
                    >
                      <MediaEmbed
                        id={seg.mediaId}
                        explicitWidth={seg.explicitWidth}
                        onChangeWidth={(w) => {
                          const { baseAlt } = extractWidthFromAlt(seg.alt);
                          const nextToken = `![${baseAlt}|${w}](media:${seg.mediaId})`;
                          const cur = latest.current.body;
                          onBody(cur.slice(0, seg.rawStart) + nextToken + cur.slice(seg.rawEnd));
                        }}
                        onRemove={() => {
                          const cur = latest.current.body;
                          onBody(cur.slice(0, seg.removeStart) + cur.slice(seg.removeEnd));
                        }}
                      />
                    </div>
                  );
                }

                const lineCount = Math.max(1, seg.text.split("\n").length);
                return (
                  <textarea
                    key={`text-${idx}`}
                    ref={(el) => {
                      if (el) {
                        segRefs.current.set(seg.start, el);
                        if (idx === 0 && !textRef.current) {
                          textRef.current = el;
                        }
                      } else {
                        segRefs.current.delete(seg.start);
                      }
                    }}
                    className={hasMedia ? "body-segment-input" : "body-input"}
                    rows={hasMedia ? Math.max(2, lineCount) : undefined}
                    style={
                      hasMedia
                        ? {
                            width: "100%",
                            resize: "vertical",
                            border: "1px dashed rgba(148, 163, 184, 0.25)",
                            borderRadius: 4,
                            background: "transparent",
                            color: "inherit",
                            padding: "4px 6px",
                            fontFamily: "inherit",
                            fontSize: "inherit",
                            lineHeight: 1.5,
                          }
                        : compact
                          ? { minHeight: 110 }
                          : undefined
                    }
                    value={seg.text}
                    placeholder={
                      idx === 0
                        ? "內文（Markdown）。可直接貼上或拖入圖片、影片，或輸入 @ 引用其他卡片。"
                        : "繼續輸入段落內容（支援 Markdown 語法）…"
                    }
                    aria-label={idx === 0 ? "卡片內文" : `卡片內文段落 ${idx + 1}`}
                    onFocus={(e) => {
                      textRef.current = e.currentTarget;
                      activeSegStartRef.current = seg.start;
                    }}
                    onSelect={(e) => {
                      textRef.current = e.currentTarget;
                      activeSegStartRef.current = seg.start;
                      setCursorPos(seg.start + (e.currentTarget.selectionStart ?? 0));
                    }}
                    onKeyUp={(e) => {
                      textRef.current = e.currentTarget;
                      activeSegStartRef.current = seg.start;
                      setCursorPos(seg.start + (e.currentTarget.selectionStart ?? 0));
                    }}
                    onClick={(e) => {
                      textRef.current = e.currentTarget;
                      activeSegStartRef.current = seg.start;
                      setCursorPos(seg.start + (e.currentTarget.selectionStart ?? 0));
                    }}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      const el = e.currentTarget;
                      const gStart = seg.start + (el.selectionStart ?? 0);
                      const gEnd = seg.start + (el.selectionEnd ?? 0);
                      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
                        const k = e.key.toLowerCase();
                        if (k === "b") {
                          e.preventDefault();
                          applyEditPatch(applyInlineWrap(latest.current.body, gStart, gEnd, "**", "粗體文字"));
                          return;
                        }
                        if (k === "u") {
                          e.preventDefault();
                          applyEditPatch(applyInlineWrap(latest.current.body, gStart, gEnd, "++", "底線文字"));
                          return;
                        }
                      }
                      if (e.key === "Tab") {
                        const patch = indentListLines(latest.current.body, gStart, gEnd, e.shiftKey ? -1 : 1);
                        if (!patch) return;
                        e.preventDefault();
                        applyEditPatch(patch);
                        return;
                      }
                      if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        const patch = handleListEnter(latest.current.body, gStart, gEnd);
                        if (!patch) return;
                        e.preventDefault();
                        applyEditPatch(patch);
                      }
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      const localPos = e.currentTarget.selectionStart ?? val.length;
                      const cur = latest.current.body;
                      const prevLen = cur.length;
                      const nextBody = cur.slice(0, seg.start) + val + cur.slice(seg.end);
                      const globalPos = seg.start + localPos;
                      onBody(nextBody);
                      setCursorPos(globalPos);
                      if (nextBody.length >= prevLen && globalPos > 0 && nextBody[globalPos - 1] === "@") {
                        const trig = detectAtTrigger(nextBody, globalPos);
                        if (trig && trig.query === "") {
                          setMentionState({
                            replaceFrom: trig.atIndex,
                            replaceTo: globalPos,
                            initialQuery: "",
                          });
                        }
                      }
                    }}
                    onPaste={(e) => {
                      const gFrom = seg.start + (e.currentTarget.selectionStart ?? seg.text.length);
                      const gTo = seg.start + (e.currentTarget.selectionEnd ?? e.currentTarget.selectionStart ?? seg.text.length);
                      if (e.clipboardData.files.length) {
                        e.preventDefault();
                        const files = takeFiles(e.clipboardData.files);
                        if (files.length) void uploadFiles(files, gFrom);
                        return;
                      }
                      const plain = e.clipboardData.getData("text/plain");
                      const html = e.clipboardData.getData("text/html");
                      const transformed = transformPasteContent(plain, html);
                      if (transformed === null) return;
                      e.preventDefault();
                      const cur = latest.current.body;
                      const nextText = cur.slice(0, gFrom) + transformed + cur.slice(gTo);
                      const nextCursor = gFrom + transformed.length;
                      applyEditPatch({
                        text: nextText,
                        selectionStart: nextCursor,
                        selectionEnd: nextCursor,
                        replaceFrom: gFrom,
                        replaceTo: gTo,
                        insertText: transformed,
                      });
                    }}
                    onDragOver={(e) => {
                      if (e.dataTransfer.types.includes("Files")) e.preventDefault();
                    }}
                    onDrop={(e) => {
                      if (!e.dataTransfer.files.length) return;
                      e.preventDefault();
                      const gAt = seg.start + (e.currentTarget.selectionStart ?? seg.text.length);
                      const files = takeFiles(e.dataTransfer.files);
                      if (files.length) void uploadFiles(files, gAt);
                    }}
                  />
                );
              })}
            </div>
          );
        })()
      ) : (
        <div className="preview" data-testid="editor-preview">
          <Markdown source={body} onOpenCard={onOpenCard} />
        </div>
      )}
    </div>
  );
}
// ---- 多代碼塊掃描、模式 B 智慧拆解與唯一性定位取代 ----

interface ParsedCodeBlock {
  index: number;
  info: string;
  label: string;
  content: string;
  contentStart: number;
  contentEnd: number;
  lineCount: number;
}

function extractCodeBlocks(markdown: string): ParsedCodeBlock[] {
  const blocks: ParsedCodeBlock[] = [];
  let pos = 0;
  let idx = 0;
  while (pos < markdown.length) {
    const openTick = markdown.indexOf("```", pos);
    if (openTick < 0) break;
    const isLineStart = openTick === 0 || markdown[openTick - 1] === "\n";
    if (!isLineStart) {
      pos = openTick + 3;
      continue;
    }
    const lineEnd = markdown.indexOf("\n", openTick + 3);
    if (lineEnd < 0) break;
    const info = markdown.slice(openTick + 3, lineEnd).trim();
    const contentStart = lineEnd + 1;

    let closeSearch = contentStart;
    let contentEnd = -1;
    let nextPos = -1;
    while (closeSearch <= markdown.length) {
      const closeTick = markdown.indexOf("```", closeSearch);
      if (closeTick < 0) break;
      const atStart = closeTick === 0 || markdown[closeTick - 1] === "\n";
      const afterClose = markdown.indexOf("\n", closeTick + 3);
      const restLine =
        afterClose >= 0 ? markdown.slice(closeTick + 3, afterClose).trim() : markdown.slice(closeTick + 3).trim();
      if (atStart && restLine === "") {
        contentEnd = closeTick > contentStart && markdown[closeTick - 1] === "\n" ? closeTick - 1 : closeTick;
        nextPos = afterClose >= 0 ? afterClose + 1 : markdown.length;
        break;
      }
      closeSearch = closeTick + 3;
    }

    if (contentEnd < 0) break;
    const content = markdown.slice(contentStart, contentEnd);
    const colonIdx = info.indexOf(":");
    const label = colonIdx >= 0 ? info.slice(colonIdx + 1).trim() : info || "代碼塊 #" + String(idx + 1);
    blocks.push({
      index: idx,
      info,
      label,
      content,
      contentStart,
      contentEnd,
      lineCount: content.split("\n").length,
    });
    idx += 1;
    pos = nextPos;
  }
  return blocks;
}

function normalizeCodeText(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u00A0/g, " ");
}

interface PatchPair {
  findText: string;
  replaceText: string;
}

// 識別網頁複製 AI 代碼塊時常見的頂部單行語言標籤（例如 "TypeScript", "tsx", "python", "Copy code" 等）
const AI_LANG_HEADER_RE =
  /^(typescript|javascript|ts|tsx|js|jsx|python|py|sql|sqlite|json|html|css|scss|bash|sh|shell|yaml|yml|toml|markdown|md|diff|plaintext|text|c|cpp|csharp|java|go|rust|ruby|php|swift|kotlin)(\s+(copy(\s+code)?|複製(\s*代碼|\s*程式碼)?))?$/i;

// 識別 AI 代碼塊下方常見的說明段落或下一小節標題（無圍欄複製時應從此行起截斷）
function isAiTrailingProseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // 1. 明確的中文說明前綴、章節標籤或檢查點標題
  if (
    /^(原因|問題原因|說明|注意|備註|為什麼|驗證方式|下一步|修改說明)\s*[：:]/.test(t) ||
    /^#{1,6}\s+(檢查點|步驟|檔案|修改|\d+\.)/.test(t) ||
    /^(檢查點\s*\d+|【[A-Z0-9一二三四五六七八九十]+】)/.test(t) ||
    /^[-*]{3,}\s*$/.test(t)
  ) {
    return true;
  }
  // 2. 下一處的檔案標題行，例如：`lib/storage/httpDriver.ts（一處）` 或 `#### api.ts（兩處）`
  const cleanTitle = t.replace(/^#{1,6}\s*/, "").replace(/`/g, "").trim();
  if (
    /^[a-zA-Z0-9_./-]+\.(ts|tsx|js|jsx|py|sql|json|css|md|html)\s*([（(][^）)]*[）)])?$/.test(cleanTitle)
  ) {
    return true;
  }
  return false;
}

// 統一淨化器：同時支援「有 ``` 圍欄」與「無圍欄（從網頁直接複製含 TypeScript 標題與下方原因說明）」
function stripOuterFence(raw: string): string {
  const FENCE = "`".repeat(3);
  const trimBlank = (arr: string[]): string[] => {
    let a = arr;
    while (a.length > 0 && a[0].trim() === "") a = a.slice(1);
    while (a.length > 0 && a[a.length - 1].trim() === "") a = a.slice(0, -1);
    return a;
  };
  let lines = trimBlank(normalizeCodeText(raw).split("\n"));
  if (lines.length === 0) return "";

  // Case A: 首尾有 ``` 圍欄
  if (lines.length >= 2) {
    const first = lines[0].trim();
    const last = lines[lines.length - 1].trim();
    if (first.startsWith(FENCE) && last.length >= 3 && last.replace(/`/g, "") === "") {
      return trimBlank(lines.slice(1, -1)).join("\n");
    }
  }

  // Case B: 無圍欄（網頁直接反白複製），剝除首行語言標籤（如 TypeScript / Copy code）
  while (lines.length > 0) {
    const first = lines[0].trim();
    if (
      AI_LANG_HEADER_RE.test(first) ||
      /^(copy(\s+code)?|複製(\s*代碼|\s*程式碼)?)$/i.test(first)
    ) {
      lines = trimBlank(lines.slice(1));
    } else {
      break;
    }
  }

  // 剝除尾部的說明文字或下一個檔案標題（如「原因：...」、「lib/storage/httpDriver.ts（一處）」）
  let cutIdx = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (isAiTrailingProseLine(lines[i])) {
      cutIdx = i;
      break;
    }
  }
  lines = trimBlank(lines.slice(0, cutIdx));
  return lines.join("\n");
}

function parseAiPatchPairs(rawInput: string): PatchPair[] {
  const text = normalizeCodeText(rawInput);
  const findMarker = "【尋找這段代碼】";
  const replaceMarker = "【替換為以下代碼】";
  const FENCE = "`".repeat(3);
  const lines = text.split("\n");

  // 逐行掃描：圍欄內的任何文字（含代碼裡的字串常數）一律不當標記；
  // 標記只在圍欄外、且去除標題／粗體／編號裝飾後以標記開頭的行才成立
  const marks: { kind: "find" | "replace"; line: number }[] = [];
  let fenceLen = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (fenceLen > 0) {
      if (t.length >= fenceLen && t.replace(/`/g, "") === "") fenceLen = 0;
      continue;
    }
    if (t.startsWith(FENCE)) {
      let n = 0;
      while (t[n] === "`") n++;
      fenceLen = n;
      continue;
    }
    const d = t.replace(/^[#*>\-\s0-9.:：]+/, "");
    if (d.startsWith(findMarker)) marks.push({ kind: "find", line: i });
    else if (d.startsWith(replaceMarker)) marks.push({ kind: "replace", line: i });
  }

  // 取區間內第一個有實質內容的圍欄本文；無圍欄時交由 stripOuterFence 剝除 TypeScript 標籤與下方說明文字
  const takeBody = (from: number, to: number): string => {
    let sawFence = false;
    let k = from;
    while (k < to) {
      const t = lines[k].trim();
      if (!t.startsWith(FENCE)) {
        k++;
        continue;
      }
      sawFence = true;
      let n = 0;
      while (t[n] === "`") n++;
      let e = k + 1;
      while (e < to && !(lines[e].trim().length >= n && lines[e].trim().replace(/`/g, "") === "")) e++;
      const body = lines.slice(k + 1, e).join("\n").replace(/^\n+|\n+$/g, "");
      if (body.trim().length > 0) return body;
      k = e + 1;
    }
    if (sawFence) return "";
    return stripOuterFence(lines.slice(from, to).join("\n"));
  };

  const pairs: PatchPair[] = [];
  let m = 0;
  while (m < marks.length) {
    const rm = marks[m + 1];
    if (marks[m].kind !== "find" || !rm || rm.kind !== "replace") {
      m++;
      continue;
    }
    const nextIdx = marks.findIndex((x, k) => k > m + 1 && x.kind === "find");
    const segEnd = nextIdx >= 0 ? marks[nextIdx].line : lines.length;
    const findBody = takeBody(marks[m].line + 1, rm.line);
    const replaceBody = takeBody(rm.line + 1, segEnd);
    if (findBody.trim().length > 0) {
      pairs.push({ findText: findBody, replaceText: replaceBody });
    }
    m = nextIdx >= 0 ? nextIdx : marks.length;
  }
  return pairs;
}

function findUniqueRange(
  source: string,
  target: string,
): { status: "ok"; start: number; end: number } | { status: "not_found" } | { status: "ambiguous"; count: number } {
  if (!target) return { status: "not_found" };
  // Stage 1: 直接精確比對
  let count = 0;
  let firstIdx = -1;
  let pos = 0;
  while (pos <= source.length) {
    const idx = source.indexOf(target, pos);
    if (idx < 0) break;
    if (count === 0) firstIdx = idx;
    count += 1;
    pos = idx + Math.max(1, target.length);
  }
  if (count === 1) {
    return { status: "ok", start: firstIdx, end: firstIdx + target.length };
  }
  if (count > 1) {
    return { status: "ambiguous", count };
  }

  // Stage 2: 忽略每行行尾多餘空白比對
  const srcLines = source.split("\n");
  const tgtLines = target.split("\n");
  if (tgtLines.length === 0 || tgtLines.length > srcLines.length) {
    return { status: "not_found" };
  }
  const lineOffsets: number[] = [];
  let acc = 0;
  for (let i = 0; i < srcLines.length; i++) {
    lineOffsets.push(acc);
    acc += srcLines[i].length + 1;
  }

  const matchedStarts: { start: number; end: number }[] = [];
  for (let i = 0; i <= srcLines.length - tgtLines.length; i++) {
    let match = true;
    for (let j = 0; j < tgtLines.length; j++) {
      if (srcLines[i + j].trimEnd() !== tgtLines[j].trimEnd()) {
        match = false;
        break;
      }
    }
    if (match) {
      const startOffset = lineOffsets[i];
      const lastLineIdx = i + tgtLines.length - 1;
      const endOffset = lineOffsets[lastLineIdx] + srcLines[lastLineIdx].length;
      matchedStarts.push({ start: startOffset, end: endOffset });
    }
  }

  if (matchedStarts.length === 1) {
    return { status: "ok", start: matchedStarts[0].start, end: matchedStarts[0].end };
  }
  if (matchedStarts.length > 1) {
    return { status: "ambiguous", count: matchedStarts.length };
  }
  return { status: "not_found" };
}

function applyCodePatches(
  originalCode: string,
  pairs: PatchPair[],
): { ok: true; resultCode: string; appliedCount: number } | { ok: false; error: string } {
  if (pairs.length === 0) {
    return { ok: false, error: "請先輸入【定位代碼】或貼上 AI 修改指令" };
  }
  let working = normalizeCodeText(originalCode);
  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const cleanFind = stripOuterFence(p.findText);
    const cleanReplace = stripOuterFence(p.replaceText);
    const tag = pairs.length > 1 ? "第 " + String(i + 1) + " 組修改：" : "";
    if (!cleanFind.trim()) {
      return { ok: false, error: tag + "定位代碼不可為空白" };
    }
    const loc = findUniqueRange(working, cleanFind);
    if (loc.status === "not_found") {
      return {
        ok: false,
        error: tag + "在原版代碼中找不到指定的【定位代碼】（匹配 0 處）。請確認是否選錯代碼塊，或定位代碼是否被截斷。",
      };
    }
    if (loc.status === "ambiguous") {
      return {
        ok: false,
        error:
          tag +
          "【定位代碼】在原版中出現了 " +
          String(loc.count) +
          " 處，無法唯一鎖定。請在定位代碼中多包含前後 1～2 行上下文。",
      };
    }
    working = working.slice(0, loc.start) + cleanReplace + working.slice(loc.end);
  }
  return { ok: true, resultCode: working, appliedCount: pairs.length };
}

function CodeReplaceModal(props: {
  cardBody: string;
  cursorPos: number;
  onClose(): void;
  onApplyPatch(patch: EditPatch): void;
}) {
  const { cardBody, cursorPos, onClose, onApplyPatch } = props;
  const blocks = extractCodeBlocks(cardBody);

  // 預設選中游標所在的代碼塊，否則選第 1 個，若無代碼塊則為 "__new__"
  const initialTarget = () => {
    const hit = blocks.find((b) => cursorPos >= b.contentStart && cursorPos <= b.contentEnd);
    if (hit) return String(hit.index);
    return blocks.length > 0 ? "0" : "__new__";
  };

  const [targetKey, setTargetKey] = useState<string>(initialTarget);
  const [newBlockName, setNewBlockName] = useState("Board.tsx");
  const [manualSource, setManualSource] = useState("");
  const [smartInput, setSmartInput] = useState("");
  const [pairs, setPairs] = useState<PatchPair[]>([{ findText: "", replaceText: "" }]);
  const [activePairIndex, setActivePairIndex] = useState(0);
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; msg: string; details?: string[] } | null>(null);

  const selectedBlock = targetKey === "__new__" ? null : blocks.find((b) => String(b.index) === targetKey) ?? null;
  const activeSourceCode = selectedBlock ? selectedBlock.content : manualSource;

  const currentPair = pairs[activePairIndex] || { findText: "", replaceText: "" };

  const updateCurrentPair = (nextFind: string, nextReplace: string) => {
    setPairs((prev) => {
      const next = [...prev];
      next[activePairIndex] = { findText: nextFind, replaceText: nextReplace };
      return next;
    });
  };

  const handleSmartPasteChange = (val: string) => {
    setSmartInput(val);
    setFeedback(null);
    const parsed = parseAiPatchPairs(val);
    if (parsed.length > 0) {
      setPairs(parsed);
      setActivePairIndex(0);
      setFeedback({
        kind: "ok",
        msg: `✅ 已成功解析 ${parsed.length} 組【尋找／替換】指令並淨化格式！可切換上方組別標籤查看每一組細節。`,
      });
    }
  };

  const handleFindChange = (val: string) => {
    if (val.includes("【尋找這段代碼】") && val.includes("【替換為以下代碼】")) {
      handleSmartPasteChange(val);
      return;
    }
    updateCurrentPair(val, currentPair.replaceText);
    setFeedback(null);
  };

  const handleReplaceChange = (val: string) => {
    updateCurrentPair(currentPair.findText, val);
    setFeedback(null);
  };

  const handleVerifyOnly = () => {
    if (!activeSourceCode.trim()) {
      setFeedback({ kind: "err", msg: "原版代碼全文目前為空，請先選擇代碼塊或貼上原版全文。" });
      return;
    }
    const validPairs = pairs.filter((p) => p.findText.trim().length > 0);
    if (validPairs.length === 0) {
      setFeedback({ kind: "err", msg: "目前無有效的定位代碼，請先輸入【定位代碼】。" });
      return;
    }

    let working = normalizeCodeText(activeSourceCode);
    const details: string[] = [];
    let hasError = false;

    for (let i = 0; i < validPairs.length; i++) {
      const p = validPairs[i];
      const cleanFind = stripOuterFence(p.findText);
      const cleanReplace = stripOuterFence(p.replaceText);
      const loc = findUniqueRange(working, cleanFind);

      if (loc.status === "not_found") {
        details.push(`• 第 ${i + 1} 組：❌ 找不到指定代碼（匹配 0 處）`);
        hasError = true;
      } else if (loc.status === "ambiguous") {
        details.push(`• 第 ${i + 1} 組：⚠️ 出現 ${loc.count} 處重複匹配，無法唯一鎖定`);
        hasError = true;
      } else {
        const lineNum = working.slice(0, loc.start).split("\n").length;
        details.push(`• 第 ${i + 1} 組：✅ 唯一匹配（約第 ${lineNum} 行，長度 ${cleanFind.length} 字元）`);
        working = working.slice(0, loc.start) + cleanReplace + working.slice(loc.end);
      }
    }

    if (hasError) {
      setFeedback({
        kind: "err",
        msg: `定位驗證未全數通過（共 ${validPairs.length} 組）：`,
        details,
      });
    } else {
      setFeedback({
        kind: "ok",
        msg: `✅ 所有組別定位驗證全部通過（共 ${validPairs.length} 組）！可安心執行取代。`,
        details,
      });
    }
  };

  const handleExecute = async () => {
    if (!activeSourceCode.trim()) {
      setFeedback({ kind: "err", msg: "原版代碼全文目前為空，請先選擇代碼塊或貼上原版全文。" });
      return;
    }
    const validPairs = pairs.filter((p) => p.findText.trim().length > 0);
    const res = applyCodePatches(activeSourceCode, validPairs);
    if (!res.ok) {
      setFeedback({ kind: "err", msg: res.error });
      return;
    }

    try {
      await navigator.clipboard.writeText(res.resultCode);
    } catch {
      /* 剪貼簿失敗不阻礙寫回卡片 */
    }

    if (selectedBlock) {
      const from = selectedBlock.contentStart;
      const to = selectedBlock.contentEnd;
      const nextBody = cardBody.slice(0, from) + res.resultCode + cardBody.slice(to);
      const nextCursor = from + res.resultCode.length;
      onApplyPatch({
        text: nextBody,
        selectionStart: nextCursor,
        selectionEnd: nextCursor,
        replaceFrom: from,
        replaceTo: to,
        insertText: res.resultCode,
      });
    } else {
      const cleanName = newBlockName.trim().replace(/\s+/g, "_");
      const extIdx = cleanName.lastIndexOf(".");
      const ext = extIdx >= 0 ? cleanName.slice(extIdx + 1).toLowerCase() : "tsx";
      const header = cleanName ? "```" + (ext || "tsx") + ":" + cleanName : "```tsx";
      const prefix = cardBody.length > 0 && !cardBody.endsWith("\n") ? "\n\n" : cardBody.length > 0 ? "\n" : "";
      const insertBlock = prefix + header + "\n" + res.resultCode + "\n```\n";
      const from = cardBody.length;
      const nextBody = cardBody + insertBlock;
      onApplyPatch({
        text: nextBody,
        selectionStart: nextBody.length,
        selectionEnd: nextBody.length,
        replaceFrom: from,
        replaceTo: from,
        insertText: insertBlock,
      });
      // 新增為卡片代碼塊後，自動切換鎖定至該新區塊，方便後續連續取代
      setTargetKey(String(blocks.length));
      setManualSource("");
    }

    // 取代成功後自動清空智慧貼上區與定位／取代組別，無需手動再按一次清空
    setSmartInput("");
    setPairs([{ findText: "", replaceText: "" }]);
    setActivePairIndex(0);

    setFeedback({
      kind: "ok",
      msg: `🎉 已成功套用 ${res.appliedCount} 處代碼取代並更新至卡片！最新全文已複製至剪貼簿，輸入框已自動清空，可直接貼上下一組代碼。`,
    });
  };

  const handleClearCurrent = () => {
    updateCurrentPair("", "");
    setSmartInput("");
    setFeedback(null);
  };

  return (
    <div className="modal" role="dialog" aria-label="代碼自動定位與取代">
      <div className="modal-card" style={{ minWidth: 680, maxWidth: "92vw", maxHeight: "90vh", overflowY: "auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h4 style={{ margin: 0 }}>⚡ 代碼自動定位與取代</h4>
          <button type="button" onClick={onClose} style={{ padding: "2px 8px" }} title="關閉彈窗">
            ✕ 關閉
          </button>
        </div>

        <div className="field-row" style={{ marginTop: 10 }}>
          <span className="muted">① 選擇目標代碼塊（原版全文來源）：</span>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select
              value={targetKey}
              onChange={(e) => {
                setTargetKey(e.target.value);
                setFeedback(null);
              }}
              aria-label="選擇目標代碼塊"
              style={{ flex: 1, minWidth: 240 }}
            >
              {blocks.map((b) => (
                <option key={b.index} value={String(b.index)}>
                  {"區塊 #" + String(b.index + 1) + "：" + b.label + "（" + String(b.lineCount) + " 行）"}
                </option>
              ))}
              <option value="__new__">➕ 手動貼上外部原版全文（取代後存為卡片新代碼塊）</option>
            </select>
            {targetKey === "__new__" && (
              <input
                value={newBlockName}
                onChange={(e) => setNewBlockName(e.target.value)}
                placeholder="新代碼塊檔名（如 Board.tsx）"
                style={{ width: 200 }}
              />
            )}
          </div>
        </div>

        {targetKey === "__new__" ? (
          <label className="field-row">
            <span className="muted">貼上原版（全文代碼）：</span>
            <textarea
              rows={5}
              value={manualSource}
              onChange={(e) => {
                setManualSource(e.target.value);
                setFeedback(null);
              }}
              placeholder="在此貼上要被修改的完整原始檔案代碼..."
              style={{ fontFamily: "monospace", fontSize: 12 }}
            />
          </label>
        ) : (
          <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
            已鎖定卡片內「{selectedBlock?.label}」（共 {String(selectedBlock?.lineCount ?? 0)} 行）。連續取代時將自動在此最新內容上即時更新。
          </div>
        )}

        <label className="field-row">
          <span className="muted">
            ② 智慧貼上區（直接貼上 AI 回覆，自動拆解並剝除空代碼塊、Markdown 標題與圍欄）：
          </span>
          <textarea
            rows={3}
            value={smartInput}
            onChange={(e) => handleSmartPasteChange(e.target.value)}
            placeholder="貼上 AI 回覆段落（自動解析一組或多組【尋找／替換】區塊）..."
            style={{ fontFamily: "monospace", fontSize: 12 }}
          />
        </label>

        {pairs.length > 1 && (
          <div style={{ display: "flex", gap: 6, alignItems: "center", margin: "8px 0", flexWrap: "wrap" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              組別切換：
            </span>
            {pairs.map((_, idx) => (
              <button
                key={idx}
                type="button"
                className={activePairIndex === idx ? "primary" : ""}
                style={{ fontSize: 11, padding: "2px 8px" }}
                onClick={() => {
                  setActivePairIndex(idx);
                  setFeedback(null);
                }}
              >
                第 {idx + 1} 組
              </button>
            ))}
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <label className="field-row" style={{ margin: 0 }}>
            <span className="muted">
              定位代碼（第 {activePairIndex + 1}/{pairs.length} 組）：
            </span>
            <textarea
              rows={7}
              value={currentPair.findText}
              onChange={(e) => handleFindChange(e.target.value)}
              placeholder="要被取代的舊代碼片段..."
              style={{ fontFamily: "monospace", fontSize: 12 }}
            />
          </label>
          <label className="field-row" style={{ margin: 0 }}>
            <span className="muted">
              取代代碼（第 {activePairIndex + 1}/{pairs.length} 組）：
            </span>
            <textarea
              rows={7}
              value={currentPair.replaceText}
              onChange={(e) => handleReplaceChange(e.target.value)}
              placeholder="要換上的新代碼片段..."
              style={{ fontFamily: "monospace", fontSize: 12 }}
            />
          </label>
        </div>

        {feedback && (
          <div
            className={"banner " + (feedback.kind === "err" ? "danger" : "warn")}
            role="alert"
            style={{ marginTop: 8 }}
          >
            <div>{feedback.msg}</div>
            {feedback.details && feedback.details.length > 0 && (
              <div style={{ marginTop: 4, fontSize: 12, fontFamily: "monospace", lineHeight: 1.5 }}>
                {feedback.details.map((d, i) => (
                  <div key={i}>{d}</div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 12, justifyContent: "space-between" }}>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={handleVerifyOnly}>
              🔍 測試所有組別定位
            </button>
            <button type="button" onClick={handleClearCurrent} title="清空當前組別輸入框以放入下一組">
              清空輸入框
            </button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose}>
              關閉
            </button>
            <button type="button" className="primary" onClick={() => void handleExecute()}>
              ⚡ 套用取代（更新卡片代碼）
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}