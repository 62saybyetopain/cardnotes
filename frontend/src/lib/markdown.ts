export type LineType = "p" | "h1" | "h2" | "h3" | "ul" | "ol";

export const INDENT_SPACES = 4;
export const MAX_LIST_LEVEL = 2; // 0, 1, 2 共三層（0, 4, 8 個空白）
export const MAX_INDENT_SPACES = MAX_LIST_LEVEL * INDENT_SPACES;

export interface EditPatch {
  text: string;
  selectionStart: number;
  selectionEnd: number;
  replaceFrom: number;
  replaceTo: number;
  insertText: string;
}

interface ParsedLine {
  type: LineType;
  indent: number; // 0, 4, 8
  orderNum: number | null;
  prefixLen: number;
  content: string;
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const UL_RE = /^([ ]{0,8})[-*+]\s+(.*)$/;
const OL_RE = /^([ ]{0,8})(\d+)\.\s+(.*)$/;
const UNICODE_BULLET_LINE_RE = /^([ \t]*)[•●○◦▪▫▸▹‣⁃・❖➢➤][ \t]+(.*)$/;
const VALID_CARD_ID_RE = /^[0-9a-fA-F-]{36}$/;

export function parseLine(line: string): ParsedLine {
  const h = HEADING_RE.exec(line);
  if (h) {
    const level = h[1].length as 1 | 2 | 3;
    const type: LineType = level === 1 ? "h1" : level === 2 ? "h2" : "h3";
    return {
      type,
      indent: 0,
      orderNum: null,
      prefixLen: line.length - h[2].length,
      content: h[2],
    };
  }
  const ul = UL_RE.exec(line);
  if (ul) {
    const rawSpaces = ul[1].length;
    const indent = Math.min(MAX_INDENT_SPACES, Math.floor(rawSpaces / INDENT_SPACES) * INDENT_SPACES);
    return {
      type: "ul",
      indent,
      orderNum: null,
      prefixLen: line.length - ul[2].length,
      content: ul[2],
    };
  }
  const ol = OL_RE.exec(line);
  if (ol) {
    const rawSpaces = ol[1].length;
    const indent = Math.min(MAX_INDENT_SPACES, Math.floor(rawSpaces / INDENT_SPACES) * INDENT_SPACES);
    return {
      type: "ol",
      indent,
      orderNum: Number(ol[2]),
      prefixLen: line.length - ol[3].length,
      content: ol[3],
    };
  }
  return {
    type: "p",
    indent: 0,
    orderNum: null,
    prefixLen: 0,
    content: line,
  };
}

function getLineBounds(text: string, selStart: number, selEnd: number) {
  const lines = text.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(pos);
    pos += lines[i].length + 1;
  }

  // 若選取結尾剛好落在下一行行首且選取範圍非空，不包含最後那個未選入內容的行
  const effectiveEnd =
    selEnd > selStart && selEnd > 0 && text[selEnd - 1] === "\n" ? selEnd - 1 : selEnd;

  let startLine = 0;
  let endLine = lines.length - 1;
  for (let i = 0; i < lines.length; i++) {
    const lineStart = starts[i];
    const lineEnd = lineStart + lines[i].length;
    if (selStart >= lineStart && selStart <= lineEnd) startLine = i;
    if (effectiveEnd >= lineStart && effectiveEnd <= lineEnd) endLine = i;
  }

  return {
    lines,
    starts,
    startLine,
    endLine,
    blockStart: starts[startLine],
    blockEnd: starts[endLine] + lines[endLine].length,
  };
}

export function detectLineType(text: string, cursor: number): LineType {
  const { lines, startLine } = getLineBounds(text, cursor, cursor);
  return parseLine(lines[startLine] ?? "").type;
}

/**
 * 向上尋找最近一個同縮排層級的編號清單數字（中間若隔著更深層的子清單仍可延續；遇到標題或段落則重置）
 */
function findPrevOrderedNumber(lines: readonly string[], beforeIndex: number, targetIndent: number): number {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const p = parseLine(lines[i]);
    if (p.type === "p" || p.type === "h1" || p.type === "h2" || p.type === "h3") {
      return 0;
    }
    if (p.indent < targetIndent) {
      return 0;
    }
    if (p.indent === targetIndent) {
      return p.type === "ol" && p.orderNum !== null ? p.orderNum : 0;
    }
  }
  return 0;
}

/**
 * 切換游標所在行（或選取的多行）的區塊類型：
 * - 換類型時先去掉舊符號再加新的，不會殘留
 * - 同一類型再按一次回到段落
 * - 編號延續上一行的同層編號，多行時連續遞增
 * - 清單的縮排層級在清單類型之間切換時保留
 */
export function applyLineType(
  text: string,
  selStart: number,
  selEnd: number,
  targetType: LineType,
): EditPatch {
  const { lines, startLine, endLine, blockStart, blockEnd } = getLineBounds(text, selStart, selEnd);
  const parsedRange = lines.slice(startLine, endLine + 1).map(parseLine);

  const allSameType = parsedRange.every((p) => p.type === targetType);
  const effectiveTarget: LineType = allSameType ? "p" : targetType;

  const updatedLines = [...lines];

  for (let i = startLine; i <= endLine; i++) {
    const p = parseLine(updatedLines[i]);
    const isList = p.type === "ul" || p.type === "ol";
    const keepIndent = isList ? p.indent : 0;

    if (effectiveTarget === "p") {
      updatedLines[i] = p.content;
    } else if (effectiveTarget === "h1") {
      updatedLines[i] = `# ${p.content}`;
    } else if (effectiveTarget === "h2") {
      updatedLines[i] = `## ${p.content}`;
    } else if (effectiveTarget === "h3") {
      updatedLines[i] = `### ${p.content}`;
    } else if (effectiveTarget === "ul") {
      updatedLines[i] = `${" ".repeat(keepIndent)}- ${p.content}`;
    } else if (effectiveTarget === "ol") {
      const prevNum = findPrevOrderedNumber(updatedLines, i, keepIndent);
      updatedLines[i] = `${" ".repeat(keepIndent)}${prevNum + 1}. ${p.content}`;
    }
  }

  const replacement = updatedLines.slice(startLine, endLine + 1).join("\n");
  const nextText = updatedLines.join("\n");

  if (startLine === endLine) {
    const oldLineLen = lines[startLine].length;
    const newLineLen = replacement.length;
    const delta = newLineLen - oldLineLen;
    const nextStart = Math.max(blockStart, Math.min(blockStart + newLineLen, selStart + delta));
    const nextEnd = Math.max(nextStart, Math.min(blockStart + newLineLen, selEnd + delta));
    return {
      text: nextText,
      selectionStart: nextStart,
      selectionEnd: nextEnd,
      replaceFrom: blockStart,
      replaceTo: blockEnd,
      insertText: replacement,
    };
  }

  return {
    text: nextText,
    selectionStart: blockStart,
    selectionEnd: blockStart + replacement.length,
    replaceFrom: blockStart,
    replaceTo: blockEnd,
    insertText: replacement,
  };
}

/**
 * 縮排或取消縮排清單行（最多三層：0, 4, 8 個空白；超過不再縮排）。
 * 若選取範圍內完全沒有清單行，回傳 null（讓 Tab 維持原生換焦點）。
 */
export function indentListLines(
  text: string,
  selStart: number,
  selEnd: number,
  direction: 1 | -1,
): EditPatch | null {
  const { lines, startLine, endLine, blockStart, blockEnd } = getLineBounds(text, selStart, selEnd);
  const parsedRange = lines.slice(startLine, endLine + 1).map(parseLine);

  if (!parsedRange.some((p) => p.type === "ul" || p.type === "ol")) {
    return null;
  }

  const updatedLines = [...lines];
  for (let i = startLine; i <= endLine; i++) {
    const p = parseLine(updatedLines[i]);
    if (p.type !== "ul" && p.type !== "ol") continue;

    const nextIndent = Math.max(
      0,
      Math.min(MAX_INDENT_SPACES, p.indent + direction * INDENT_SPACES),
    );
    if (p.type === "ul") {
      updatedLines[i] = `${" ".repeat(nextIndent)}- ${p.content}`;
    } else {
      const prevNum = findPrevOrderedNumber(updatedLines, i, nextIndent);
      updatedLines[i] = `${" ".repeat(nextIndent)}${prevNum + 1}. ${p.content}`;
    }
  }

  // 重新校正緊接在後的同層編號清單
  let modEndLine = endLine;
  for (let i = startLine; i < updatedLines.length; i++) {
    const p = parseLine(updatedLines[i]);
    if (p.type === "ol") {
      const expected = findPrevOrderedNumber(updatedLines, i, p.indent) + 1;
      const rebuilt = `${" ".repeat(p.indent)}${expected}. ${p.content}`;
      if (rebuilt !== updatedLines[i]) {
        updatedLines[i] = rebuilt;
        if (i > modEndLine) modEndLine = i;
      }
    } else if (i > endLine && (p.type === "p" || p.type === "h1" || p.type === "h2" || p.type === "h3")) {
      break;
    }
  }

  const finalBlockEnd =
    modEndLine === endLine
      ? blockEnd
      : lines.slice(0, modEndLine + 1).join("\n").length;
  const replacement = updatedLines.slice(startLine, modEndLine + 1).join("\n");
  const nextText = updatedLines.join("\n");

  if (startLine === endLine) {
    const delta = updatedLines[startLine].length - lines[startLine].length;
    const nextStart = Math.max(blockStart, selStart + delta);
    const nextEnd = Math.max(nextStart, selEnd + delta);
    return {
      text: nextText,
      selectionStart: nextStart,
      selectionEnd: nextEnd,
      replaceFrom: blockStart,
      replaceTo: finalBlockEnd,
      insertText: replacement,
    };
  }

  return {
    text: nextText,
    selectionStart: blockStart,
    selectionEnd: blockStart + updatedLines.slice(startLine, endLine + 1).join("\n").length,
    replaceFrom: blockStart,
    replaceTo: finalBlockEnd,
    insertText: replacement,
  };
}

/**
 * 處理清單行上的 Enter 鍵：
 * - 在清單項目上續一個新項目（編號遞增、保留縮排）
 * - 空項目按 Enter 結束清單（有縮排時先退一層）
 * - 游標在符號前面或不是清單行時，回傳 null（維持一般換行）
 */
export function handleListEnter(
  text: string,
  selStart: number,
  selEnd: number,
): EditPatch | null {
  if (selStart !== selEnd) return null;
  const { lines, starts, startLine, blockStart, blockEnd } = getLineBounds(text, selStart, selEnd);
  const line = lines[startLine] ?? "";
  const p = parseLine(line);

  if (p.type !== "ul" && p.type !== "ol") return null;

  const offsetInLine = selStart - starts[startLine];
  // 游標在清單符號前面時，不攔截，維持一般換行
  if (offsetInLine < p.prefixLen) return null;

  const updatedLines = [...lines];

  // 空項目按 Enter：有縮排時先退一層；在最外層（indent === 0）時結束清單變回一般段落
  if (p.content.trim() === "") {
    if (p.indent >= INDENT_SPACES) {
      const nextIndent = p.indent - INDENT_SPACES;
      let newLine: string;
      if (p.type === "ul") {
        newLine = `${" ".repeat(nextIndent)}- `;
      } else {
        const prevNum = findPrevOrderedNumber(updatedLines, startLine, nextIndent);
        newLine = `${" ".repeat(nextIndent)}${prevNum + 1}. `;
      }
      updatedLines[startLine] = newLine;
      const nextCursor = blockStart + newLine.length;
      return {
        text: updatedLines.join("\n"),
        selectionStart: nextCursor,
        selectionEnd: nextCursor,
        replaceFrom: blockStart,
        replaceTo: blockEnd,
        insertText: newLine,
      };
    } else {
      updatedLines[startLine] = "";
      return {
        text: updatedLines.join("\n"),
        selectionStart: blockStart,
        selectionEnd: blockStart,
        replaceFrom: blockStart,
        replaceTo: blockEnd,
        insertText: "",
      };
    }
  }

  // 非空清單項目：在游標處切開並續一個新項目
  const beforeCursor = line.slice(0, offsetInLine);
  const afterCursor = line.slice(offsetInLine);
  const newPrefix =
    p.type === "ul"
      ? `${" ".repeat(p.indent)}- `
      : `${" ".repeat(p.indent)}${(p.orderNum ?? 1) + 1}. `;

  updatedLines.splice(startLine, 1, beforeCursor, `${newPrefix}${afterCursor}`);

  // 若為編號清單，後續相鄰同層的編號一併順延
  let modEndInOriginal = startLine;
  if (p.type === "ol") {
    for (let i = startLine + 2; i < updatedLines.length; i++) {
      const sub = parseLine(updatedLines[i]);
      if (sub.type === "ol" && sub.indent === p.indent) {
        const expected = findPrevOrderedNumber(updatedLines, i, sub.indent) + 1;
        updatedLines[i] = `${" ".repeat(sub.indent)}${expected}. ${sub.content}`;
        modEndInOriginal = i - 1;
      } else if (sub.indent <= p.indent) {
        break;
      }
    }
  }

  const origReplaceTo =
    modEndInOriginal === startLine
      ? blockEnd
      : starts[modEndInOriginal] + lines[modEndInOriginal].length;
  const replacement = updatedLines.slice(startLine, modEndInOriginal + 2).join("\n");
  const nextCursor = blockStart + beforeCursor.length + 1 + newPrefix.length;

  return {
    text: updatedLines.join("\n"),
    selectionStart: nextCursor,
    selectionEnd: nextCursor,
    replaceFrom: blockStart,
    replaceTo: origReplaceTo,
    insertText: replacement,
  };
}

/**
 * 貼上處理：
 * 1. 從網頁複製的 HTML 若包含 <ul> / <ol>，保留項目符號、編號與縮排層級（最多三層），不同清單之間空行，其餘格式消失。
 * 2. 純文字若含 •、● 等項目符號字元，轉成標準 `- ` 清單。
 * 3. 無上述情況時回傳 null，交給瀏覽器原本的貼上。
 */
export function transformPasteContent(plainText: string, htmlText: string): string | null {
  if (htmlText && /<(ul|ol)\b/i.test(htmlText) && typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(htmlText, "text/html");
    const blocks: string[] = [];

    const serializeList = (listEl: Element, level: number): string[] => {
      const isOl = listEl.tagName.toLowerCase() === "ol";
      const startAttr = Number(listEl.getAttribute("start"));
      let counter = Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1;
      const clampedLevel = Math.min(MAX_LIST_LEVEL, level);
      const indent = " ".repeat(clampedLevel * INDENT_SPACES);
      const out: string[] = [];

      for (const child of Array.from(listEl.children)) {
        const tag = child.tagName.toLowerCase();
        if (tag === "li") {
          const textParts: string[] = [];
          const subLists: Element[] = [];
          for (const node of Array.from(child.childNodes)) {
            if (node.nodeType === 1) {
              const el = node as Element;
              const elTag = el.tagName.toLowerCase();
              if (elTag === "ul" || elTag === "ol") {
                subLists.push(el);
                continue;
              }
            }
            textParts.push(node.textContent ?? "");
          }
          const itemText = textParts.join("").replace(/\s+/g, " ").trim();
          const marker = isOl ? `${counter++}. ` : "- ";
          out.push(`${indent}${marker}${itemText}`);
          for (const sub of subLists) {
            out.push(...serializeList(sub, level + 1));
          }
        } else if (tag === "ul" || tag === "ol") {
          out.push(...serializeList(child, level + 1));
        }
      }
      return out;
    };

    const walkBlocks = (parent: Element) => {
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === 3) {
          const t = (node.textContent ?? "").trim();
          if (t) blocks.push(t);
          continue;
        }
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        const tag = el.tagName.toLowerCase();
        if (tag === "ul" || tag === "ol") {
          const lines = serializeList(el, 0);
          if (lines.length > 0) blocks.push(lines.join("\n"));
        } else if (el.querySelector("ul, ol")) {
          walkBlocks(el);
        } else {
          const t = (el.textContent ?? "").trim();
          if (t) blocks.push(t);
        }
      }
    };

    walkBlocks(doc.body);
    if (blocks.length > 0) {
      return blocks.join("\n\n");
    }
  }

  if (plainText) {
    const rawLines = plainText.replace(/\r\n/g, "\n").split("\n");
    if (rawLines.some((l) => UNICODE_BULLET_LINE_RE.test(l))) {
      const converted = rawLines.map((line) => {
        const m = UNICODE_BULLET_LINE_RE.exec(line);
        if (!m) return line;
        const rawIndent = m[1].replace(/\t/g, "    ").length;
        const level = rawIndent === 0 ? 0 : rawIndent <= 4 ? 1 : 2;
        return `${" ".repeat(level * INDENT_SPACES)}- ${m[2]}`;
      });
      return converted.join("\n");
    }
  }

  return null;
}

/**
 * 將卡片標題與 ID 格式化為 Markdown 連結，並跳脫標題中的方括號確保仍為單一連結（L5）
 */
export function formatCardRef(id: string, title: string): string {
  const safeTitle = (title.trim() || "（無標題）")
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
  return `[${safeTitle}](card:${id})`;
}

/**
 * 從連結 href 解析卡片 ID；不合法格式回傳 null（C5：不合法格式不當成卡片）
 */
export function cardIdFromHref(href: string | undefined): string | null {
  if (typeof href !== "string" || !href.startsWith("card:")) return null;
  const id = href.slice(5);
  return VALID_CARD_ID_RE.test(id) ? id : null;
}

/**
 * 檢查游標前是否處於「行首或空白後輸入 @／＠」的觸發狀態（欄位中間如 a@b 不觸發）
 */
export function detectAtTrigger(
  text: string,
  cursor: number,
): { atIndex: number; query: string } | null {
  if (cursor <= 0 || cursor > text.length) return null;
  const before = text.slice(0, cursor);
  const lastNewline = before.lastIndexOf("\n");
  const lineStart = lastNewline + 1;
  const lineBeforeCursor = before.slice(lineStart);
  const atOffsetInLine = Math.max(
    lineBeforeCursor.lastIndexOf("@"),
    lineBeforeCursor.lastIndexOf("＠"),
  );
  if (atOffsetInLine < 0) return null;

  // @ 必須在行首，或者前一個字元是空白字元
  if (atOffsetInLine > 0) {
    const prevChar = lineBeforeCursor[atOffsetInLine - 1];
    if (prevChar !== " " && prevChar !== "\t") return null;
  }

  const query = lineBeforeCursor.slice(atOffsetInLine + 1);
  // 關鍵字中若已出現空白或方括號，不再視為輸入中的 @ 觸發
  if (/[\s\[\]()]/.test(query)) return null;

  return {
    atIndex: lineStart + atOffsetInLine,
    query,
  };
}