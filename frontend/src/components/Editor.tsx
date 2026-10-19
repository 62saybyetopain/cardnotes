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

  const [codePatchOpen, setCodePatchOpen] = useState(false);

  const insertCodeBlock = () => {
    const label = window.prompt("輸入代碼塊名稱或檔名（例如 Board.tsx，可留空）", "");
    if (label === null) return;
    const cleanLabel = label.trim().replace(/\s+/g, "_");
    const extIdx = cleanLabel.lastIndexOf(".");
    const ext = extIdx >= 0 ? cleanLabel.slice(extIdx + 1).toLowerCase() : "tsx";
    const lang = ext || "tsx";
    const header = cleanLabel ? "```" + lang + ":" + cleanLabel : "```" + lang;

    const el = textRef.current;
    const cur = latest.current.body;
    const from = el?.selectionStart ?? cursorPos;
    const to = el?.selectionEnd ?? from;
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

// 唯一的圍欄剝除器：僅當首行為圍欄開頭且末行為純圍欄時才剝除外層，代碼本身出現的反引號字串不受影響
function stripOuterFence(raw: string): string {
  const FENCE = "`".repeat(3);
  const trimBlank = (arr: string[]): string[] => {
    let a = arr;
    while (a.length > 0 && a[0].trim() === "") a = a.slice(1);
    while (a.length > 0 && a[a.length - 1].trim() === "") a = a.slice(0, -1);
    return a;
  };
  let lines = trimBlank(normalizeCodeText(raw).split("\n"));
  if (lines.length >= 2) {
    const first = lines[0].trim();
    const last = lines[lines.length - 1].trim();
    if (first.startsWith(FENCE) && last.length >= 3 && last.replace(/`/g, "") === "") {
      lines = trimBlank(lines.slice(1, -1));
    }
  }
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

  // 取區間內第一個有實質內容的圍欄本文；無圍欄時退回原文並去除首尾的空行與標題／分隔線殘留
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
    let seg = lines.slice(from, to);
    const deco = /^\s*(#{1,6}|[-*]{3,})?\s*$/;
    while (seg.length > 0 && deco.test(seg[0])) seg = seg.slice(1);
    while (seg.length > 0 && deco.test(seg[seg.length - 1])) seg = seg.slice(0, -1);
    return seg.join("\n");
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
    }

    setFeedback({
      kind: "ok",
      msg: `🎉 已成功套用 ${res.appliedCount} 處代碼取代並更新至卡片！最新全文已複製至剪貼簿。彈窗已保留，可繼續貼上下一組代碼進行連續取代，完成後點擊「關閉」。`,
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