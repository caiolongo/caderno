/** Capítulo = linha que começa com "# " (título de nível 1 do Markdown). */
export type Chapter = {
  title: string;
  from: number; // início da linha "# ..."
  lineEnd: number; // fim da linha do título
  words: number; // palavras do capítulo (sem contar o título)
};

export function countWords(text: string) {
  const t = text.replace(/^#+\s+/gm, "").trim();
  return t ? t.split(/\s+/).length : 0;
}

export function parseChapters(text: string): Chapter[] {
  const heads: { title: string; from: number; lineEnd: number }[] = [];
  const re = /^# +(.*)$/gm;
  for (let m; (m = re.exec(text)); ) {
    heads.push({ title: m[1].trim(), from: m.index, lineEnd: m.index + m[0].length });
  }
  return heads.map((h, i) => ({
    ...h,
    words: countWords(text.slice(h.lineEnd, heads[i + 1]?.from ?? text.length)),
  }));
}

/** Índice do capítulo que contém `pos` (-1 = antes do primeiro). */
export function chapterAt(chapters: Chapter[], pos: number) {
  let idx = -1;
  for (let i = 0; i < chapters.length && chapters[i].from <= pos; i++) idx = i;
  return idx;
}
