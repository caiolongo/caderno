//! Backend do Caderno: lê e grava as notas como arquivos Markdown (.md)
//! numa pasta própria do app (Documentos\Caderno).
//!
//! Formato do arquivo:
//!   ---
//!   resumo: "Texto do resumo"     (cabeçalho só existe se houver resumo)
//!   ---
//!   # Capítulo 1
//!   texto...

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

const EXT: &str = "md";
const LEGACY_EXT: &str = "txt";
const FOLDER: &str = "Caderno";
const FENCE: &str = "---";
const SUMMARY_KEY: &str = "resumo";
/// Cabeçalho do formato antigo (.txt): "Resumo: ...\n---\n".
const LEGACY_PREFIX: &str = "Resumo: ";

#[derive(Serialize)]
struct Note {
    /// Nome do arquivo (ex.: "Lista de compras.txt"). Serve de identificador.
    file: String,
    title: String,
    summary: String,
    body: String,
    /// Última modificação, em milissegundos desde 1970.
    updated: u64,
}

#[derive(Serialize)]
struct Saved {
    file: String,
    updated: u64,
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

/// Pasta das notas; criada na primeira vez.
fn notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(err)?;
    let dir = base.join(FOLDER);
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir)
}

fn modified_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Garante que `file` é só um nome de arquivo .txt dentro da pasta,
/// sem caminhos tipo "..\algo".
fn resolve(dir: &Path, file: &str) -> Result<PathBuf, String> {
    let p = Path::new(file);
    let ok = p.file_name().map(|n| n == p.as_os_str()).unwrap_or(false)
        && p.extension().map(|e| e.eq_ignore_ascii_case(EXT)).unwrap_or(false);
    if !ok {
        return Err(format!("Nome de arquivo inválido: {file}"));
    }
    Ok(dir.join(p))
}

/// Converte o título num nome de arquivo válido no Windows.
fn safe_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let mut stem: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    stem = stem.trim_matches(|c| c == '.' || c == ' ').chars().take(120).collect();
    const RESERVED: [&str; 22] = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
        "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if stem.is_empty() {
        stem = "Sem título".into();
    } else if RESERVED.contains(&stem.to_uppercase().as_str()) {
        stem.push('_');
    }
    stem
}

/// Primeiro nome livre: "Título.txt", "Título (2).txt", ...
/// `current` é o arquivo da própria nota, que pode ser reaproveitado.
fn unique_name(dir: &Path, stem: &str, current: Option<&str>) -> String {
    let mut n = 1;
    loop {
        let name = if n == 1 {
            format!("{stem}.{EXT}")
        } else {
            format!("{stem} ({n}).{EXT}")
        };
        let same = current.is_some_and(|c| c.eq_ignore_ascii_case(&name));
        if same || !dir.join(&name).exists() {
            return name;
        }
        n += 1;
    }
}

/// Depois de `marker` vem o fim do texto ou uma quebra de linha.
fn after_line<'a>(text: &'a str, marker: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(marker)?;
    if rest.is_empty() { Some("") } else { rest.strip_prefix('\n') }
}

/// Separa o cabeçalho `---` (front matter) do corpo e lê o resumo dele.
fn split_front(text: &str) -> (String, String) {
    let Some(inner) = after_line(text, FENCE) else {
        return (String::new(), text.to_string());
    };
    let mut summary = String::new();
    let mut rest = inner;
    loop {
        if let Some(body) = after_line(rest, FENCE) {
            return (summary, body.to_string());
        }
        let Some((line, next)) = rest.split_once('\n') else { break };
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case(SUMMARY_KEY) {
                summary = unquote(v.trim());
            }
        }
        rest = next;
    }
    // "---" sem fechamento: não é cabeçalho, é texto normal.
    (String::new(), text.to_string())
}

fn unquote(v: &str) -> String {
    if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
        v[1..v.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\")
    } else {
        v.to_string()
    }
}

/// Monta o texto do arquivo; sem resumo, não há cabeçalho.
fn join_front(summary: &str, body: &str) -> String {
    let summary = summary.split_whitespace().collect::<Vec<_>>().join(" ");
    if summary.is_empty() {
        body.to_string()
    } else {
        let q = summary.replace('\\', "\\\\").replace('"', "\\\"");
        format!("{FENCE}\n{SUMMARY_KEY}: \"{q}\"\n{FENCE}\n{body}")
    }
}

/// Lê o cabeçalho do formato antigo (.txt).
fn split_legacy(text: &str) -> (String, String) {
    if let Some(rest) = text.strip_prefix(LEGACY_PREFIX) {
        if let Some((line, after)) = rest.split_once('\n') {
            if let Some(body) = after_line(after, FENCE) {
                return (line.trim().to_string(), body.to_string());
            }
        }
    }
    (String::new(), text.to_string())
}

fn read_text(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(
        String::from_utf8_lossy(&bytes)
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n"),
    )
}

/// Grava num temporário e troca, para não corromper o arquivo se algo falhar.
fn write_atomic(dir: &Path, name: &str, text: &str) -> Result<(), String> {
    let tmp = dir.join(format!(".{name}.tmp"));
    fs::write(&tmp, text.replace('\n', "\r\n")).map_err(err)?;
    fs::rename(&tmp, dir.join(name)).map_err(err)
}

fn has_ext(path: &Path, ext: &str) -> bool {
    path.is_file() && path.extension().map(|e| e.eq_ignore_ascii_case(ext)).unwrap_or(false)
}

/// Converte as notas .txt antigas em .md. O .txt só é apagado depois
/// que o .md foi gravado com sucesso.
fn migrate_txt(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for path in entries.flatten().map(|e| e.path()) {
        if !has_ext(&path, LEGACY_EXT) || path.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.')) {
            continue;
        }
        let Some(text) = read_text(&path) else { continue };
        let (summary, body) = split_legacy(&text);
        let stem = safe_stem(&path.file_stem().unwrap().to_string_lossy());
        let name = unique_name(dir, &stem, None);
        if write_atomic(dir, &name, &join_front(&summary, &body)).is_ok() {
            if let Ok(t) = fs::metadata(&path).and_then(|m| m.modified()) {
                let _ = fs::File::options()
                    .write(true)
                    .open(dir.join(&name))
                    .and_then(|f| f.set_modified(t));
            }
            let _ = fs::remove_file(&path);
        }
    }
}

#[tauri::command]
fn notes_folder(app: AppHandle) -> Result<String, String> {
    Ok(notes_dir(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
fn list_notes(app: AppHandle) -> Result<Vec<Note>, String> {
    let dir = notes_dir(&app)?;
    migrate_txt(&dir);
    let mut notes = Vec::new();
    for entry in fs::read_dir(&dir).map_err(err)? {
        let path = entry.map_err(err)?.path();
        if !has_ext(&path, EXT) {
            continue;
        }
        let Some(text) = read_text(&path) else { continue };
        let (summary, body) = split_front(&text);
        notes.push(Note {
            file: path.file_name().unwrap().to_string_lossy().into_owned(),
            title: path.file_stem().unwrap().to_string_lossy().into_owned(),
            summary,
            body,
            updated: modified_ms(&path),
        });
    }
    Ok(notes)
}

/// Grava a nota. Se o título mudou, renomeia o arquivo.
/// Devolve o nome final do arquivo.
#[tauri::command]
fn save_note(
    app: AppHandle,
    file: Option<String>,
    title: String,
    summary: String,
    body: String,
) -> Result<Saved, String> {
    let dir = notes_dir(&app)?;
    let old = match &file {
        Some(f) => Some(resolve(&dir, f)?),
        None => None,
    };
    let name = unique_name(&dir, &safe_stem(&title), file.as_deref());
    let target = dir.join(&name);

    if let Some(old) = old.filter(|o| o.exists() && *o != target) {
        fs::rename(&old, &target).map_err(err)?;
    }
    write_atomic(&dir, &name, &join_front(&summary, &body))?;

    Ok(Saved { updated: modified_ms(&target), file: name })
}

#[tauri::command]
fn delete_note(app: AppHandle, file: String) -> Result<(), String> {
    let path = resolve(&notes_dir(&app)?, &file)?;
    if path.exists() {
        fs::remove_file(path).map_err(err)?;
    }
    Ok(())
}

#[tauri::command]
fn open_notes_folder(app: AppHandle) -> Result<(), String> {
    let dir = notes_dir(&app)?;
    app.opener()
        .open_path(dir.to_string_lossy(), None::<&str>)
        .map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            notes_folder,
            list_notes,
            save_note,
            delete_note,
            open_notes_folder
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Caderno");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stems() {
        assert_eq!(safe_stem("  Notas: reunião / março?  "), "Notas- reunião - março-");
        assert_eq!(safe_stem(""), "Sem título");
        assert_eq!(safe_stem("..."), "Sem título");
        assert_eq!(safe_stem("con"), "con_");
    }

    #[test]
    fn front_matter_roundtrip() {
        let t = join_front("  Um  \"resumo\" ", "# Cap 1\ncorpo\n---\nmais");
        assert_eq!(t, "---\nresumo: \"Um \\\"resumo\\\"\"\n---\n# Cap 1\ncorpo\n---\nmais");
        assert_eq!(split_front(&t), ("Um \"resumo\"".into(), "# Cap 1\ncorpo\n---\nmais".into()));
        assert_eq!(join_front("", "corpo"), "corpo");
        assert_eq!(split_front("corpo"), ("".into(), "corpo".into()));
        // outras chaves são ignoradas; valor sem aspas também vale
        assert_eq!(split_front("---\ntags: x\nResumo: oi\n---\nb"), ("oi".into(), "b".into()));
        // "---" sem fechamento é texto normal
        assert_eq!(split_front("---\nabc"), ("".into(), "---\nabc".into()));
        assert_eq!(split_front("---\nresumo: x\n---"), ("x".into(), "".into()));
    }

    #[test]
    fn legacy_header() {
        assert_eq!(split_legacy("Resumo: x\n---\ncorpo"), ("x".into(), "corpo".into()));
        assert_eq!(split_legacy("Resumo: x\ny"), ("".into(), "Resumo: x\ny".into()));
    }

    #[test]
    fn rejects_paths() {
        let d = Path::new("C:/x");
        assert!(resolve(d, "a.md").is_ok());
        assert!(resolve(d, "../a.md").is_err());
        assert!(resolve(d, "a.exe").is_err());
        assert!(resolve(d, "sub\\a.md").is_err());
    }
}
