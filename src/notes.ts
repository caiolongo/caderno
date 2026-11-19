import { invoke } from "@tauri-apps/api/core";

/** Nota como vem do disco (Documentos\Caderno\<título>.txt). */
export type DiskNote = {
  file: string;
  title: string;
  summary: string;
  body: string;
  updated: number;
};

export const api = {
  folder: () => invoke<string>("notes_folder"),
  list: () => invoke<DiskNote[]>("list_notes"),
  save: (file: string | null, title: string, summary: string, body: string) =>
    invoke<{ file: string; updated: number }>("save_note", { file, title, summary, body }),
  remove: (file: string) => invoke<void>("delete_note", { file }),
  openFolder: () => invoke<void>("open_notes_folder"),
};
