// @depends-on ../lib/markdown.ts (applyLineType, detectAtTrigger, detectLineType, formatCardRef, handleListEnter, indentListLines, transformPasteContent)
// @depends-on ./MentionPopup.tsx (MentionPopup)
// @depends-on ./Markdown.tsx (Markdown)
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../api";
import {
  applyLineType,
  detectAtTrigger,
  detectLineType,
  formatCardRef,
  handleListEnter,
  indentListLines,
  transformPasteContent,
  type EditPatch,
  type LineType,
} from "../lib/markdown";
import { insertAtCursor, isAcceptedMime, mediaRef } from "../lib/media";
import { messageOf } from "../notify";
import type { BoardLink, CardDetail } from "../types";
import { Markdown } from "./Markdown";
import { MentionPopup } from "./MentionPopup";

type Status = "saved" | "dirty" | "saving" | "error" | "conflict";

interface Props {
  card: CardDetail;
  onSaved(card: CardDetail): void;
  onReload(): void;
  onLinkAdded?(sourceId: string, targetId: string, extra?: Partial<BoardLink>): void;
  onOpenCard?(cardId: string): void;
  report(e: unknown, prefix?: string): void;
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
  { type: "ul", label: "項目符號" },
  { type: "ol", label: "編號" },
];

export function Editor({ card, onSaved, onReload, onLinkAdded, onOpenCard, report }: Props) {
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

  const applyEditPatch = useCallback((patch: EditPatch) => {
    const el = textRef.current;
    if (el) {
      el.focus();
      el.setSelectionRange(patch.replaceFrom, patch.replaceTo);
      let execOk = false;
      try {
        if (typeof document.execCommand === "function") {
          execOk = document.execCommand("insertText", false, patch.insertText);
        }
      } catch {
        execOk = false;
      }
      if (!execOk || el.value !== patch.text) {
        onBody(patch.text);
      } else if (latest.current.body !== patch.text) {
        onBody(patch.text);
      }
      el.setSelectionRange(patch.selectionStart, patch.selectionEnd);
      setCursorPos(patch.selectionStart);
      requestAnimationFrame(() => {
        el.setSelectionRange(patch.selectionStart, patch.selectionEnd);
      });
    } else {
      onBody(patch.text);
      setCursorPos(patch.selectionStart);
    }
  }, []);

  const handleToolbarLineType = (targetType: LineType) => {
    const el = textRef.current;
    const selStart = el?.selectionStart ?? cursorPos;
    const selEnd = el?.selectionEnd ?? selStart;
    const patch = applyLineType(latest.current.body, selStart, selEnd, targetType);
    applyEditPatch(patch);
  };

  const handleToolbarIndent = (direction: 1 | -1) => {
    const el = textRef.current;
    const selStart = el?.selectionStart ?? cursorPos;
    const selEnd = el?.selectionEnd ?? selStart;
    const patch = indentListLines(latest.current.body, selStart, selEnd, direction);
    if (patch) applyEditPatch(patch);
  };

  const openMentionFromToolbar = () => {
    const el = textRef.current;
    const start = el?.selectionStart ?? latest.current.body.length;
    const end = el?.selectionEnd ?? start;
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

  const currentLineType = detectLineType(body, cursorPos);
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
            <button type="button" onClick={openMentionFromToolbar}>
              @ 引用
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

      {!previewing ? (
        <textarea
          ref={textRef}
          className="body-input"
          value={body}
          placeholder="內文（Markdown）。可直接貼上或拖入圖片、影片，或輸入 @ 引用其他卡片。"
          aria-label="卡片內文"
          onSelect={(e) => setCursorPos(e.currentTarget.selectionStart ?? 0)}
          onKeyUp={(e) => setCursorPos(e.currentTarget.selectionStart ?? 0)}
          onClick={(e) => setCursorPos(e.currentTarget.selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Tab") {
              const el = e.currentTarget;
              const patch = indentListLines(
                latest.current.body,
                el.selectionStart ?? 0,
                el.selectionEnd ?? 0,
                e.shiftKey ? -1 : 1,
              );
              if (!patch) return;
              e.preventDefault();
              applyEditPatch(patch);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
              const el = e.currentTarget;
              const patch = handleListEnter(
                latest.current.body,
                el.selectionStart ?? 0,
                el.selectionEnd ?? 0,
              );
              if (!patch) return;
              e.preventDefault();
              applyEditPatch(patch);
            }
          }}
          onChange={(e) => {
            const val = e.target.value;
            const pos = e.currentTarget.selectionStart ?? val.length;
            const prevLen = latest.current.body.length;
            onBody(val);
            setCursorPos(pos);
            if (val.length >= prevLen && pos > 0 && val[pos - 1] === "@") {
              const trig = detectAtTrigger(val, pos);
              if (trig && trig.query === "") {
                setMentionState({
                  replaceFrom: trig.atIndex,
                  replaceTo: pos,
                  initialQuery: "",
                });
              }
            }
          }}
          onPaste={(e) => {
            if (e.clipboardData.files.length) {
              e.preventDefault();
              const files = takeFiles(e.clipboardData.files);
              if (files.length) void uploadFiles(files, e.currentTarget.selectionStart ?? latest.current.body.length);
              return;
            }
            const plain = e.clipboardData.getData("text/plain");
            const html = e.clipboardData.getData("text/html");
            const transformed = transformPasteContent(plain, html);
            if (transformed === null) return;
            e.preventDefault();
            const from = e.currentTarget.selectionStart ?? latest.current.body.length;
            const to = e.currentTarget.selectionEnd ?? from;
            const cur = latest.current.body;
            const nextText = cur.slice(0, from) + transformed + cur.slice(to);
            const nextCursor = from + transformed.length;
            applyEditPatch({
              text: nextText,
              selectionStart: nextCursor,
              selectionEnd: nextCursor,
              replaceFrom: from,
              replaceTo: to,
              insertText: transformed,
            });
          }}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes("Files")) e.preventDefault();
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            e.preventDefault();
            const files = takeFiles(e.dataTransfer.files);
            if (files.length) void uploadFiles(files, e.currentTarget.selectionStart ?? latest.current.body.length);
          }}
        />
      ) : (
        <div className="preview" data-testid="editor-preview">
          <Markdown source={body} onOpenCard={onOpenCard} />
        </div>
      )}
    </div>
  );
}