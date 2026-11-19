import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./notes";
import Editor, { type EditorHandle } from "./Editor";
import { chapterAt, countWords, parseChapters } from "./chapters";

type Note = {
  id: string; // id local, estável mesmo quando o arquivo é renomeado
  file: string | null; // null = ainda não existe no disco
  title: string;
  summary: string;
  body: string;
  updated: number;
};

const SUMMARY_MAX = 180; // limita quanto o campo de resumo pode crescer

const SAVE_DELAY = 500;
const OUTLINE_KEY = "caderno.outline"; // painel de capítulos aberto/fechado
const appWindow = getCurrentWindow();
let seq = 0;
const newId = () => `n${Date.now()}-${seq++}`;

function fmt(t: number) {
  const diff = Date.now() - t;
  if (diff < 60_000) return "agora";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h`;
  return new Date(t)
    .toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })
    .replace(".", "");
}

export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [folder, setFolder] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [, tick] = useState(0);
  const [pos, setPos] = useState(0); // cursor / topo visível no editor
  const [outlineOpen, setOutlineOpen] = useState(() => {
    try {
      return localStorage.getItem(OUTLINE_KEY) !== "0";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(OUTLINE_KEY, outlineOpen ? "1" : "0");
    } catch {
      /* sem armazenamento: só não lembra */
    }
  }, [outlineOpen]);

  // notesRef é a fonte da verdade para os salvamentos assíncronos.
  const notesRef = useRef<Note[]>([]);
  const timers = useRef(new Map<string, number>());
  const queues = useRef(new Map<string, Promise<void>>());
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const summaryRef = useRef<HTMLTextAreaElement>(null);
  const bodyRef = useRef<EditorHandle>(null);

  const commit = useCallback((next: Note[]) => {
    notesRef.current = next;
    setNotes(next);
  }, []);

  const fail = useCallback((e: unknown) => {
    setStatus("error");
    setError(String(e));
  }, []);

  // ---------- carregar ----------
  useEffect(() => {
    (async () => {
      try {
        const [list, dir] = await Promise.all([api.list(), api.folder()]);
        const loadedNotes = list.map((n) => ({ ...n, id: newId() }));
        commit(loadedNotes);
        setFolder(dir);
        const first = [...loadedNotes].sort((a, b) => b.updated - a.updated)[0];
        setCurrentId(first?.id ?? null);
      } catch (e) {
        fail(e);
      } finally {
        setLoaded(true);
      }
    })();
    const t = window.setInterval(() => tick((x) => x + 1), 30_000);
    return () => window.clearInterval(t);
  }, [commit, fail]);

  // ---------- salvar ----------
  const saveNow = useCallback(
    (id: string) => {
      timers.current.delete(id);
      const prev = queues.current.get(id) ?? Promise.resolve();
      const job = prev.then(async () => {
        const n = notesRef.current.find((x) => x.id === id);
        if (!n) return;
        if (!n.file && !n.title.trim() && !n.summary.trim() && !n.body.trim()) return; // nota vazia: não cria arquivo
        setStatus("saving");
        try {
          const r = await api.save(n.file, n.title, n.summary, n.body);
          commit(notesRef.current.map((x) => (x.id === id ? { ...x, file: r.file } : x)));
          setStatus("saved");
        } catch (e) {
          fail(e);
        }
      });
      queues.current.set(id, job);
      return job;
    },
    [commit, fail],
  );

  const scheduleSave = useCallback(
    (id: string) => {
      const t = timers.current.get(id);
      if (t) window.clearTimeout(t);
      timers.current.set(id, window.setTimeout(() => saveNow(id), SAVE_DELAY));
    },
    [saveNow],
  );

  const flushAll = useCallback(async () => {
    const pending = [...timers.current.keys()];
    pending.forEach((id) => window.clearTimeout(timers.current.get(id)));
    await Promise.all([...pending.map(saveNow), ...queues.current.values()]);
  }, [saveNow]);

  // Salva o que estiver pendente antes de fechar a janela.
  useEffect(() => {
    const un = getCurrentWindow().onCloseRequested(async () => {
      await flushAll();
    });
    return () => {
      un.then((f) => f());
    };
  }, [flushAll]);

  // ---------- ações ----------
  const update = (patch: Partial<Pick<Note, "title" | "summary" | "body">>) => {
    if (!currentId) return;
    commit(
      notesRef.current.map((n) =>
        n.id === currentId ? { ...n, ...patch, updated: Date.now() } : n,
      ),
    );
    scheduleSave(currentId);
  };

  const newNote = useCallback(() => {
    const n: Note = { id: newId(), file: null, title: "", summary: "", body: "", updated: Date.now() };
    commit([n, ...notesRef.current]);
    setCurrentId(n.id);
    setPos(0);
    setQuery("");
    setConfirmDelete(false);
    requestAnimationFrame(() => titleRef.current?.focus());
  }, [commit]);

  const select = (id: string) => {
    if (id !== currentId) setPos(0);
    setCurrentId(id);
    setConfirmDelete(false);
  };

  const deleteNote = async () => {
    if (!currentId) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    const id = currentId;
    const t = timers.current.get(id);
    if (t) window.clearTimeout(t);
    timers.current.delete(id);
    await queues.current.get(id);
    const n = notesRef.current.find((x) => x.id === id);
    try {
      if (n?.file) await api.remove(n.file);
      const rest = notesRef.current.filter((x) => x.id !== id);
      commit(rest);
      const next = [...rest].sort((a, b) => b.updated - a.updated)[0];
      setCurrentId(next?.id ?? null);
      setConfirmDelete(false);
      setStatus("idle");
    } catch (e) {
      fail(e);
    }
  };

  // Ctrl+N cria nota nova.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newNote();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [newNote]);

  // "Excluir" volta ao normal se não for confirmado em 4s.
  useEffect(() => {
    if (!confirmDelete) return;
    const t = window.setTimeout(() => setConfirmDelete(false), 4000);
    return () => window.clearTimeout(t);
  }, [confirmDelete]);

  // ---------- derivados ----------
  const current = notes.find((n) => n.id === currentId) ?? null;

  // Título e resumo crescem conforme o conteúdo (o resumo tem limite de caracteres).
  useLayoutEffect(() => {
    const fit = () => {
      for (const el of [titleRef.current, summaryRef.current]) {
        if (!el) continue;
        el.style.height = "auto";
        const border = el.offsetHeight - el.clientHeight; // linha tracejada do resumo
        el.style.height = `${el.scrollHeight + border}px`;
      }
    };
    fit();
    // Ao abrir, a medida acontece antes da Literata carregar; mede de novo depois.
    document.fonts.ready.then(fit);
    document.fonts.addEventListener("loadingdone", fit);
    window.addEventListener("resize", fit);
    return () => {
      document.fonts.removeEventListener("loadingdone", fit);
      window.removeEventListener("resize", fit);
    };
  }, [current?.title, current?.summary, currentId]);

  const q = query.trim().toLowerCase();
  const sorted = [...notes].sort((a, b) => b.updated - a.updated);
  const shown = q
    ? sorted.filter((n) => `${n.title} ${n.summary} ${n.body}`.toLowerCase().includes(q))
    : sorted;

  const text = current?.body ?? "";
  const words = countWords(text);
  const readMin = Math.max(1, Math.round(words / 200));
  const chapters = parseChapters(text);
  const chIdx = chapterAt(chapters, pos);

  const statusLabel =
    status === "error"
      ? `Erro ao salvar: ${error}`
      : status === "saving"
        ? "Salvando…"
        : current
          ? `Editado ${fmt(current.updated)} · salvo automaticamente`
          : "";
  const infos = statusLabel ? statusLabel.split(" · ") : [];
  if (chapters.length && status !== "error")
    infos.unshift(chIdx >= 0 ? `Cap. ${chIdx + 1} de ${chapters.length}` : `${chapters.length} capítulos`);

  return (
    <div className="app" data-tauri-drag-region>
      <div className="sheet">
      <aside className="sidebar">
        <header className="sidebar-head" data-tauri-drag-region>
          <h1 className="logo">Caderno</h1>
          <button className="tag tag-btn" onClick={newNote} title="Nova nota (Ctrl+N)">
            + Novo
          </button>
        </header>

        <div className="search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar arquivos"
            aria-label="Buscar arquivos"
          />
        </div>

        <nav className="list">
          {shown.map((n) => {
            const sel = n.id === currentId;
            return (
              <div key={n.id} className={`item-wrap${sel ? " selected" : ""}`}>
                <button className="item" onClick={() => select(n.id)}>
                  <div className="item-top">
                    <span className="item-title">{n.title || "Sem título"}</span>
                    <span className="item-date">{fmt(n.updated)}</span>
                  </div>
                  <span className={`item-snippet${n.summary.trim() ? " has-summary" : ""}`}>
                    {n.summary.trim() ||
                      n.body.replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim() ||
                      "Vazio"}
                  </span>
                </button>

              </div>
            );
          })}
          {loaded && shown.length === 0 && (
            <div className="list-empty">
              {q ? "Nenhum arquivo encontrado." : "Nenhuma nota ainda."}
            </div>
          )}
        </nav>

        <footer className="sidebar-foot">
          <span>{notes.length === 1 ? "1 arquivo" : `${notes.length} arquivos`}</span>
          <button className="link" onClick={() => api.openFolder().catch(fail)} title={folder}>
            Abrir pasta
          </button>
        </footer>
      </aside>

      <main className="editor">
        <div className="editor-bar" data-tauri-drag-region>
          {current && (status === "error" ? (
                <span className="status error">{statusLabel}</span>
              ) : (
                <div className="tags" data-tauri-drag-region>
                  {infos.map((t) => (
                    <span key={t} className="info">{t}</span>
                  ))}
                </div>
              ))}
          <div className="bar-actions">
            {current && (
              <button
                className={`tag tag-btn${outlineOpen ? " on" : ""}`}
                onClick={() => setOutlineOpen((o) => !o)}
                aria-pressed={outlineOpen}
                title="Mostrar ou esconder o gerenciador de capítulos"
              >
                Capítulos
              </button>
            )}
            {current && (
              <button
                className={`tag tag-btn${confirmDelete ? " danger" : ""}`}
                onClick={deleteNote}
              >
                {confirmDelete ? "Confirmar exclusão" : "Excluir"}
              </button>
            )}
            <div className="win-controls">
              <button className="tag tag-btn" onClick={() => appWindow.minimize()} title="Minimizar" aria-label="Minimizar">–</button>
              <button className="tag tag-btn" onClick={() => appWindow.toggleMaximize()} title="Maximizar" aria-label="Maximizar">□</button>
              <button className="tag tag-btn" onClick={() => appWindow.close()} title="Fechar" aria-label="Fechar">×</button>
            </div>
          </div>
        </div>

        {current ? (
          <div className="editor-row">
          <div className="editor-main">
            <div className="editor-body">
              <textarea
                ref={titleRef}
                className="title-input"
                rows={1}
                value={current.title}
                onChange={(e) => update({ title: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    summaryRef.current?.focus();
                  }
                }}
                placeholder="Sem título"
                spellCheck
              />
              <textarea
                ref={summaryRef}
                className="summary-input"
                rows={1}
                maxLength={SUMMARY_MAX}
                value={current.summary}
                onChange={(e) => update({ summary: e.target.value.replace(/\s*\n\s*/g, " ") })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    bodyRef.current?.focus();
                  }
                }}
                placeholder="Resumo"
                aria-label="Resumo"
                spellCheck
              />
              <Editor
                key={current.id}
                ref={bodyRef}
                initial={current.body}
                onChange={(body) => update({ body })}
                onPosition={setPos}
              />
            </div>

            <div className="editor-stats">
              {chIdx >= 0 && <span>{chapters[chIdx].words} palavras no capítulo</span>}
              <span>{words} palavras</span>
              <span>{text.length} caracteres</span>
              <span>{readMin} min de leitura</span>
            </div>
          </div>

          {/* Gerenciador de capítulos */}
          {outlineOpen && (
            <aside className="outline" aria-label="Capítulos">
              <header className="outline-head">
                <span className="info">
                  {chapters.length === 1 ? "1 capítulo" : `${chapters.length} capítulos`}
                </span>
                <button
                  className="tag tag-btn"
                  onClick={() => bodyRef.current?.insertChapter()}
                  title="Adiciona um capítulo no fim do texto"
                >
                  +
                </button>
              </header>
              {chapters.length > 0 ? (
                <ol className="chapters">
                  {chapters.map((c, i) => (
                    <li key={`${i}-${c.from}`}>
                      <button
                        className={`chapter${i === chIdx ? " active" : ""}`}
                        onClick={() => {
                          setPos(c.from);
                          bodyRef.current?.jumpTo(c.from, c.lineEnd);
                        }}
                      >
                        <span className="chapter-num">{String(i + 1).padStart(2, "0")}</span>
                        <span className="chapter-title">{c.title || "Sem título"}</span>
                        <span className="chapter-words">{c.words.toLocaleString("pt-BR")}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="outline-empty">
                  Nenhum capítulo ainda. Escreva <code># Título</code> numa linha ou use +.
                </p>
              )}
            </aside>
          )}
          </div>
        ) : (
          <div className="empty">
            <h2>Nenhum arquivo aberto</h2>
            <p>Selecione um arquivo na lista ou crie um novo.</p>
            <button className="tag tag-btn" onClick={newNote}>
              + Novo arquivo
            </button>
            {status === "error" && <p className="status error">{error}</p>}
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
