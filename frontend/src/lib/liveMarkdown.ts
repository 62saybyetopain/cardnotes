// @depends-on ./markdown.ts (resolveLineInContext：標題／清單判定必須與 components/Markdown.tsx 的 preprocessCustomLists 使用同一個函式；HIGHLIGHT_COLOR_OPTIONS)
// @depends-on ../components/Markdown.tsx (subscribeCardTitle：由 LiveSegmentEditor 注入；CardTitleState 必須與該檔的 CardRefResolution 結構相同)
// @depends-on ../components/Markdown.tsx (++ 底線與 == 螢光筆的開合判定、顏色別名、圍欄判定在此重寫了一份，兩邊規則必須同步修改)
import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { HIGHLIGHT_COLOR_OPTIONS, resolveLineInContext, type HighlightColor } from "./markdown";

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
const HL_TOKEN_RE = /==(?:(amber|yellow|green|blue|purple|pink|黃|綠|藍|紫|粉|紅)[:：])?/gi;
const COLOR_OPEN_RE = /^(amber|yellow|green|blue|purple|pink|黃|綠|藍|紫|粉|紅)[:：]/i;
const ALNUM_RE = /[A-Za-z0-9_+]/;

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-bullet";
    el.textContent = "•";
    return el;
  }
  eq(other: WidgetType): boolean {
    return other instanceof BulletWidget;
  }
}

export type CardTitleState = { status: "ok"; title: string } | { status: "deleted" } | { status: "fallback" };
// 由元件層注入，lib 不直接依賴 React 元件
export type CardTitleSubscribe = (id: string, cb: (s: CardTitleState) => void) => () => void;

const cardRefUnsubscribers = new WeakMap<HTMLElement, () => void>();

class CardRefWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly fallback: string,
    readonly subscribe: CardTitleSubscribe,
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return other instanceof CardRefWidget && other.id === this.id && other.fallback === this.fallback;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "cm-cardref";
    // 先顯示 body 內存的標題；連不上伺服器時（fallback）也維持這個，絕不誤判成已刪除
    el.textContent = this.fallback;
    const off = this.subscribe(this.id, (s) => {
      if (s.status === "deleted") {
        el.className = "cm-cardref deleted";
        el.textContent = "（已刪除的卡片）";
      } else if (s.status === "ok") {
        el.className = "cm-cardref";
        el.textContent = s.title || "（無標題）";
      }
    });
    cardRefUnsubscribers.set(el, off);
    return el;
  }
  destroy(dom: HTMLElement): void {
    cardRefUnsubscribers.get(dom)?.();
    cardRefUnsubscribers.delete(dom);
  }
  // 讓編輯器處理點擊，游標才能進入標籤並顯示原始碼
  ignoreEvent(): boolean {
    return false;
  }
}

const HIDE = Decoration.replace({});
const BULLET = Decoration.replace({ widget: new BulletWidget() });
const SYNTAX = Decoration.mark({ class: "cm-syntax" });
const BOLD = Decoration.mark({ class: "cm-bold" });
const UNDERLINE = Decoration.mark({ class: "cm-u" });
const CARD_REF = Decoration.mark({ class: "cm-cardref" });
const INLINE_CODE = Decoration.mark({ class: "cm-inline-code" });
const LIST_MARKER = Decoration.mark({ class: "cm-list-marker" });
const CODE_LINE = Decoration.line({ class: "cm-codeblock" });
const HEADING_LINE = {
  h1: Decoration.line({ class: "cm-h1" }),
  h2: Decoration.line({ class: "cm-h2" }),
  h3: Decoration.line({ class: "cm-h3" }),
};
const HL_MARKS = new Map<HighlightColor, Decoration>(
  HIGHLIGHT_COLOR_OPTIONS.map(
    (o) =>
      [
        o.color,
        Decoration.mark({
          class: "cm-hl",
          attributes: { style: `background-color:${o.bg};border-bottom:2px solid ${o.border}` },
        }),
      ] as [HighlightColor, Decoration],
  ),
);

type Touch = (from: number, to: number) => boolean;

interface Delim {
  at: number;
  len: number;
  open: boolean;
  close: boolean;
  color?: HighlightColor;
}

// 與 Markdown.tsx tokenizeRichNodes 的 ++ 判定一致
function underlineDelims(s: string): Delim[] {
  const out: Delim[] = [];
  for (const m of s.matchAll(/\+\+/g)) {
    const at = m.index ?? 0;
    const prev = at > 0 ? s[at - 1] : "";
    const next = at + 2 < s.length ? s[at + 2] : "";
    const adj = ALNUM_RE.test(prev) || ALNUM_RE.test(next);
    out.push({
      at,
      len: 2,
      open: !adj && (next === "" || !/\s/.test(next)),
      close: !adj && (prev === "" || !/\s/.test(prev)),
    });
  }
  return out;
}

// 與 Markdown.tsx tokenizeRichNodes 的 == 判定一致（含 ====color: 的連續螢光筆）
function highlightDelims(s: string): Delim[] {
  const out: Delim[] = [];
  for (const m of s.matchAll(HL_TOKEN_RE)) {
    const at = m.index ?? 0;
    const len = m[0].length;
    if (m[1]) {
      out.push({ at, len, open: true, close: false, color: COLOR_ALIAS[m[1].toLowerCase()] ?? "amber" });
      continue;
    }
    const prev = at > 0 ? s[at - 1] : "";
    const next = at + 2 < s.length ? s[at + 2] : "";
    const nextIsColorOpen = COLOR_OPEN_RE.test(s.slice(at + 4));
    const triple = (prev === "=" || next === "=") && !nextIsColorOpen;
    out.push({
      at,
      len,
      open: !triple && (next === "" || !/\s/.test(next)),
      close: !triple && (prev === "" || !/\s/.test(prev)),
    });
  }
  return out;
}

function pairDelims(ds: Delim[]): [Delim, Delim][] {
  const pairs: [Delim, Delim][] = [];
  let i = 0;
  while (i < ds.length) {
    const o = ds[i];
    if (o.open) {
      const j = ds.findIndex((d, k) => k > i && d.close && d.color === undefined);
      if (j > i && ds[j].at > o.at + o.len) {
        pairs.push([o, ds[j]]);
        i = j + 1;
        continue;
      }
    }
    i++;
  }
  return pairs;
}

function decorateInline(
  text: string,
  base: number,
  touch: Touch,
  out: Range<Decoration>[],
  subscribe: CardTitleSubscribe,
): void {
  if (!text) return;
  const hideOrShow = (from: number, to: number, shown: boolean) =>
    out.push((shown ? SYNTAX : HIDE).range(from, to));

  // 行內程式碼：內容遮蔽成佔位字元，避免裡面的符號被當成語法
  let masked = text;
  for (const m of text.matchAll(/`[^`\n]+`/g)) {
    const at = m.index ?? 0;
    out.push(INLINE_CODE.range(base + at, base + at + m[0].length));
    masked = masked.slice(0, at) + "\uFFFC".repeat(m[0].length) + masked.slice(at + m[0].length);
  }

  // 卡片引用 [標題](card:id)：游標沒碰到時換成「最新標題」標籤，碰到時顯示原始碼
  const refRanges: [number, number][] = [];
  for (const m of masked.matchAll(/\[((?:\\.|[^\]\\])*)\]\(card:([0-9a-fA-F-]{36})\)/g)) {
    if (m[1].length === 0) continue;
    const at = m.index ?? 0;
    const s = base + at;
    const e = s + m[0].length;
    refRanges.push([at, m[0].length]);
    if (touch(s, e)) {
      out.push(CARD_REF.range(s + 1, s + 1 + m[1].length));
      out.push(SYNTAX.range(s, s + 1));
      out.push(SYNTAX.range(s + 1 + m[1].length, e));
    } else {
      const fallback = m[1].replace(/\\(.)/g, "$1");
      out.push(Decoration.replace({ widget: new CardRefWidget(m[2], fallback, subscribe) }).range(s, e));
    }
  }
  // 渲染端的引用標題是純文字，所以引用範圍內不再解析粗體／底線／螢光筆（也避免替換範圍互相重疊）
  for (const [at, len] of refRanges) {
    masked = masked.slice(0, at) + "\uFFFC".repeat(len) + masked.slice(at + len);
  }

  // 粗體 **文字**
  for (const m of masked.matchAll(/\*\*(\S(?:.*?\S)?)\*\*/g)) {
    const s = base + (m.index ?? 0);
    const e = s + m[0].length;
    const shown = touch(s, e);
    out.push(BOLD.range(s + 2, e - 2));
    hideOrShow(s, s + 2, shown);
    hideOrShow(e - 2, e, shown);
  }

  // 底線 ++文字++
  for (const [o, c] of pairDelims(underlineDelims(masked))) {
    const s = base + o.at;
    const e = base + c.at + c.len;
    const shown = touch(s, e);
    out.push(UNDERLINE.range(s + o.len, base + c.at));
    hideOrShow(s, s + o.len, shown);
    hideOrShow(base + c.at, e, shown);
  }

  // 螢光筆 ==color:文字== 或 ==文字==（未指定顏色用 amber，與 Markdown.tsx 相同）
  for (const [o, c] of pairDelims(highlightDelims(masked))) {
    const s = base + o.at;
    const e = base + c.at + c.len;
    const shown = touch(s, e);
    const deco = HL_MARKS.get(o.color ?? "amber") ?? HIGHLIGHT_FALLBACK;
    out.push(deco.range(s + o.len, base + c.at));
    hideOrShow(s, s + o.len, shown);
    hideOrShow(base + c.at, e, shown);
  }
}

const HIGHLIGHT_FALLBACK = Array.from(HL_MARKS.values())[0];

function build(view: EditorView, subscribe: CardTitleSubscribe): DecorationSet {
  const { doc, selection } = view.state;
  const touch: Touch = (from, to) => selection.ranges.some((r) => r.from <= to && r.to >= from);
  const lines = doc.toString().split("\n");
  const out: Range<Decoration>[] = [];
  let fenceLen = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineFrom = doc.line(i + 1).from;
    const t = line.trim();

    // 圍欄代碼區塊：整行只上底色，不做任何行內解析（判定與 Markdown.tsx preprocessCustomLists 相同）
    if (fenceLen > 0) {
      out.push(CODE_LINE.range(lineFrom));
      if (t.length >= fenceLen && t.replace(/`/g, "") === "") fenceLen = 0;
      continue;
    }
    if (t.startsWith("```")) {
      let n = 0;
      while (t[n] === "`") n++;
      fenceLen = n;
      out.push(CODE_LINE.range(lineFrom));
      continue;
    }

    const p = resolveLineInContext(lines, i);
    const prefixEnd = lineFrom + p.prefixLen;
    const prefixTouched = touch(lineFrom, prefixEnd);

    if (p.type === "h1" || p.type === "h2" || p.type === "h3") {
      out.push(HEADING_LINE[p.type].range(lineFrom));
      out.push((prefixTouched ? SYNTAX : HIDE).range(lineFrom, prefixEnd));
    } else if (p.type === "ul" || p.type === "ol") {
      const lead = line.length - line.trimStart().length;
      const markerFrom = lineFrom + lead;
      if (p.type === "ul" && p.bulletStyle === "dash") {
        out.push((prefixTouched ? SYNTAX : BULLET).range(markerFrom, markerFrom + 1));
      } else {
        const mLen = p.markerText?.length ?? 0;
        if (mLen > 0) out.push(LIST_MARKER.range(markerFrom, markerFrom + mLen));
      }
    }

    decorateInline(p.content, prefixEnd, touch, out, subscribe);
  }

  return Decoration.set(out, true);
}

export function liveMarkdown(subscribe: CardTitleSubscribe): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      composing = false;
      constructor(view: EditorView) {
        this.decorations = build(view, subscribe);
      }
      update(u: ViewUpdate) {
        const composing = u.view.composing;
        if (composing) {
          // 組字中不重建裝飾（避免打斷輸入法），只讓既有裝飾跟著變動位移
          if (u.docChanged) this.decorations = this.decorations.map(u.changes);
        } else if (u.docChanged || u.selectionSet || this.composing) {
          this.decorations = build(u.view, subscribe);
        }
        this.composing = composing;
      }
    },
    { decorations: (v) => v.decorations },
  );
}