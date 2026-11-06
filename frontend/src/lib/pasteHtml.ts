// 文獻貼上用：把網頁複製的 HTML 轉成 Markdown，只輸出 Markdown.tsx 讀得懂的語法。
// 回傳 null＝沒有值得轉換的格式，交給瀏覽器原生純文字貼上（文字逐字不變）。
// 刻意不做：表格結構（每列併成一行）、h4 以下層級（併入 ###）、顏色字型、底線刪除線、無 alt 的圖片（視為裝飾）。
import { INDENT_SPACES, MAX_LIST_LEVEL } from "./markdown";

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "dd", "details", "div", "dl", "dt", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre",
  "section", "summary", "table", "tbody", "thead", "tfoot", "tr", "ul",
]);
const SKIP_TAGS = new Set(["script", "style", "head", "meta", "title", "noscript", "template", "svg", "button", "select", "textarea", "input", "iframe"]);
const BLOCK_SELECTOR = Array.from(BLOCK_TAGS).filter((t) => t !== "body").join(",");
const BR = "\u0001"; // 換行佔位：先整理空白，最後才換成 Markdown 硬換行

interface Ctx {
  formatted: boolean; // 只有真的輸出了格式標記才轉換，否則維持原生貼上
}

function escapeText(s: string): string {
  return s.replace(/[\\`*_[\]]/g, (c, i) =>
    c === "_" && /\w/.test(s[i - 1] ?? "") && /\w/.test(s[i + 1] ?? "") ? c : "\\" + c,
  );
}

function escapeLineStart(s: string): string {
  return s
    .replace(/^(#{1,6})(\s)/, "\\$1$2")
    .replace(/^([>+-])(\s)/, "\\$1$2")
    .replace(/^(\d+)([.)])(\s)/, "$1\\$2$3");
}

function clean(s: string): string {
  return s.replace(/ +/g, " ").replace(/ ?\u0001 ?/g, "  \n").replace(/\*{4}/g, "").trim();
}

// 標記必須貼著文字：前後空白移到標記外面；內容是空的就不加標記
function mark(ctx: Ctx, open: string, close: string, s: string): string {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  if (!m || !m[2]) return s;
  ctx.formatted = true;
  return `${m[1]}${open}${m[2]}${close}${m[3]}`;
}

function encodeUrl(u: string): string {
  return u.replace(/[()]/g, (c) => (c === "(" ? "%28" : "%29"));
}

function isBold(el: HTMLElement): boolean {
  const w = el.style.fontWeight;
  if (w) return w === "bold" || w === "bolder" || Number(w) >= 600;
  const t = el.tagName.toLowerCase();
  return t === "strong" || t === "b";
}

function isItalic(el: HTMLElement): boolean {
  const s = el.style.fontStyle;
  if (s) return s === "italic" || s === "oblique";
  const t = el.tagName.toLowerCase();
  return t === "em" || t === "i";
}

function inlineNodes(nodes: Node[], ctx: Ctx, noBold: boolean): string {
  return nodes.map((n) => inlineNode(n, ctx, noBold)).join("");
}

function inlineNode(node: Node, ctx: Ctx, noBold: boolean): string {
  if (node.nodeType === 3) return escapeText((node.textContent ?? "").replace(/[ \t\r\n\f\u00A0]+/g, " "));
  if (node.nodeType !== 1) return "";
  const el = node as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return "";
  if (tag === "br") return BR;
  if (tag === "img") {
    const alt = (el.getAttribute("alt") ?? "").trim();
    const src = (el.getAttribute("src") ?? "").trim();
    if (!alt || !/^https?:\/\/\S+$/i.test(src)) return "";
    ctx.formatted = true;
    return `![${alt.replace(/[[\]\\]/g, "\\$&")}](${encodeUrl(src)})`;
  }
  if (tag === "code") {
    const raw = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!raw) return "";
    ctx.formatted = true;
    const longest = (raw.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0);
    const fence = "`".repeat(longest + 1);
    return longest > 0 ? `${fence} ${raw} ${fence}` : `${fence}${raw}${fence}`;
  }
  let s = inlineNodes(Array.from(el.childNodes), ctx, noBold);
  if (tag === "a") {
    const href = (el.getAttribute("href") ?? "").trim();
    return /^https?:\/\/\S+$/i.test(href) ? mark(ctx, "[", `](${encodeUrl(href)})`, s) : s;
  }
  if (!noBold && isBold(el)) s = mark(ctx, "**", "**", s);
  if (isItalic(el)) s = mark(ctx, "*", "*", s);
  return tag === "td" || tag === "th" || BLOCK_TAGS.has(tag) ? s + " " : s;
}

function listLines(listEl: Element, level: number, ctx: Ctx): string[] {
  const ordered = listEl.tagName.toLowerCase() === "ol";
  const startAttr = Number(listEl.getAttribute("start"));
  let counter = Number.isFinite(startAttr) && startAttr > 0 ? startAttr : 1;
  const indent = " ".repeat(Math.min(MAX_LIST_LEVEL, level) * INDENT_SPACES);
  const out: string[] = [];
  for (const child of Array.from(listEl.children)) {
    const tag = child.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      out.push(...listLines(child, level + 1, ctx));
      continue;
    }
    if (tag !== "li") continue;
    const inlineParts: Node[] = [];
    const subLists: Element[] = [];
    for (const node of Array.from(child.childNodes)) {
      const t = node.nodeType === 1 ? (node as Element).tagName.toLowerCase() : "";
      if (t === "ul" || t === "ol") subLists.push(node as Element);
      else inlineParts.push(node);
    }
    const item = clean(inlineNodes(inlineParts, ctx, false)).replace(/ *\n */g, " ");
    out.push(`${indent}${ordered ? `${counter++}. ` : "- "}${escapeLineStart(item)}`);
    for (const sub of subLists) out.push(...listLines(sub, level + 1, ctx));
  }
  return out;
}

function blocksOf(parent: Node, ctx: Ctx): string[] {
  const blocks: string[] = [];
  let buf = "";
  const flush = () => {
    const t = clean(buf);
    if (t) blocks.push(escapeLineStart(t));
    buf = "";
  };
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType === 1) {
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      if (/^h[1-6]$/.test(tag)) {
        flush();
        const t = clean(inlineNodes(Array.from(el.childNodes), ctx, true)).replace(/ *\n */g, " ");
        if (t) {
          ctx.formatted = true;
          blocks.push(`${"#".repeat(Math.min(3, Number(tag[1])))} ${t}`);
        }
        continue;
      }
      if (tag === "ul" || tag === "ol") {
        flush();
        const lines = listLines(el, 0, ctx);
        if (lines.length > 0) {
          ctx.formatted = true;
          blocks.push(lines.join("\n"));
        }
        continue;
      }
      if (tag === "pre") {
        flush();
        const code = (el.textContent ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
        if (code.trim()) {
          ctx.formatted = true;
          const fence = "`".repeat(Math.max(3, ...(code.match(/`+/g) ?? []).map((r) => r.length + 1)));
          blocks.push(`${fence}\n${code}\n${fence}`);
        }
        continue;
      }
      if (tag === "blockquote") {
        flush();
        const inner = blocksOf(el, ctx).join("\n\n");
        if (inner) {
          ctx.formatted = true;
          blocks.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        }
        continue;
      }
      if (BLOCK_TAGS.has(tag) || el.querySelector(BLOCK_SELECTOR)) {
        flush();
        blocks.push(...blocksOf(el, ctx));
        continue;
      }
    }
    buf += inlineNode(node, ctx, false);
  }
  flush();
  return blocks;
}

export function htmlToMarkdownPaste(_plainText: string, htmlText: string): string | null {
  if (!htmlText || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(htmlText, "text/html");
  // 編輯器／終端機複製的 HTML 是「整段 white-space: pre 的外層容器」，轉換會把每行拆成段落，一律走原生純文字
  const root = doc.body.firstElementChild as HTMLElement | null;
  if (root && doc.body.children.length === 1 && root.tagName !== "PRE" && /^pre/.test(root.style.getPropertyValue("white-space"))) {
    return null;
  }
  const ctx: Ctx = { formatted: false };
  const result = blocksOf(doc.body, ctx).join("\n\n");
  return ctx.formatted && result.trim() ? result : null;
}