export type LineType = "p" | "h1" | "h2" | "h3" | "ul" | "ol";
export type BulletStyle = "dash" | "circle" | "square" | "arrow" | "check";
export type OrderedStyle = "decimal" | "paren" | "alpha" | "alpha_upper" | "roman";
export type HighlightColor = "amber" | "green" | "blue" | "purple" | "pink";

export const BULLET_STYLE_OPTIONS: readonly { style: BulletStyle; symbol: string; label: string }[] = [
  { style: "dash", symbol: "-", label: "• 實心圓點 (-)" },
  { style: "circle", symbol: "◦", label: "◦ 空心圓點" },
  { style: "square", symbol: "▪", label: "▪ 實心方塊" },
  { style: "arrow", symbol: "▸", label: "▸ 三角箭頭" },
  { style: "check", symbol: "✓", label: "✓ 核取勾選" },
];

export const ORDERED_STYLE_OPTIONS: readonly { style: OrderedStyle; sample: string; label: string }[] = [
  { style: "decimal", sample: "1.", label: "1. 阿拉伯數字" },
  { style: "paren", sample: "(1)", label: "(1) 括號數字" },
  { style: "alpha", sample: "a.", label: "a. 小寫字母" },
  { style: "alpha_upper", sample: "A.", label: "A. 大寫字母" },
  { style: "roman", sample: "i.", label: "i. 羅馬數字" },
];

export const HIGHLIGHT_COLOR_OPTIONS: readonly {
  color: HighlightColor;
  label: string;
  dotColor: string;
  bg: string;
  text: string;
  border: string;
}[] = [
  {
    color: "amber",
    label: "琥珀黃",
    dotColor: "#f59e0b",
    bg: "rgba(245, 158, 11, 0.28)",
    text: "#fde68a",
    border: "rgba(245, 158, 11, 0.65)",
  },
  {
    color: "green",
    label: "翠綠",
    dotColor: "#10b981",
    bg: "rgba(16, 185, 129, 0.26)",
    text: "#a7f3d0",
    border: "rgba(16, 185, 129, 0.65)",
  },
  {
    color: "blue",
    label: "天空藍",
    dotColor: "#3b82f6",
    bg: "rgba(59, 130, 246, 0.28)",
    text: "#bfdbfe",
    border: "rgba(59, 130, 246, 0.65)",
  },
  {
    color: "purple",
    label: "薰衣草紫",
    dotColor: "#8b5cf6",
    bg: "rgba(139, 92, 246, 0.28)",
    text: "#ddd6fe",
    border: "rgba(139, 92, 246, 0.65)",
  },
  {
    color: "pink",
    label: "珊瑚粉",
    dotColor: "#f43f5e",
    bg: "rgba(244, 63, 94, 0.28)",
    text: "#fecdd3",
    border: "rgba(244, 63, 94, 0.65)",
  },
];

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

export interface ParsedLine {
  type: LineType;
  indent: number; // 0, 4, 8
  orderNum: number | null;
  bulletStyle?: BulletStyle;
  orderedStyle?: OrderedStyle;
  markerText?: string;
  rawOrderToken?: string;
  prefixLen: number;
  content: string;
}

const HEADING_RE = /^(#{1,3})\s+(.*)$/;
const UL_RE = /^([ ]{0,8})([-*+]|◦|▪|▸|✓)\s+(.*)$/;
const OL_DECIMAL_RE = /^([ ]{0,8})(\d+)\.\s+(.*)$/;
const OL_PAREN_RE = /^([ ]{0,8})\((\d+)\)\s+(.*)$/;
const OL_ALPHA_ROMAN_RE = /^([ ]{0,8})([a-zA-Z]{1,6})\.\s+(.*)$/;
const UNICODE_BULLET_LINE_RE = /^([ \t]*)[•●○◦▪▫▸▹‣⁃・❖➢➤][ \t]+(.*)$/;
const VALID_CARD_ID_RE = /^[0-9a-fA-F-]{36}$/;

const ROMAN_PAIRS: readonly [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

export function toRoman(num: number): string {
  let n = Math.max(1, Math.min(3999, Math.floor(num)));
  let out = "";
  for (const [val, sym] of ROMAN_PAIRS) {
    while (n >= val) {
      out += sym;
      n -= val;
    }
  }
  return out;
}

export function fromRoman(raw: string): number | null {
  const s = raw.toLowerCase();
  if (!/^[ivxlcdm]+$/.test(s)) return null;
  const map: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const cur = map[s[i]];
    const next = i + 1 < s.length ? map[s[i + 1]] : 0;
    if (cur < next) total -= cur;
    else total += cur;
  }
  if (total <= 0 || total > 3999) return null;
  return toRoman(total) === s ? total : null;
}

export function toAlpha(num: number, upper = false): string {
  let n = Math.max(1, Math.floor(num));
  let out = "";
  while (n > 0) {
    n -= 1;
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return upper ? out.toUpperCase() : out;
}

export function fromAlpha(raw: string): number | null {
  if (!/^[a-zA-Z]+$/.test(raw)) return null;
  const s = raw.toLowerCase();
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    n = n * 26 + (s.charCodeAt(i) - 96);
  }
  return n > 0 ? n : null;
}

export function formatBulletMarker(style: BulletStyle = "dash"): string {
  switch (style) {
    case "circle":
      return "◦";
    case "square":
      return "▪";
    case "arrow":
      return "▸";
    case "check":
      return "✓";
    default:
      return "-";
  }
}

export function formatOrderedMarker(num: number, style: OrderedStyle = "decimal"): string {
  switch (style) {
    case "paren":
      return `(${num})`;
    case "alpha":
      return `${toAlpha(num, false)}.`;
    case "alpha_upper":
      return `${toAlpha(num, true)}.`;
    case "roman":
      return `${toRoman(num)}.`;
    default:
      return `${num}.`;
  }
}

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
    const sym = ul[2];
    const bulletStyle: BulletStyle =
      sym === "◦"
        ? "circle"
        : sym === "▪"
          ? "square"
          : sym === "▸"
            ? "arrow"
            : sym === "✓"
              ? "check"
              : "dash";
    return {
      type: "ul",
      indent,
      orderNum: null,
      bulletStyle,
      markerText: sym === "*" || sym === "+" ? "-" : sym,
      prefixLen: line.length - ul[3].length,
      content: ul[3],
    };
  }
  const olDec = OL_DECIMAL_RE.exec(line);
  if (olDec) {
    const rawSpaces = olDec[1].length;
    const indent = Math.min(MAX_INDENT_SPACES, Math.floor(rawSpaces / INDENT_SPACES) * INDENT_SPACES);
    return {
      type: "ol",
      indent,
      orderNum: Number(olDec[2]),
      orderedStyle: "decimal",
      markerText: `${olDec[2]}.`,
      prefixLen: line.length - olDec[3].length,
      content: olDec[3],
    };
  }
  const olParen = OL_PAREN_RE.exec(line);
  if (olParen) {
    const rawSpaces = olParen[1].length;
    const indent = Math.min(MAX_INDENT_SPACES, Math.floor(rawSpaces / INDENT_SPACES) * INDENT_SPACES);
    return {
      type: "ol",
      indent,
      orderNum: Number(olParen[2]),
      orderedStyle: "paren",
      markerText: `(${olParen[2]})`,
      prefixLen: line.length - olParen[3].length,
      content: olParen[3],
    };
  }
  const olAlphaRoman = OL_ALPHA_ROMAN_RE.exec(line);
  if (olAlphaRoman) {
    const rawSpaces = olAlphaRoman[1].length;
    const indent = Math.min(MAX_INDENT_SPACES, Math.floor(rawSpaces / INDENT_SPACES) * INDENT_SPACES);
    const tok = olAlphaRoman[2];
    if (/^[a-z]+$/.test(tok)) {
      const romanVal = fromRoman(tok);
      if (romanVal !== null && (tok.length >= 2 || tok === "i")) {
        return {
          type: "ol",
          indent,
          orderNum: romanVal,
          orderedStyle: "roman",
          markerText: `${tok}.`,
          rawOrderToken: tok,
          prefixLen: line.length - olAlphaRoman[3].length,
          content: olAlphaRoman[3],
        };
      }
      if (tok.length === 1) {
        return {
          type: "ol",
          indent,
          orderNum: fromAlpha(tok),
          orderedStyle: "alpha",
          markerText: `${tok}.`,
          rawOrderToken: tok,
          prefixLen: line.length - olAlphaRoman[3].length,
          content: olAlphaRoman[3],
        };
      }
    } else if (/^[A-Z]$/.test(tok)) {
      return {
        type: "ol",
        indent,
        orderNum: fromAlpha(tok),
        orderedStyle: "alpha_upper",
        markerText: `${tok}.`,
        rawOrderToken: tok,
        prefixLen: line.length - olAlphaRoman[3].length,
        content: olAlphaRoman[3],
      };
    }
  }
  return {
    type: "p",
    indent: 0,
    orderNum: null,
    prefixLen: 0,
    content: line,
  };
}

/**
 * 結合上下文解析清單行（當字母清單進行到 h. -> i.，或 c. / d. / v. / x. 時，依前一行同層樣式消歧義）
 */
export function resolveLineInContext(lines: readonly string[], index: number): ParsedLine {
  const p = parseLine(lines[index] ?? "");
  if (p.type !== "ol" || !p.rawOrderToken) return p;
  for (let i = index - 1; i >= 0; i--) {
    const prev = parseLine(lines[i] ?? "");
    if (prev.type === "p" || prev.type === "h1" || prev.type === "h2" || prev.type === "h3") break;
    if (prev.indent < p.indent) break;
    if (prev.indent === p.indent) {
      if (prev.type === "ol") {
        const resolvedPrev = resolveLineInContext(lines, i);
        if (resolvedPrev.orderedStyle === "alpha" && p.rawOrderToken.length === 1) {
          const alphaVal = fromAlpha(p.rawOrderToken);
          if (alphaVal !== null) {
            return { ...p, orderedStyle: "alpha", orderNum: alphaVal };
          }
        }
        if (resolvedPrev.orderedStyle === "roman") {
          const romanVal = fromRoman(p.rawOrderToken);
          if (romanVal !== null) {
            return { ...p, orderedStyle: "roman", orderNum: romanVal };
          }
        }
      }
      break;
    }
  }
  return p;
}

function getLineBounds(text: string, selStart: number, selEnd: number) {
  const lines = text.split("\n");
  const starts: number[] = [];
  let pos = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(pos);
    pos += lines[i].length + 1;
  }

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

export function detectListStyleAtCursor(
  text: string,
  cursor: number,
): { bulletStyle?: BulletStyle; orderedStyle?: OrderedStyle } {
  const { lines, startLine } = getLineBounds(text, cursor, cursor);
  const p = resolveLineInContext(lines, startLine);
  return { bulletStyle: p.bulletStyle, orderedStyle: p.orderedStyle };
}

/**
 * 向上尋找最近一個同縮排層級的編號與樣式
 */
function findPrevOrderedInfo(
  lines: readonly string[],
  beforeIndex: number,
  targetIndent: number,
): { num: number; style: OrderedStyle | null } {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const p = resolveLineInContext(lines, i);
    if (p.type === "p" || p.type === "h1" || p.type === "h2" || p.type === "h3") {
      return { num: 0, style: null };
    }
    if (p.indent < targetIndent) {
      return { num: 0, style: null };
    }
    if (p.indent === targetIndent) {
      return p.type === "ol" && p.orderNum !== null
        ? { num: p.orderNum, style: p.orderedStyle ?? "decimal" }
        : { num: 0, style: null };
    }
  }
  return { num: 0, style: null };
}

/**
 * 切換游標所在行（或選取的多行）的區塊類型與清單樣式：
 * - 換類型或換清單樣式時先去掉舊符號再加新的，不會殘留
 * - 同一類型且同一樣式再按一次回到段落
 * - 編號延續上一行的同層編號，多行時連續遞增
 * - 清單的縮排層級在清單類型／樣式之間切換時保留
 */
export function applyLineType(
  text: string,
  selStart: number,
  selEnd: number,
  targetType: LineType,
  styleOpts?: { bulletStyle?: BulletStyle; orderedStyle?: OrderedStyle },
): EditPatch {
  const { lines, startLine, endLine, blockStart, blockEnd } = getLineBounds(text, selStart, selEnd);
  const parsedRange = [];
  for (let i = startLine; i <= endLine; i++) {
    parsedRange.push(resolveLineInContext(lines, i));
  }

  const reqBullet = styleOpts?.bulletStyle;
  const reqOrdered = styleOpts?.orderedStyle;

  const allSameType = parsedRange.every((p) => {
    if (p.type !== targetType) return false;
    if (targetType === "ul" && reqBullet && (p.bulletStyle ?? "dash") !== reqBullet) return false;
    if (targetType === "ol" && reqOrdered && (p.orderedStyle ?? "decimal") !== reqOrdered) return false;
    return true;
  });
  const effectiveTarget: LineType = allSameType ? "p" : targetType;

  const updatedLines = [...lines];

  for (let i = startLine; i <= endLine; i++) {
    const p = resolveLineInContext(updatedLines, i);
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
      const bStyle = reqBullet ?? p.bulletStyle ?? "dash";
      updatedLines[i] = `${" ".repeat(keepIndent)}${formatBulletMarker(bStyle)} ${p.content}`;
    } else if (effectiveTarget === "ol") {
      const prev = findPrevOrderedInfo(updatedLines, i, keepIndent);
      const oStyle = reqOrdered ?? prev.style ?? p.orderedStyle ?? "decimal";
      updatedLines[i] = `${" ".repeat(keepIndent)}${formatOrderedMarker(prev.num + 1, oStyle)} ${p.content}`;
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
    const p = resolveLineInContext(updatedLines, i);
    if (p.type !== "ul" && p.type !== "ol") continue;

    const nextIndent = Math.max(
      0,
      Math.min(MAX_INDENT_SPACES, p.indent + direction * INDENT_SPACES),
    );
    if (p.type === "ul") {
      const bStyle = p.bulletStyle ?? "dash";
      updatedLines[i] = `${" ".repeat(nextIndent)}${formatBulletMarker(bStyle)} ${p.content}`;
    } else {
      const prev = findPrevOrderedInfo(updatedLines, i, nextIndent);
      const oStyle = prev.style ?? p.orderedStyle ?? "decimal";
      updatedLines[i] = `${" ".repeat(nextIndent)}${formatOrderedMarker(prev.num + 1, oStyle)} ${p.content}`;
    }
  }

  // 重新校正緊接在後的同層編號清單
  let modEndLine = endLine;
  for (let i = startLine; i < updatedLines.length; i++) {
    const p = resolveLineInContext(updatedLines, i);
    if (p.type === "ol") {
      const prev = findPrevOrderedInfo(updatedLines, i, p.indent);
      const oStyle = prev.style ?? p.orderedStyle ?? "decimal";
      const rebuilt = `${" ".repeat(p.indent)}${formatOrderedMarker(prev.num + 1, oStyle)} ${p.content}`;
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
 * 處理清單行上的 Enter 鍵（保留目前項目符號樣式與編號樣式，自動遞增編號）
 */
export function handleListEnter(
  text: string,
  selStart: number,
  selEnd: number,
): EditPatch | null {
  if (selStart !== selEnd) return null;
  const { lines, starts, startLine, blockStart, blockEnd } = getLineBounds(text, selStart, selEnd);
  const line = lines[startLine] ?? "";
  const p = resolveLineInContext(lines, startLine);

  if (p.type !== "ul" && p.type !== "ol") return null;

  const offsetInLine = selStart - starts[startLine];
  if (offsetInLine < p.prefixLen) return null;

  const updatedLines = [...lines];

  // 空項目按 Enter：有縮排時先退一層；在最外層（indent === 0）時結束清單變回一般段落
  if (p.content.trim() === "") {
    if (p.indent >= INDENT_SPACES) {
      const nextIndent = p.indent - INDENT_SPACES;
      let newLine: string;
      if (p.type === "ul") {
        newLine = `${" ".repeat(nextIndent)}${formatBulletMarker(p.bulletStyle)} `;
      } else {
        const prev = findPrevOrderedInfo(updatedLines, startLine, nextIndent);
        const oStyle = prev.style ?? p.orderedStyle ?? "decimal";
        newLine = `${" ".repeat(nextIndent)}${formatOrderedMarker(prev.num + 1, oStyle)} `;
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

  // 非空清單項目：在游標處切開並續一個相同樣式的新項目
  const beforeCursor = line.slice(0, offsetInLine);
  const afterCursor = line.slice(offsetInLine);
  const oStyle = p.orderedStyle ?? "decimal";
  const newPrefix =
    p.type === "ul"
      ? `${" ".repeat(p.indent)}${formatBulletMarker(p.bulletStyle)} `
      : `${" ".repeat(p.indent)}${formatOrderedMarker((p.orderNum ?? 1) + 1, oStyle)} `;

  updatedLines.splice(startLine, 1, beforeCursor, `${newPrefix}${afterCursor}`);

  // 若為編號清單，後續相鄰同層的編號一併依該層樣式順延
  let modEndInOriginal = startLine;
  if (p.type === "ol") {
    for (let i = startLine + 2; i < updatedLines.length; i++) {
      const sub = resolveLineInContext(updatedLines, i);
      if (sub.type === "ol" && sub.indent === p.indent) {
        const prev = findPrevOrderedInfo(updatedLines, i, sub.indent);
        const subStyle = prev.style ?? sub.orderedStyle ?? oStyle;
        updatedLines[i] = `${" ".repeat(sub.indent)}${formatOrderedMarker(prev.num + 1, subStyle)} ${sub.content}`;
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

/**
 * 切換行內包裹語法（粗體 `**文字**`、底線 `++文字++`）：
 * - 已包裹時再次點擊會自動解除包裹
 * - 未選取文字時插入預設文字並選取中間內容
 */
export function applyInlineWrap(
  text: string,
  selStart: number,
  selEnd: number,
  marker: "**" | "++",
  placeholder: string,
): EditPatch {
  const mLen = marker.length;
  const selected = text.slice(selStart, selEnd);

  // 1. 檢查選取範圍外側是否緊鄰 marker（例如已包裹後維持內部選取時再按一次）
  if (
    selStart >= mLen &&
    selEnd + mLen <= text.length &&
    text.slice(selStart - mLen, selStart) === marker &&
    text.slice(selEnd, selEnd + mLen) === marker
  ) {
    const replaceFrom = selStart - mLen;
    const replaceTo = selEnd + mLen;
    const nextText = text.slice(0, replaceFrom) + selected + text.slice(replaceTo);
    return {
      text: nextText,
      selectionStart: replaceFrom,
      selectionEnd: replaceFrom + selected.length,
      replaceFrom,
      replaceTo,
      insertText: selected,
    };
  }

  // 2. 檢查選取範圍本身是否以 marker 開頭與結尾
  if (
    selected.length >= mLen * 2 &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(mLen, selected.length - mLen);
    const nextText = text.slice(0, selStart) + inner + text.slice(selEnd);
    return {
      text: nextText,
      selectionStart: selStart,
      selectionEnd: selStart + inner.length,
      replaceFrom: selStart,
      replaceTo: selEnd,
      insertText: inner,
    };
  }

  // 3. 未選取任何文字：插入含佔位字的標記並選取佔位字
  const inner = selected || placeholder;
  const wrapped = `${marker}${inner}${marker}`;
  const nextText = text.slice(0, selStart) + wrapped + text.slice(selEnd);
  return {
    text: nextText,
    selectionStart: selStart + mLen,
    selectionEnd: selStart + mLen + inner.length,
    replaceFrom: selStart,
    replaceTo: selEnd,
    insertText: wrapped,
  };
}

const HL_OPEN_OUTER_RE = /==(?:(amber|yellow|green|blue|purple|pink)[:：])?$/;
const HL_INNER_WHOLE_RE = /^==(?:(amber|yellow|green|blue|purple|pink)[:：])?([\s\S]+)==$/;

/**
 * 套用、換色或移除螢光筆重點（`==color:文字==`）：
 * - 對已上色的文字點選同色或傳入 null：自動移除螢光筆
 * - 對已上色的文字點選不同色：直接替換顏色，不會重複包裹
 */
export function applyHighlight(
  text: string,
  selStart: number,
  selEnd: number,
  color: HighlightColor | null,
): EditPatch | null {
  const selected = text.slice(selStart, selEnd);

  // 1. 檢查選取範圍外側是否已被 `==color:` 與 `==` 包裹
  const beforeSlice = text.slice(Math.max(0, selStart - 12), selStart);
  const outerOpen = HL_OPEN_OUTER_RE.exec(beforeSlice);
  const hasOuterClose = text.slice(selEnd, selEnd + 2) === "==";

  if (outerOpen && hasOuterClose) {
    const existingRaw = outerOpen[1] ?? "amber";
    const existingColor: HighlightColor = existingRaw === "yellow" ? "amber" : (existingRaw as HighlightColor);
    const replaceFrom = selStart - outerOpen[0].length;
    const replaceTo = selEnd + 2;

    if (color === null || existingColor === color) {
      const nextText = text.slice(0, replaceFrom) + selected + text.slice(replaceTo);
      return {
        text: nextText,
        selectionStart: replaceFrom,
        selectionEnd: replaceFrom + selected.length,
        replaceFrom,
        replaceTo,
        insertText: selected,
      };
    }

    const prefix = `==${color}:`;
    const insertText = `${prefix}${selected}==`;
    const nextText = text.slice(0, replaceFrom) + insertText + text.slice(replaceTo);
    return {
      text: nextText,
      selectionStart: replaceFrom + prefix.length,
      selectionEnd: replaceFrom + prefix.length + selected.length,
      replaceFrom,
      replaceTo,
      insertText,
    };
  }

  // 2. 檢查選取範圍本身是否完整包含 `==color:文字==`
  const innerMatch = HL_INNER_WHOLE_RE.exec(selected);
  if (innerMatch) {
    const existingRaw = innerMatch[1] ?? "amber";
    const existingColor: HighlightColor = existingRaw === "yellow" ? "amber" : (existingRaw as HighlightColor);
    const inner = innerMatch[2];

    if (color === null || existingColor === color) {
      const nextText = text.slice(0, selStart) + inner + text.slice(selEnd);
      return {
        text: nextText,
        selectionStart: selStart,
        selectionEnd: selStart + inner.length,
        replaceFrom: selStart,
        replaceTo: selEnd,
        insertText: inner,
      };
    }

    const prefix = `==${color}:`;
    const insertText = `${prefix}${inner}==`;
    const nextText = text.slice(0, selStart) + insertText + text.slice(selEnd);
    return {
      text: nextText,
      selectionStart: selStart + prefix.length,
      selectionEnd: selStart + prefix.length + inner.length,
      replaceFrom: selStart,
      replaceTo: selEnd,
      insertText,
    };
  }

  if (color === null) return null;

  // 未選取任何文字時不執行插入，避免插入佔位文字
  if (!selected) return null;

  // 前方若非空白字元且非行首，自動補上前導空格避免前後語法沾黏
  const needLeadingSpace =
    selStart > 0 &&
    text[selStart - 1] !== " " &&
    text[selStart - 1] !== "\t" &&
    text[selStart - 1] !== "\n";
  const lead = needLeadingSpace ? " " : "";

  const prefix = `${lead}==${color}:`;
  const insertText = `${prefix}${selected}==`;
  const nextText = text.slice(0, selStart) + insertText + text.slice(selEnd);
  return {
    text: nextText,
    selectionStart: selStart + prefix.length,
    selectionEnd: selStart + prefix.length + selected.length,
    replaceFrom: selStart,
    replaceTo: selEnd,
    insertText,
  };
}