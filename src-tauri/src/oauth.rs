//! Dropbox OAuth return path for the desktop app: a one-shot HTTP listener on 127.0.0.1.
//! The system browser is opened on Dropbox's authorize page; Dropbox redirects to
//! http://127.0.0.1:<port>/?code=…&state=… and we hand the query string back to the webview,
//! which does the PKCE token exchange itself. Nothing else is served.
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

fn open_browser(url: &str) -> Result<(), String> {
  #[cfg(target_os = "windows")]
  let r = std::process::Command::new("rundll32").args(["url.dll,FileProtocolHandler", url]).spawn();
  #[cfg(target_os = "macos")]
  let r = std::process::Command::new("open").arg(url).spawn();
  #[cfg(all(unix, not(target_os = "macos")))]
  let r = std::process::Command::new("xdg-open").arg(url).spawn();
  r.map(|_| ()).map_err(|e| format!("Could not open the browser: {e}"))
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>Photo Tagger</title><body style=\"font-family:system-ui;padding:3em;text-align:center\"><h2>Dropbox is connected</h2><p>You can close this tab and return to Photo Tagger.</p></body>";

fn wait_for_code(port: u16, auth_url: String) -> Result<String, String> {
  if !auth_url.starts_with("https://www.dropbox.com/oauth2/authorize?") {
    return Err("unexpected authorize URL".into());
  }
  let listener = TcpListener::bind(("127.0.0.1", port))
    .map_err(|e| format!("Port {port} is busy, so Dropbox sign-in cannot return to the app ({e}). Close other apps using it and try again."))?;
  listener.set_nonblocking(true).map_err(|e| e.to_string())?;
  open_browser(&auth_url)?;
  let deadline = Instant::now() + Duration::from_secs(300);
  loop {
    if Instant::now() > deadline {
      return Err("Timed out waiting for Dropbox sign-in.".into());
    }
    match listener.accept() {
      Ok((mut stream, _)) => {
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buf = [0u8; 8192];
        let n = stream.read(&mut buf).unwrap_or(0);
        let req = String::from_utf8_lossy(&buf[..n]).to_string();
        let target = req.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("").to_string();
        let query = target.split_once('?').map(|(_, q)| q.to_string()).unwrap_or_default();
        if query.contains("code=") || query.contains("error=") {
          let _ = stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", PAGE.len(), PAGE).as_bytes());
          return Ok(query);
        }
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
      }
      Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(150)),
      Err(e) => return Err(e.to_string()),
    }
  }
}

#[tauri::command]
pub async fn dropbox_oauth_loopback(auth_url: String, port: u16) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || wait_for_code(port, auth_url))
    .await
    .map_err(|e| e.to_string())?
}
