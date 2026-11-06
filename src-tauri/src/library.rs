use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rusqlite::{params, Connection};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

const META_DIR: &str = ".photo-tagger";

pub struct LibraryState {
  inner: Mutex<Option<OpenLibrary>>,
}

struct OpenLibrary {
  root: PathBuf,
  conn: Connection,
}

impl Default for LibraryState {
  fn default() -> Self {
    Self { inner: Mutex::new(None) }
  }
}

impl LibraryState {
  pub fn open(&self, root: &str) -> Result<(), String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
      return Err("Library path is not a folder".into());
    }
    let meta = root.join(META_DIR);
    fs::create_dir_all(meta.join("thumbs")).map_err(e)?;
    fs::create_dir_all(meta.join("views")).map_err(e)?;
    fs::create_dir_all(meta.join("embeddings")).map_err(e)?;
    fs::create_dir_all(meta.join("faces")).map_err(e)?;
    let db_path = meta.join("library.sqlite");
    let conn = Connection::open(&db_path).map_err(e)?;
    conn.execute_batch(
      "CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, json TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);
       CREATE TABLE IF NOT EXISTS faces (id TEXT PRIMARY KEY, photo_id TEXT NOT NULL, json TEXT NOT NULL);
       CREATE INDEX IF NOT EXISTS faces_photo ON faces(photo_id);",
    ).map_err(e)?;
    *self.inner.lock().map_err(|x| x.to_string())? = Some(OpenLibrary { root, conn });
    Ok(())
  }

  fn with<F, T>(&self, f: F) -> Result<T, String>
  where
    F: FnOnce(&OpenLibrary) -> Result<T, String>,
  {
    let g = self.inner.lock().map_err(|x| x.to_string())?;
    let lib = g.as_ref().ok_or_else(|| "No library folder selected".to_string())?;
    f(lib)
  }
}

fn e<E: std::fmt::Display>(err: E) -> String {
  err.to_string()
}

fn persist_path(app: &AppHandle, path: &str) -> Result<(), String> {
  let dir = app.path().app_config_dir().map_err(e)?;
  fs::create_dir_all(&dir).map_err(e)?;
  fs::write(dir.join("library-path.txt"), path).map_err(e)
}

fn clear_persisted(app: &AppHandle) -> Result<(), String> {
  let dir = app.path().app_config_dir().map_err(e)?;
  let marker = dir.join("library-path.txt");
  if marker.exists() {
    fs::remove_file(marker).map_err(e)?;
  }
  Ok(())
}

fn safe_name(name: &str) -> String {
  let n = name.replace(['/', '\\', '?', '%', '*', ':', '|', '"', '<', '>'], "_");
  let n = n.trim_start_matches('.').to_string();
  if n.is_empty() { "photo.jpg".into() } else { n }
}

fn unique_in(dir: &Path, name: &str) -> PathBuf {
  let safe = safe_name(name);
  let mut candidate = dir.join(&safe);
  if !candidate.exists() {
    return candidate;
  }
  let (base, ext) = match safe.rfind('.') {
    Some(i) => (&safe[..i], &safe[i..]),
    None => (safe.as_str(), ""),
  };
  for k in 2..10_000 {
    candidate = dir.join(format!("{base}-{k}{ext}"));
    if !candidate.exists() {
      return candidate;
    }
  }
  dir.join(format!("{base}-{}.bin", uuid::Uuid::new_v4()))
}

#[tauri::command]
pub fn library_get_path(state: State<'_, LibraryState>) -> Result<Option<String>, String> {
  let g = state.inner.lock().map_err(|x| x.to_string())?;
  Ok(g.as_ref().map(|l| l.root.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn library_pick(app: AppHandle, state: State<'_, LibraryState>) -> Result<String, String> {
  let picked = app
    .dialog()
    .file()
    .set_title("Choose a Photo Tagger library folder")
    .blocking_pick_folder()
    .ok_or_else(|| "No folder selected".to_string())?;
  let path = picked.into_path().map_err(|e| e.to_string())?.to_string_lossy().into_owned();
  state.open(&path)?;
  persist_path(&app, &path)?;
  Ok(path)
}

#[tauri::command]
pub fn library_clear(app: AppHandle, state: State<'_, LibraryState>) -> Result<(), String> {
  *state.inner.lock().map_err(|x| x.to_string())? = None;
  clear_persisted(&app)
}

#[tauri::command]
pub fn library_list_photos(state: State<'_, LibraryState>) -> Result<Vec<Value>, String> {
  state.with(|lib| {
    let mut stmt = lib.conn.prepare("SELECT json FROM photos").map_err(e)?;
    let rows = stmt
      .query_map([], |r| {
        let s: String = r.get(0)?;
        Ok(s)
      })
      .map_err(e)?;
    let mut out = Vec::new();
    for row in rows {
      let s = row.map_err(e)?;
      out.push(serde_json::from_str(&s).map_err(e)?);
    }
    Ok(out)
  })
}

#[tauri::command]
pub fn library_put_photo(state: State<'_, LibraryState>, photo: Value) -> Result<(), String> {
  state.with(|lib| {
    let id = photo
      .get("id")
      .and_then(|v| v.as_str())
      .ok_or_else(|| "photo.id required".to_string())?;
    let json = serde_json::to_string(&photo).map_err(e)?;
    lib.conn
      .execute(
        "INSERT INTO photos(id, json) VALUES(?1, ?2)
         ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![id, json],
      )
      .map_err(e)?;
    Ok(())
  })
}

#[tauri::command]
pub fn library_save_blobs(
  state: State<'_, LibraryState>,
  photo: Value,
  thumb_b64: String,
  view_b64: String,
  original_b64: Option<String>,
  original_name: Option<String>,
) -> Result<Value, String> {
  state.with(|lib| {
    let id = photo
      .get("id")
      .and_then(|v| v.as_str())
      .ok_or_else(|| "photo.id required".to_string())?
      .to_string();
    let meta = lib.root.join(META_DIR);
    let thumb = B64.decode(thumb_b64.as_bytes()).map_err(e)?;
    let view = B64.decode(view_b64.as_bytes()).map_err(e)?;
    fs::write(meta.join("thumbs").join(format!("{id}.jpg")), thumb).map_err(e)?;
    fs::write(meta.join("views").join(format!("{id}.jpg")), view).map_err(e)?;

    let mut photo = photo;
    let obj = photo
      .as_object_mut()
      .ok_or_else(|| "photo must be an object".to_string())?;

    // Always keep the original on disk in desktop mode
    if let Some(ob) = original_b64 {
      let bytes = B64.decode(ob.as_bytes()).map_err(e)?;
      let name = original_name.unwrap_or_else(|| format!("{id}.jpg"));
      let dest = unique_in(&lib.root, &name);
      fs::write(&dest, bytes).map_err(e)?;
      let rel = dest
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
      obj.insert("relPath".into(), Value::String(rel));
      obj.insert("hasOriginal".into(), Value::Bool(true));
    } else if obj.get("relPath").and_then(|v| v.as_str()).is_none() {
      // If no original bytes and no path yet, materialize view as the on-disk file
      let name = original_name.unwrap_or_else(|| format!("{id}.jpg"));
      let dest = unique_in(&lib.root, &name);
      let view_path = meta.join("views").join(format!("{id}.jpg"));
      fs::copy(&view_path, &dest).map_err(e)?;
      let rel = dest.file_name().unwrap().to_string_lossy().into_owned();
      obj.insert("relPath".into(), Value::String(rel));
      obj.insert("hasOriginal".into(), Value::Bool(true));
    }

    let json = serde_json::to_string(&photo).map_err(e)?;
    lib.conn
      .execute(
        "INSERT INTO photos(id, json) VALUES(?1, ?2)
         ON CONFLICT(id) DO UPDATE SET json=excluded.json",
        params![id, json],
      )
      .map_err(e)?;
    Ok(photo)
  })
}

#[tauri::command]
pub fn library_get_blob(
  state: State<'_, LibraryState>,
  store: String,
  id: String,
) -> Result<Option<String>, String> {
  state.with(|lib| {
    let meta = lib.root.join(META_DIR);
    let path = match store.as_str() {
      "thumbs" => meta.join("thumbs").join(format!("{id}.jpg")),
      "views" => meta.join("views").join(format!("{id}.jpg")),
      "originals" => {
        // Look up relPath from photo record
        let json: String = lib
          .conn
          .query_row("SELECT json FROM photos WHERE id=?1", params![id], |r| r.get(0))
          .map_err(|_| "photo not found".to_string())?;
        let v: Value = serde_json::from_str(&json).map_err(e)?;
        let rel = v
          .get("relPath")
          .and_then(|x| x.as_str())
          .ok_or_else(|| "no original path".to_string())?;
        lib.root.join(rel)
      }
      _ => return Err(format!("unknown store {store}")),
    };
    if !path.exists() {
      return Ok(None);
    }
    let bytes = fs::read(path).map_err(e)?;
    Ok(Some(B64.encode(bytes)))
  })
}

#[tauri::command]
pub fn library_put_embedding(
  state: State<'_, LibraryState>,
  id: String,
  values: Vec<f32>,
) -> Result<(), String> {
  state.with(|lib| {
    let path = lib.root.join(META_DIR).join("embeddings").join(format!("{id}.bin"));
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for v in values {
      bytes.extend_from_slice(&v.to_le_bytes());
    }
    fs::write(path, bytes).map_err(e)
  })
}

#[tauri::command]
pub fn library_all_embeddings(
  state: State<'_, LibraryState>,
) -> Result<std::collections::HashMap<String, Vec<f32>>, String> {
  state.with(|lib| {
    let dir = lib.root.join(META_DIR).join("embeddings");
    let mut map = std::collections::HashMap::new();
    if !dir.exists() {
      return Ok(map);
    }
    for entry in fs::read_dir(dir).map_err(e)? {
      let entry = entry.map_err(e)?;
      let path = entry.path();
      if path.extension().and_then(|x| x.to_str()) != Some("bin") {
        continue;
      }
      let id = path
        .file_stem()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_string();
      let bytes = fs::read(&path).map_err(e)?;
      if bytes.len() % 4 != 0 {
        continue;
      }
      let mut vals = Vec::with_capacity(bytes.len() / 4);
      for chunk in bytes.chunks_exact(4) {
        vals.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
      }
      map.insert(id, vals);
    }
    Ok(map)
  })
}

#[tauri::command]
pub fn library_delete_photos(state: State<'_, LibraryState>, ids: Vec<String>) -> Result<(), String> {
  state.with(|lib| {
    let meta = lib.root.join(META_DIR);
    for id in &ids {
      let json: Result<String, _> =
        lib.conn
          .query_row("SELECT json FROM photos WHERE id=?1", params![id], |r| r.get(0));
      if let Ok(s) = json {
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
          if let Some(rel) = v.get("relPath").and_then(|x| x.as_str()) {
            let p = lib.root.join(rel);
            let _ = fs::remove_file(p);
          }
        }
      }
      let _ = lib.conn.execute("DELETE FROM photos WHERE id=?1", params![id]);
      let _ = lib.conn.execute("DELETE FROM faces WHERE photo_id=?1", params![id]);
      let _ = fs::remove_file(meta.join("thumbs").join(format!("{id}.jpg")));
      let _ = fs::remove_file(meta.join("views").join(format!("{id}.jpg")));
      let _ = fs::remove_file(meta.join("embeddings").join(format!("{id}.bin")));
    }
    Ok(())
  })
}

#[tauri::command]
pub fn library_clear_all(state: State<'_, LibraryState>) -> Result<(), String> {
  state.with(|lib| {
    // Remove photo files referenced in DB, then wipe meta contents (keep folder)
    let ids: Vec<String> = {
      let mut stmt = lib.conn.prepare("SELECT id FROM photos").map_err(e)?;
      let rows = stmt.query_map([], |r| r.get(0)).map_err(e)?;
      rows.filter_map(|r| r.ok()).collect()
    };
    drop(ids);
    // delete originals via existing helper path
    let photos: Vec<Value> = {
      let mut stmt = lib.conn.prepare("SELECT json FROM photos").map_err(e)?;
      let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(e)?;
      rows
        .filter_map(|r| r.ok())
        .filter_map(|s| serde_json::from_str(&s).ok())
        .collect()
    };
    for v in photos {
      if let Some(rel) = v.get("relPath").and_then(|x| x.as_str()) {
        let _ = fs::remove_file(lib.root.join(rel));
      }
    }
    lib.conn.execute_batch("DELETE FROM photos; DELETE FROM faces; DELETE FROM kv;").map_err(e)?;
    for sub in ["thumbs", "views", "embeddings", "faces"] {
      let dir = lib.root.join(META_DIR).join(sub);
      if dir.exists() {
        for entry in fs::read_dir(&dir).map_err(e)? {
          let entry = entry.map_err(e)?;
          let _ = fs::remove_file(entry.path());
        }
      }
    }
    Ok(())
  })
}

#[tauri::command]
pub fn library_kv_get(state: State<'_, LibraryState>, key: String) -> Result<Option<Value>, String> {
  state.with(|lib| {
    let res = lib
      .conn
      .query_row("SELECT json FROM kv WHERE key=?1", params![key], |r| {
        r.get::<_, String>(0)
      });
    match res {
      Ok(s) => Ok(Some(serde_json::from_str(&s).map_err(e)?)),
      Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
      Err(err) => Err(err.to_string()),
    }
  })
}

#[tauri::command]
pub fn library_kv_set(state: State<'_, LibraryState>, key: String, value: Value) -> Result<(), String> {
  state.with(|lib| {
    let json = serde_json::to_string(&value).map_err(e)?;
    lib.conn
      .execute(
        "INSERT INTO kv(key, json) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET json=excluded.json",
        params![key, json],
      )
      .map_err(e)?;
    Ok(())
  })
}

#[tauri::command]
pub fn library_all_faces(state: State<'_, LibraryState>) -> Result<Vec<Value>, String> {
  state.with(|lib| {
    let mut stmt = lib.conn.prepare("SELECT id, json FROM faces").map_err(e)?;
    let rows = stmt
      .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
      .map_err(e)?;
    let mut out = Vec::new();
    for row in rows {
      let (id, json) = row.map_err(e)?;
      let mut v: Value = serde_json::from_str(&json).map_err(e)?;
      // Attach face thumb as data URL base64 field `thumbB64` for the frontend to rebuild Blob
      let thumb_path = lib.root.join(META_DIR).join("faces").join(format!("{id}.jpg"));
      if thumb_path.exists() {
        if let Ok(bytes) = fs::read(thumb_path) {
          if let Some(obj) = v.as_object_mut() {
            obj.insert("thumbB64".into(), Value::String(B64.encode(bytes)));
          }
        }
      }
      out.push(v);
    }
    Ok(out)
  })
}

#[tauri::command]
pub fn library_put_faces(state: State<'_, LibraryState>, faces: Vec<Value>) -> Result<(), String> {
  state.with(|lib| {
    for mut face in faces {
      let id = face
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "face.id required".to_string())?
        .to_string();
      let photo_id = face
        .get("photoId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "face.photoId required".to_string())?
        .to_string();
      if let Some(b64) = face.get("thumbB64").and_then(|v| v.as_str()) {
        let bytes = B64.decode(b64.as_bytes()).map_err(e)?;
        fs::write(
          lib.root.join(META_DIR).join("faces").join(format!("{id}.jpg")),
          bytes,
        )
        .map_err(e)?;
      }
      if let Some(obj) = face.as_object_mut() {
        obj.remove("thumbB64");
        obj.remove("thumb"); // never persist browser Blob
      }
      let json = serde_json::to_string(&face).map_err(e)?;
      lib.conn
        .execute(
          "INSERT INTO faces(id, photo_id, json) VALUES(?1, ?2, ?3)
           ON CONFLICT(id) DO UPDATE SET photo_id=excluded.photo_id, json=excluded.json",
          params![id, photo_id, json],
        )
        .map_err(e)?;
    }
    Ok(())
  })
}

#[tauri::command]
pub fn library_clear_faces(state: State<'_, LibraryState>) -> Result<(), String> {
  state.with(|lib| {
    lib.conn.execute_batch("DELETE FROM faces;").map_err(e)?;
    let dir = lib.root.join(META_DIR).join("faces");
    if dir.exists() {
      for entry in fs::read_dir(dir).map_err(e)? {
        let entry = entry.map_err(e)?;
        let _ = fs::remove_file(entry.path());
      }
    }
    Ok(())
  })
}

/// Write raw image bytes into the library folder (Dropbox / file import). Returns relative path + absolute path.
#[tauri::command]
pub fn library_import_bytes(
  state: State<'_, LibraryState>,
  name: String,
  data_b64: String,
) -> Result<serde_json::Value, String> {
  state.with(|lib| {
    let bytes = B64.decode(data_b64.as_bytes()).map_err(e)?;
    let dest = unique_in(&lib.root, &name);
    fs::write(&dest, &bytes).map_err(e)?;
    let rel = dest.file_name().unwrap().to_string_lossy().into_owned();
    Ok(serde_json::json!({
      "relPath": rel,
      "absPath": dest.to_string_lossy(),
      "size": bytes.len(),
    }))
  })
}

#[tauri::command]
pub fn library_read_file(state: State<'_, LibraryState>, rel_path: String) -> Result<String, String> {
  state.with(|lib| {
    // Prevent path escape
    let name = Path::new(&rel_path)
      .file_name()
      .ok_or_else(|| "invalid path".to_string())?;
    let path = lib.root.join(name);
    if !path.exists() {
      return Err("file not found".into());
    }
    let bytes = fs::read(path).map_err(e)?;
    Ok(B64.encode(bytes))
  })
}

#[tauri::command]
pub fn library_delete_face_ids(state: State<'_, LibraryState>, ids: Vec<String>) -> Result<(), String> {
  state.with(|lib| {
    for id in &ids {
      let _ = lib.conn.execute("DELETE FROM faces WHERE id=?1", params![id]);
      let _ = fs::remove_file(lib.root.join(META_DIR).join("faces").join(format!("{id}.jpg")));
    }
    Ok(())
  })
}
