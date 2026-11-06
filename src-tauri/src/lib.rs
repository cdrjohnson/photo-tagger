mod library;

use library::LibraryState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(LibraryState::default())
    .invoke_handler(tauri::generate_handler![
      library::library_get_path,
      library::library_pick,
      library::library_clear,
      library::library_list_photos,
      library::library_put_photo,
      library::library_save_blobs,
      library::library_get_blob,
      library::library_put_embedding,
      library::library_all_embeddings,
      library::library_delete_photos,
      library::library_clear_all,
      library::library_kv_get,
      library::library_kv_set,
      library::library_all_faces,
      library::library_put_faces,
      library::library_clear_faces,
      library::library_import_bytes,
      library::library_read_file,
      library::library_delete_face_ids,
    ])
    .setup(|app| {
      // Restore last library path from app config dir
      let state = app.state::<LibraryState>();
      if let Ok(dir) = app.path().app_config_dir() {
        let marker = dir.join("library-path.txt");
        if let Ok(p) = std::fs::read_to_string(&marker) {
          let p = p.trim().to_string();
          if !p.is_empty() && std::path::Path::new(&p).is_dir() {
            let _ = state.open(&p);
          }
        }
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running Photo Tagger");
}
