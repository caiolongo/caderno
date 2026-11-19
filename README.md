# Caderno

Editor de texto simples (Tauri 2 + React + TypeScript).

As notas ficam em `Documentos\Caderno`, uma por arquivo `.md`. O nome do arquivo é o título da nota.

- O resumo fica no cabeçalho do arquivo (`---` / `resumo: "..."` / `---`).
- Cada linha `# Título` no texto é um capítulo e aparece no gerenciador de capítulos da lista.
- Arquivos `.txt` antigos são convertidos para `.md` ao abrir o app.

## Desenvolvimento

```sh
npm install
npm run tauri dev
```

## Gerar o instalador

```sh
npm run tauri build
```

Sai em `src-tauri/target/release/bundle/nsis/Caderno_<versão>_x64-setup.exe`.

## Estrutura

- `src/App.tsx`: interface (lista, capítulos, salvamento automático)
- `src/Editor.tsx`: editor do texto (CodeMirror com Markdown)
- `src/chapters.ts`: leitura dos capítulos (`# ...`)
- `src/styles.css`: visual (cores e raios em variáveis no `:root`)
- `src/notes.ts`: chamadas ao backend
- `src-tauri/src/lib.rs`: leitura e gravação dos arquivos na pasta
- `app-icon.svg`: ícone de origem (`npx tauri icon app-icon.svg` gera os demais)
