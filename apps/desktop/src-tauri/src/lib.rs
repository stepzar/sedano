//! Tauri shell for sedano.
//!
//! The window is a thin webview over a static bundle; every bit of real work
//! happens in the local sedano server (one Bun process). The shell attaches to
//! an already-running server when it is *its own kind* (same instance, same
//! store, same version — see `classify`), replaces one that is its own kind but
//! from another release, otherwise starts the bundled sidecar (a debug build
//! runs the source with the local `bun` first). Whatever it starts, it also
//! stops when the app quits.
//!
//! Two Sedanos can live on one Mac and must never meet: the installed app
//! (release build: `~/.sedano`, port 7788, the user's real data) and the
//! development copy (`tauri dev`, i.e. a debug build: `~/.sedano-dev`, 7789,
//! the same defaults as `scripts/lib/dev-env.ts`).

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// A debug build is what `tauri dev` runs: the development copy.
const DEV: bool = cfg!(debug_assertions);

/// How long a server has to stay up before a later exit is treated as a fresh
/// failure rather than the next step of a crash loop.
const HEALTHY_UPTIME: Duration = Duration::from_secs(60);

/// Past this size the log is started over, so a crash loop cannot fill the disk.
const LOG_LIMIT_BYTES: u64 = 5 * 1024 * 1024;

static SERVER: Mutex<Option<Child>> = Mutex::new(None);
static STOPPING: AtomicBool = AtomicBool::new(false);
/// The UI bundle shipped in Resources, served by the sidecar to paired phones.
static UI_DIST: OnceLock<PathBuf> = OnceLock::new();

/// Injected before the UI boots, so the client knows where the API is even
/// though the page itself is served from `tauri://localhost`.
///
/// The port is the one we actually use: hardcoding 7788 here while `port()`
/// honoured `SEDANO_PORT` meant a custom port spawned a server the window then
/// could not find.
fn init_script() -> String {
    let mut script = format!(
        "window.__SEDANO_API__ = '127.0.0.1:{}';\n  document.documentElement.classList.add('tauri');\n  document.documentElement.dataset.platform = 'macos';\n",
        port()
    );
    if DEV {
        script.push_str(&DEV_MARK.replace("{port}", &port().to_string()));
    }
    script
}

/// The dev window's title is hidden under the overlay title bar, so the page
/// itself says it is the development copy: an orange strip and a DEV pill (the
/// same mark `vite.config.ts` injects for a dev browser tab).
const DEV_MARK: &str = r#"
addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('sedano-dev-badge')) return
  const mark = document.createElement('div')
  mark.id = 'sedano-dev-badge'
  mark.setAttribute('style', 'position:fixed;top:0;left:0;right:0;height:3px;background:#f59e0b;z-index:2147483647;pointer-events:none')
  const pill = document.createElement('span')
  pill.textContent = 'DEV :{port}'
  pill.setAttribute('style', 'position:fixed;top:4px;right:8px;padding:0 6px;border-radius:7px;background:#f59e0b;color:#1c1917;font:700 9px/14px -apple-system,system-ui,sans-serif;letter-spacing:.08em')
  mark.appendChild(pill)
  document.body.appendChild(mark)
  document.title = 'Sedano Dev'
})
"#;

/// What the server reports as `instance` in `/api/health`.
fn instance() -> &'static str {
    if DEV { "dev" } else { "app" }
}

fn app_name() -> &'static str {
    if DEV { "Sedano Dev" } else { "Sedano" }
}

/// The dev copy reads `SEDANO_DEV_*`, never `SEDANO_PORT`/`SEDANO_HOME`: a
/// terminal inside the installed app inherits those from its server, and a
/// `desktop:dev` started there must not land on the real store.
fn port() -> u16 {
    let (variable, default) = if DEV { ("SEDANO_DEV_PORT", 7789) } else { ("SEDANO_PORT", 7788) };
    std::env::var(variable)
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(default)
}

fn sedano_home() -> Option<PathBuf> {
    let (variable, dir) = if DEV { ("SEDANO_DEV_HOME", ".sedano-dev") } else { ("SEDANO_HOME", ".sedano") };
    std::env::var_os(variable)
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(dir)))
}

fn same_path(left: &Path, right: &Path) -> bool {
    let canonical = |path: &Path| std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    canonical(left) == canonical(right)
}

/// Who is on our port.
#[derive(Debug, PartialEq)]
enum Listener {
    Free,
    /// Our own kind of server (same instance, store and version): attach to it.
    Ours,
    /// Our own instance and store, but another release — typically the server
    /// an older version left running across an update. Attaching would put a UI
    /// in front of an API it was not built for, and run old migrations-era code
    /// on the store, so it is asked to leave and the bundled server takes over.
    Stale { pid: u32, version: String },
    /// Anything else, described for the person who has to stop it.
    Other(String),
}

/// What this shell would attach to.
struct Expected<'a> {
    instance: &'a str,
    home: Option<&'a Path>,
    version: &'a str,
}

/// The decision, from the `/api/health` body alone (`Value::Null` when the
/// listener did not answer with JSON). Kept free of I/O so it can be tested.
fn classify(health: &serde_json::Value, expected: &Expected) -> Listener {
    let their_instance = health.get("instance").and_then(|value| value.as_str());
    let their_home = health.get("home").and_then(|value| value.as_str()).map(PathBuf::from);
    match (their_instance, their_home, expected.home) {
        (Some(theirs), Some(home), Some(ours)) if theirs == expected.instance && same_path(&home, ours) => {
            // A server from before `version` existed is an older release too.
            let version = health.get("version").and_then(|value| value.as_str()).unwrap_or("unknown");
            if version == expected.version {
                return Listener::Ours;
            }
            match health.get("pid").and_then(|value| value.as_u64()).and_then(|pid| u32::try_from(pid).ok()) {
                Some(pid) if pid > 1 => Listener::Stale { pid, version: version.to_string() },
                _ => Listener::Other(format!(
                    "a Sedano server of another version ({version}) that did not say which process it is"
                )),
            }
        }
        (Some(theirs), Some(home), _) => Listener::Other(format!(
            "the {} Sedano (data in {})",
            if theirs == "dev" { "development" } else { "installed" },
            home.display()
        )),
        _ if health.get("ok").is_some() => {
            Listener::Other("an older Sedano server (probably `bun run dev` from before the dev/app split)".into())
        }
        _ => Listener::Other("a program that is not Sedano".into()),
    }
}

/// Asks whatever listens on `port` who it is. A bare TCP connect used to be
/// enough, which let the installed app attach to a `bun run dev` server (or the
/// other way round) and show one Sedano's sessions in the other's window.
fn probe(port: u16, version: &str) -> Listener {
    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(350)) else {
        return Listener::Free;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
    let request = format!("GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    let mut response = String::new();
    if stream.write_all(request.as_bytes()).is_ok() {
        // A timeout still leaves whatever arrived before it.
        let _ = stream.read_to_string(&mut response);
    }
    let body = response.split_once("\r\n\r\n").map(|(_, body)| body).unwrap_or("");
    let health: serde_json::Value = serde_json::from_str(body.trim()).unwrap_or(serde_json::Value::Null);
    let home = sedano_home();
    classify(&health, &Expected { instance: instance(), home: home.as_deref(), version })
}

/// True when `pid` is the process listening on `port`. The pid comes from the
/// server's own health answer; this makes sure a recycled or wrong pid can never
/// turn into a signal sent to an unrelated process.
fn listens_on(pid: u32, port: u16) -> bool {
    let Ok(output) = Command::new("/usr/sbin/lsof")
        .args(["-nP", "-a", "-p", &pid.to_string(), &format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return false;
    };
    String::from_utf8_lossy(&output.stdout).lines().any(|line| line.trim() == pid.to_string())
}

/// Stops a stale server of ours (see `Listener::Stale`) and waits for the port.
///
/// SIGTERM to that one process, not its group: the server's own shutdown stops
/// the helpers it started, and durable agents live in process groups of their
/// own, so they keep running and the new server picks them up. No SIGKILL — a
/// server that does not leave within the wait is reported, not forced.
fn replace_stale(pid: u32, port: u16) -> Result<(), String> {
    if !listens_on(pid, port) {
        return Err(format!("process {pid} does not appear to be the server on port {port}"));
    }
    let sent = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false);
    if !sent {
        return Err(format!("could not signal process {pid}"));
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if !server_is_up(port) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!("process {pid} did not release port {port} within 8 seconds"))
}

/// True when something is already listening: in that case it is a server the
/// user started on purpose, and we must not fight it for the port.
fn server_is_up(port: u16) -> bool {
    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    TcpStream::connect_timeout(&address, Duration::from_millis(350)).is_ok()
}

/// PATH inherited by the sidecar.
///
/// Finder/LaunchServices does not start applications through the user's login
/// shell, so a packaged app normally sees only the system directories. Keep the
/// inherited order, then add the locations used by Homebrew and the supported
/// user-level installers. We deliberately do not source `.zshrc`: launching the
/// app must not execute arbitrary interactive shell configuration.
fn discovery_path() -> std::ffi::OsString {
    let mut paths: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect())
        .unwrap_or_default();

    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for suffix in [
            ".local/bin",
            "bin",
            ".bun/bin",
            ".volta/bin",
            ".cargo/bin",
            ".local/share/pnpm",
            "Library/pnpm",
            ".npm-global/bin",
            ".asdf/shims",
            ".mise/shims",
            ".claude/bin",
            ".codex/bin",
            ".commandcode/bin",
            ".opencode/bin",
            ".gemini/bin",
            ".grok/bin",
        ] {
            paths.push(home.join(suffix));
        }

        // nvm has no active version outside a shell. Every version is inspected
        // and newer directory names come first among these fallback entries.
        let versions = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(versions) {
            let mut bins: Vec<PathBuf> = entries
                .flatten()
                .filter(|entry| entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false))
                .map(|entry| entry.path().join("bin"))
                .collect();
            bins.sort_by(|left, right| right.cmp(left));
            paths.extend(bins);
        }
    }

    for path in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        paths.push(Path::new(path).to_path_buf());
    }

    paths.dedup();
    std::env::join_paths(paths).unwrap_or_else(|_| std::ffi::OsString::from("/usr/bin:/bin"))
}

/// `server.log` in the store: a packaged app has no terminal, so without it a
/// server that dies on start leaves no trace at all.
///
/// Owner-only, like the rest of the store: the log carries paths, prompts in
/// error messages and host names. The server tightens the store again when it
/// starts; this covers the log it is about to write into.
fn server_log() -> Option<File> {
    let dir = sedano_home()?;
    std::fs::create_dir_all(&dir).ok()?;
    let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    let path = dir.join("server.log");
    let too_big = std::fs::metadata(&path).map(|meta| meta.len() > LOG_LIMIT_BYTES).unwrap_or(false);
    let file = OpenOptions::new()
        .create(true)
        .append(!too_big)
        .write(true)
        .truncate(too_big)
        .mode(0o600)
        .open(&path)
        .ok()?;
    // `mode` applies only when the file is created; an older log keeps its own.
    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    Some(file)
}

fn detached(mut command: Command) -> Command {
    let (stdout, stderr) = match server_log().and_then(|log| Some((log.try_clone().ok()?, log))) {
        Some((out, err)) => (Stdio::from(out), Stdio::from(err)),
        None => (Stdio::null(), Stdio::null()),
    };
    command
        .stdin(Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .env("PATH", discovery_path())
        .env("SEDANO_PORT", port().to_string())
        .env("SEDANO_INSTANCE", instance())
        // The server exits on its own once this app is gone, even after a crash
        // or a force quit that never reaches `kill_server`.
        .env("SEDANO_SUPERVISED", "1")
        // Its own process group, so quitting can stop the server *and* the
        // helpers it spawned (transcript tails, ssh channels, ACP agents).
        // Durable agents start their own group and are deliberately untouched.
        .process_group(0);
    if let Some(home) = sedano_home() {
        command.env("SEDANO_HOME", home);
    }
    match UI_DIST.get() {
        Some(dir) => command.env("SEDANO_UI_DIST", dir),
        None => command.env_remove("SEDANO_UI_DIST"),
    };
    command
}

/// A standalone server binary produced by `bun build --compile`, shipped next to
/// the app executable by `bundle.externalBin`.
fn bundled_server() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    [
        "sedano-server",
        "sedano-server-aarch64-apple-darwin",
        "sedano-server-x86_64-apple-darwin",
    ]
    .iter()
    .map(|name| dir.join(name))
    .find(|candidate| candidate.exists())
}

/// `Contents/Resources/ui`, from `bundle.resources`: the webview has the UI
/// embedded, but a paired phone loads it from the sidecar over HTTP.
fn bundled_ui() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.join("../Resources/ui");
    let dir = std::fs::canonicalize(dir).ok()?;
    dir.join("index.html").exists().then_some(dir)
}

/// Development only: run the server from source. GUI apps do not inherit a
/// login shell's PATH, so the usual install locations are checked too.
///
/// Compiled out of release builds, together with `spawn_from_source`: it bakes
/// the checkout's absolute path into the binary (`CARGO_MANIFEST_DIR`), and an
/// installed app must only ever run the server it ships.
#[cfg(debug_assertions)]
fn find_bun() -> PathBuf {
    let candidates = std::env::var("HOME")
        .map(|home| vec![format!("{home}/.bun/bin/bun")])
        .unwrap_or_default()
        .into_iter()
        .chain([
            "/opt/homebrew/bin/bun".to_string(),
            "/usr/local/bin/bun".to_string(),
            "/usr/bin/bun".to_string(),
        ])
        .map(PathBuf::from);
    candidates
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or_else(|| PathBuf::from("bun"))
}

#[cfg(debug_assertions)]
fn spawn_from_source() -> Option<Child> {
    // CARGO_MANIFEST_DIR is apps/desktop/src-tauri, so the repo root is three up.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let server = root.join("apps/server/src/index.ts");
    if !server.exists() {
        eprintln!("sedano: server not found at {}", server.display());
        return None;
    }
    detached(Command::new(find_bun()))
        .arg(server)
        .current_dir(root)
        .spawn()
        .ok()
}

fn spawn_bundled() -> Option<Child> {
    detached(Command::new(bundled_server()?)).spawn().ok()
}

fn spawn_server() -> Option<Child> {
    // `tauri dev` copies the last compiled sidecar next to the debug binary, so
    // preferring it there would run a stale server instead of the source tree.
    #[cfg(debug_assertions)]
    return spawn_from_source().or_else(spawn_bundled);
    #[cfg(not(debug_assertions))]
    return spawn_bundled();
}

/// Signal the server's whole process group (see `detached`).
fn signal_group(child: &Child, signal: &str) {
    let _ = Command::new("/bin/kill")
        .args([signal, "--", &format!("-{}", child.id())])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

fn kill_server() {
    STOPPING.store(true, Ordering::SeqCst);
    if let Ok(mut guard) = SERVER.lock() {
        if let Some(mut child) = guard.take() {
            // SIGTERM first so the group can close its files, then make sure.
            signal_group(&child, "-TERM");
            let deadline = Instant::now() + Duration::from_secs(2);
            while Instant::now() < deadline && matches!(child.try_wait(), Ok(None)) {
                thread::sleep(Duration::from_millis(50));
            }
            signal_group(&child, "-KILL");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn supervise_server(port: u16) {
    thread::spawn(move || {
        let mut failures = 0u32;
        // `run` spawned (or attached) just before this thread started.
        let mut spawned_at = Instant::now();
        while !STOPPING.load(Ordering::SeqCst) {
            thread::sleep(Duration::from_secs(1));
            if STOPPING.load(Ordering::SeqCst) {
                break;
            }
            let exited = match SERVER.lock() {
                Ok(mut guard) => match guard.as_mut() {
                    Some(child) => match child.try_wait() {
                        Ok(Some(status)) => {
                            eprintln!("sedano: server exited ({status}); reconnecting");
                            // Its helpers do not notice on their own (a `tail -F` never
                            // exits), so the rest of the group goes with it.
                            signal_group(child, "-KILL");
                            *guard = None;
                            true
                        }
                        Ok(None) => false,
                        Err(error) => {
                            eprintln!("sedano: cannot check server: {error}");
                            false
                        }
                    },
                    None => true,
                },
                Err(_) => false,
            };
            if !exited || STOPPING.load(Ordering::SeqCst) {
                continue;
            }
            // A server started outside the app may have claimed the port while
            // ours was down. Never spawn a competing copy over its database.
            if server_is_up(port) {
                failures = 0;
                continue;
            }
            // Only a server that stayed up a while earns a fresh backoff; one
            // that dies on start keeps backing off instead of respawning at 1 Hz.
            failures = if spawned_at.elapsed() > HEALTHY_UPTIME { 1 } else { failures.saturating_add(1) };
            thread::sleep(Duration::from_millis((500u64 << failures.min(5)).min(10_000)));
            if STOPPING.load(Ordering::SeqCst) || server_is_up(port) {
                continue;
            }
            if let Ok(mut guard) = SERVER.lock() {
                if guard.is_none() {
                    *guard = spawn_server();
                    spawned_at = Instant::now();
                }
            }
        }
    });
}

/// Save an exported conversation where the person chose in the native save
/// dialog. Asking and writing are one step here, so the file is always one a
/// person picked (the dialog asks before replacing one); the local server never
/// writes to a path a page hands it.
#[tauri::command]
async fn export_conversation(
    app: tauri::AppHandle,
    name: String,
    content: String,
    markdown: bool,
) -> Result<Option<String>, String> {
    let (label, extension) = if markdown { ("Markdown", "md") } else { ("Text", "txt") };
    // Async, so this runs off the main thread: the blocking dialog needs it free.
    let Some(chosen) = app
        .dialog()
        .file()
        .set_title("Export conversation")
        .set_file_name(name)
        .add_filter(label, &[extension])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = chosen.into_path().map_err(|err| err.to_string())?;
    std::fs::write(&path, content).map_err(|err| format!("could not write {}: {err}", path.display()))?;
    Ok(Some(path.display().to_string()))
}

pub fn run() {
    let app = tauri::Builder::default()
        // The native folder chooser, and the save dialog of an export.
        .plugin(tauri_plugin_dialog::init())
        // Web links from a reply go to the system browser, scoped in capabilities.
        .plugin(tauri_plugin_opener::init())
        // App updates from the GitHub release's `latest.json`, verified against
        // the public key in `tauri.conf.json` before anything is installed; the
        // UI decides when (apps/ui/src/updater.ts).
        .plugin(tauri_plugin_updater::Builder::new().build())
        // `relaunch()` after an update. It goes through the normal exit path, so
        // `kill_server` still stops the old server before the new app starts.
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![export_conversation])
        .setup(|app| {
            let port = port();
            if !DEV {
                match bundled_ui() {
                    Some(dir) => {
                        let _ = UI_DIST.set(dir);
                    }
                    None => eprintln!("sedano: no bundled UI in Contents/Resources/ui; phones will not load"),
                }
            }
            let version = app.package_info().version.to_string();
            // Neither attach (wrong sessions in this window) nor spawn (the port
            // is taken): say what is in the way, then quit.
            let refuse = |message: String| {
                eprintln!("sedano: {message}");
                let handle = app.handle().clone();
                app.dialog()
                    .message(message)
                    .title(format!("{} cannot start", app_name()))
                    .kind(MessageDialogKind::Error)
                    .show(move |_| handle.exit(1));
            };
            let mut spawn = true;
            match probe(port, &version) {
                Listener::Free => {}
                Listener::Ours => {
                    eprintln!("sedano: attaching to the {} server {version} on :{port}", instance());
                    spawn = false;
                }
                Listener::Stale { pid, version: theirs } => {
                    eprintln!("sedano: the server on :{port} is version {theirs}, this app is {version}; replacing it");
                    if let Err(reason) = replace_stale(pid, port) {
                        refuse(format!(
                            "A Sedano server from version {theirs} is still running on port {port}, and this is version {version}: {reason}.\n\nQuit it (or log out and back in), then open {} again.",
                            app_name()
                        ));
                        return Ok(());
                    }
                }
                Listener::Other(who) => {
                    refuse(format!("Port {port} is already used by {who}.\n\nQuit it, then open {} again.", app_name()));
                    return Ok(());
                }
            }
            if spawn {
                let child = spawn_server();
                let started = child.is_some();
                if let Ok(mut guard) = SERVER.lock() {
                    *guard = child;
                }
                if !started {
                    refuse(format!(
                        "{} could not start its server. Reinstall the app; details are in {}.",
                        app_name(),
                        sedano_home().map(|home| home.join("server.log").display().to_string()).unwrap_or_else(|| "server.log".into())
                    ));
                    return Ok(());
                }
            }
            // Also watch a server the user started outside the app. If that
            // process disappears, the window still needs an API to reconnect to.
            supervise_server(port);

            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title(app_name())
                .inner_size(1320.0, 880.0)
                .min_inner_size(920.0, 620.0)
                .initialization_script(init_script())
                // Files dropped on the window are the page's to handle (an image
                // dropped on a composer is attached); the native handler would
                // swallow the drop before the webview ever sees it.
                .disable_drag_drop_handler();

            // Frameless-looking macOS chrome: the traffic lights float over our
            // own header instead of sitting in a separate title bar.
            #[cfg(target_os = "macos")]
            {
                window = window
                    .title_bar_style(tauri::TitleBarStyle::Overlay)
                    .hidden_title(true);
            }

            window.build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building sedano");

    app.run(|_app, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            kill_server();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HOME: &str = "/nonexistent/sedano-test-home";

    fn expected() -> Expected<'static> {
        Expected { instance: "app", home: Some(Path::new(HOME)), version: "0.2.0" }
    }

    #[test]
    fn attaches_to_its_own_instance_store_and_version() {
        let health = json!({ "ok": true, "instance": "app", "home": HOME, "pid": 4242, "version": "0.2.0" });
        assert_eq!(classify(&health, &expected()), Listener::Ours);
    }

    #[test]
    fn replaces_its_own_kind_from_another_version() {
        let health = json!({ "ok": true, "instance": "app", "home": HOME, "pid": 4242, "version": "0.1.0" });
        assert_eq!(classify(&health, &expected()), Listener::Stale { pid: 4242, version: "0.1.0".into() });
    }

    #[test]
    fn a_server_from_before_versions_existed_is_stale() {
        let health = json!({ "ok": true, "instance": "app", "home": HOME, "pid": 4242 });
        assert_eq!(classify(&health, &expected()), Listener::Stale { pid: 4242, version: "unknown".into() });
    }

    #[test]
    fn never_signals_without_a_usable_pid() {
        for pid in [json!(null), json!(0), json!(1), json!("4242"), json!(u64::MAX)] {
            let health = json!({ "ok": true, "instance": "app", "home": HOME, "pid": pid, "version": "0.1.0" });
            assert!(matches!(classify(&health, &expected()), Listener::Other(_)), "pid {pid}");
        }
    }

    #[test]
    fn another_version_of_the_other_instance_is_never_replaced() {
        let health = json!({ "ok": true, "instance": "dev", "home": HOME, "pid": 4242, "version": "0.1.0" });
        assert!(matches!(classify(&health, &expected()), Listener::Other(_)));
    }

    #[test]
    fn another_version_with_another_store_is_never_replaced() {
        let health = json!({ "ok": true, "instance": "app", "home": "/elsewhere", "pid": 4242, "version": "0.1.0" });
        assert!(matches!(classify(&health, &expected()), Listener::Other(_)));
    }

    #[test]
    fn no_home_of_our_own_means_nothing_is_ours() {
        let health = json!({ "ok": true, "instance": "app", "home": HOME, "pid": 4242, "version": "0.2.0" });
        let expected = Expected { home: None, ..expected() };
        assert!(matches!(classify(&health, &expected), Listener::Other(_)));
    }

    #[test]
    fn foreign_listeners_are_described_not_replaced() {
        assert!(matches!(classify(&json!({ "ok": true }), &expected()), Listener::Other(_)));
        assert!(matches!(classify(&serde_json::Value::Null, &expected()), Listener::Other(_)));
    }

    #[test]
    fn a_pid_that_is_not_listening_is_never_signalled() {
        // Our own pid listens on nothing, so `replace_stale` must refuse before
        // it sends any signal (if it did, this test process would get SIGTERM).
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        assert!(replace_stale(std::process::id(), port).is_err());
    }
}
