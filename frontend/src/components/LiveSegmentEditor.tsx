// @depends-on ../lib/liveMarkdown.ts (liveMarkdown)
// @depends-on ./Markdown.tsx (subscribeCardTitle：卡片引用最新標題的訂閱，注入給 liveMarkdown)
// @depends-on ./Editor.tsx (Editor 以 seg.start 加上本元件回報的區段內位移換算全域位移；onDocChange 的 prevLen 是變動前的區段長度)
import { defaultKeymap, history, historyKeymap, insertNewline } from "@codemirror/commands";
import { Annotation, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import { liveMarkdown } from "../lib/liveMarkdown";
import { subscribeCardTitle } from "./Markdown";

export interface SegmentHandle {
  readonly start: number;
  readonly alive: boolean;
  getSelection(): { from: number; to: number };
  focus(): void;
  setSelection(from: number, to: number): void;
}

interface Props {
  ref?: Ref<SegmentHandle>;
  value: string;
  start: number;
  placeholder?: string;
  ariaLabel: string;
  onFocus(): void;
  onSelectionChange(from: number, to: number): void;
  onDocChange(next: string, prevLen: number, cursor: number): void;
  onKeyDown(e: KeyboardEvent, from: number, to: number): boolean;
  onPaste(e: ClipboardEvent, from: number, to: number): boolean;
  onDropFiles(e: DragEvent, at: number): boolean;
}

// 標記「由父層 value 同步進來的變更」，避免回頭再觸發 onDocChange 造成迴圈或誤標 dirty
const External = Annotation.define<boolean>();

export function LiveSegmentEditor(props: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  useImperativeHandle(
    props.ref,
    (): SegmentHandle => ({
      get start() {
        return propsRef.current.start;
      },
      get alive() {
        return viewRef.current !== null;
      },
      getSelection() {
        const m = viewRef.current?.state.selection.main;
        return m ? { from: m.from, to: m.to } : { from: 0, to: 0 };
      },
      focus() {
        viewRef.current?.focus();
      },
      setSelection(from, to) {
        const v = viewRef.current;
        if (!v) return;
        const len = v.state.doc.length;
        v.dispatch({ selection: { anchor: Math.min(from, len), head: Math.min(to, len) } });
      },
    }),
    [],
  );

  // 建立 view（必須先於下方的同步 effect 宣告，layout effect 依宣告順序執行）
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const p0 = propsRef.current;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: p0.value,
        extensions: [
          history(),
          // 純 Enter 與 textarea 行為一致（不自動縮排）；清單 Enter 由父層 onKeyDown 先攔截
          keymap.of([{ key: "Enter", run: insertNewline }, ...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ "aria-label": p0.ariaLabel }),
          ...(p0.placeholder ? [cmPlaceholder(p0.placeholder)] : []),
          liveMarkdown(subscribeCardTitle),
          Prec.highest(
            EditorView.domEventHandlers({
              keydown: (e, v) => {
                const m = v.state.selection.main;
                if (propsRef.current.onKeyDown(e, m.from, m.to)) {
                  e.preventDefault();
                  return true;
                }
                return false;
              },
              paste: (e, v) => {
                const m = v.state.selection.main;
                if (propsRef.current.onPaste(e, m.from, m.to)) {
                  e.preventDefault();
                  return true;
                }
                return false;
              },
              dragover: (e) => {
                if (e.dataTransfer?.types.includes("Files")) {
                  e.preventDefault();
                  return true;
                }
                return false;
              },
              drop: (e, v) => {
                if (propsRef.current.onDropFiles(e, v.state.selection.main.from)) {
                  e.preventDefault();
                  return true;
                }
                return false;
              },
              focus: () => {
                propsRef.current.onFocus();
                return false;
              },
            }),
          ),
          EditorView.updateListener.of((u) => {
            const p = propsRef.current;
            const external = u.transactions.some((tr) => tr.annotation(External));
            if (u.docChanged && !external) {
              p.onDocChange(u.state.doc.toString(), u.startState.doc.length, u.state.selection.main.head);
            } else if (u.selectionSet) {
              const m = u.state.selection.main;
              p.onSelectionChange(m.from, m.to);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // 父層 value 與 view 內容不同時，只送出「最小差異」，保留游標、捲動位置與 undo 紀錄
  useLayoutEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const cur = view.state.doc.toString();
    const next = props.value;
    if (cur === next) return;
    const max = Math.min(cur.length, next.length);
    let a = 0;
    while (a < max && cur.charCodeAt(a) === next.charCodeAt(a)) a++;
    let b = 0;
    while (b < max - a && cur.charCodeAt(cur.length - 1 - b) === next.charCodeAt(next.length - 1 - b)) b++;
    view.dispatch({
      changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) },
      annotations: External.of(true),
    });
  }, [props.value]);

  return <div ref={hostRef} className="live-segment" />;
}