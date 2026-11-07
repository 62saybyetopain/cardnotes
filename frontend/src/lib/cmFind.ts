// 全文尋找在單一 CodeMirror 區段內的標示：只加 mark 裝飾，不改文件、不動選取。
// query／current 由 Editor 以 setFind 推進來；current＝這個區段內「目前這一筆」的起點位移（不在這個區段就是 null）
import { StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { findRanges } from "./findInText";

export interface FindState {
  query: string;
  current: number | null;
}

export const setFind = StateEffect.define<FindState | null>();

function build(doc: Text, find: FindState | null): DecorationSet {
  if (!find || !find.query) return Decoration.none;
  const marks = findRanges(doc.toString(), find.query).map((r) =>
    Decoration.mark({
      class: r.from === find.current ? "cm-find-match cm-find-current" : "cm-find-match",
    }).range(r.from, r.to),
  );
  return Decoration.set(marks, true);
}

const field = StateField.define<{ find: FindState | null; deco: DecorationSet }>({
  create: () => ({ find: null, deco: Decoration.none }),
  update(value, tr) {
    let find = value.find;
    let dirty = tr.docChanged;
    for (const e of tr.effects) {
      if (e.is(setFind)) {
        find = e.value;
        dirty = true;
      }
    }
    return dirty ? { find, deco: build(tr.state.doc, find) } : value;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const findExtension = [
  field,
  EditorView.baseTheme({
    ".cm-find-match": { backgroundColor: "rgba(250, 204, 21, 0.35)", borderRadius: "2px" },
    ".cm-find-current": { backgroundColor: "rgba(249, 115, 22, 0.7)", outline: "1px solid rgba(249, 115, 22, 0.9)" },
  }),
];