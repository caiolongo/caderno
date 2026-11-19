import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  placeholder,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { parseChapters } from "./chapters";

export type EditorHandle = {
  focus(): void;
  /** Rola até `from` e põe o cursor em `cursor`. */
  jumpTo(from: number, cursor: number): void;
  /** Adiciona "# Capítulo N" no fim e seleciona o nome para renomear. */
  insertChapter(): void;
};

type Props = {
  ref?: Ref<EditorHandle>;
  initial: string;
  onChange(text: string): void;
  /** Posição do cursor ou do topo da área visível, para saber o capítulo atual. */
  onPosition(pos: number): void;
};

// Visual do Markdown: capítulos em serifa, itálico/negrito formatados,
// símbolos (#, *, _) apagados.
const highlight = HighlightStyle.define([
  { tag: t.heading1, fontFamily: "var(--serif)", fontSize: "1.55em", fontWeight: "500", color: "var(--ink)" },
  { tag: [t.heading2, t.heading3, t.heading4, t.heading5, t.heading6], fontFamily: "var(--serif)", fontSize: "1.2em", fontWeight: "500", color: "var(--ink)" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "600", color: "var(--ink)" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.processingInstruction, color: "var(--muted)", fontWeight: "400" },
  { tag: t.quote, fontFamily: "var(--serif)", fontStyle: "italic" },
  { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.85em" },
  { tag: [t.link, t.url], color: "var(--ink)", textDecoration: "underline" },
]);

const theme = EditorView.theme({
  "&": { background: "transparent", color: "#55514e", fontSize: "var(--text-size)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--sans)", lineHeight: "1.6", overflow: "visible" },
  ".cm-content": { padding: "0 0 40vh", caretColor: "var(--ink)" },
  ".cm-line": { padding: "0" },
  ".cm-chapter": { paddingTop: "1.1em", paddingBottom: "0.2em" },
  ".cm-chapter:first-child": { paddingTop: "0" },
  ".cm-placeholder": { color: "var(--muted)" },
});

// Classe nas linhas "# ..." para dar respiro antes de cada capítulo.
const chapterLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = this.build(u.view);
    }
    build(view: EditorView) {
      const b = new RangeSetBuilder<Decoration>();
      const deco = Decoration.line({ class: "cm-chapter" });
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = view.state.doc.lineAt(pos);
          if (/^# /.test(line.text)) b.add(line.from, line.from, deco);
          pos = line.to + 1;
        }
      }
      return b.finish();
    }
  },
  { decorations: (v) => v.decorations },
);

export default function Editor({ ref, initial, onChange, onPosition }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onPosition });
  cb.current = { onChange, onPosition };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown(),
          syntaxHighlighting(highlight),
          chapterLines,
          theme,
          EditorView.lineWrapping,
          placeholder("Comece a escrever…"),
          EditorView.contentAttributes.of({ spellcheck: "true", lang: "pt-BR" }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
            if (u.docChanged || u.selectionSet) cb.current.onPosition(u.state.selection.main.head);
          }),
        ],
      }),
    });
    viewRef.current = view;

    // Ao rolar, o capítulo atual é o que está no topo da área visível.
    const scroller = host.current!.closest(".editor-body");
    const onScroll = () => {
      if (!scroller) return;
      const top = scroller.getBoundingClientRect().top + 80 - view.documentTop;
      cb.current.onPosition(view.lineBlockAtHeight(Math.max(0, top)).from);
    };
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      view.destroy();
    };
    // `initial` só vale na montagem; trocar de nota remonta o editor (key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    jumpTo(from, cursor) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({
        selection: { anchor: cursor },
        effects: EditorView.scrollIntoView(from, { y: "start", yMargin: 24 }),
      });
      v.focus();
    },
    insertChapter() {
      const v = viewRef.current;
      if (!v) return;
      const doc = v.state.doc.toString();
      const n = parseChapters(doc).length + 1;
      const sep = !doc ? "" : doc.endsWith("\n\n") ? "" : doc.endsWith("\n") ? "\n" : "\n\n";
      const name = `Capítulo ${n}`;
      const start = doc.length + sep.length + 2; // depois de "# "
      v.dispatch({
        changes: { from: doc.length, insert: `${sep}# ${name}\n` },
        selection: { anchor: start, head: start + name.length },
        effects: EditorView.scrollIntoView(start, { y: "center" }),
      });
      v.focus();
    },
  }));

  return <div ref={host} className="body-editor" />;
}
