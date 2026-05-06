#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    borrow::Cow,
    io::Cursor,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use arboard::{Clipboard, ImageData};
use base64::{engine::general_purpose, Engine as _};
use image::{DynamicImage, GenericImage, ImageBuffer, ImageOutputFormat, RgbaImage};
use screenshots::Screen;
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    utils::config::Color,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("{0}")]
    Message(String),
    #[error(transparent)]
    Image(#[from] image::ImageError),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Clipboard(#[from] arboard::Error),
    #[error(transparent)]
    Tauri(#[from] tauri::Error),
    #[error(transparent)]
    Shortcut(#[from] tauri_plugin_global_shortcut::Error),
}

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

#[derive(Default)]
struct CaptureState {
    in_progress: Mutex<bool>,
    pending_capture: Mutex<Option<CapturePayload>>,
    shortcut: Mutex<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CapturePayload {
    image_data_url: String,
    width: u32,
    height: u32,
    origin_x: i32,
    origin_y: i32,
}

async fn run_capture(app: AppHandle) -> Result<(), AppError> {
    let state = app.state::<CaptureState>();
    {
        let mut in_progress = state
            .in_progress
            .lock()
            .map_err(|_| AppError::Message("截图状态锁定失败".into()))?;
        if *in_progress {
            return Ok(());
        }
        *in_progress = true;
    }

    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.hide();
        if let Ok(mut pending_capture) = state.pending_capture.lock() {
            pending_capture.take();
        }
        std::thread::sleep(Duration::from_millis(90));
    }

    let result = match tauri::async_runtime::spawn_blocking(capture_desktop).await {
        Ok(payload) => payload.and_then(|payload| show_overlay(&app, payload)),
        Err(error) => Err(AppError::Message(format!("截图任务失败：{error}"))),
    };

    if let Ok(mut in_progress) = state.in_progress.lock() {
        *in_progress = false;
    }

    result
}

#[tauri::command]
async fn start_capture(app: AppHandle) -> Result<(), AppError> {
    run_capture(app).await
}

#[tauri::command]
async fn set_shortcut(app: AppHandle, shortcut: String) -> Result<(), AppError> {
    let shortcut = shortcut.trim().to_string();
    if shortcut.is_empty() {
        return Err(AppError::Message("快捷键不能为空".into()));
    }

    let state = app.state::<CaptureState>();
    let previous = state
        .shortcut
        .lock()
        .map_err(|_| AppError::Message("快捷键状态读取失败".into()))?
        .clone();

    if !previous.is_empty() && app.global_shortcut().is_registered(previous.as_str()) {
        app.global_shortcut().unregister(previous.as_str())?;
    }

    register_capture_shortcut(&app, &shortcut)?;
    *state
        .shortcut
        .lock()
        .map_err(|_| AppError::Message("快捷键状态保存失败".into()))? = shortcut;
    Ok(())
}

#[tauri::command]
async fn finish_capture(app: AppHandle) -> Result<(), AppError> {
    if let Ok(mut pending_capture) = app.state::<CaptureState>().pending_capture.lock() {
        pending_capture.take();
    }
    if let Some(window) = app.get_webview_window("overlay") {
        window.hide()?;
    }
    Ok(())
}

#[tauri::command]
async fn take_pending_capture(
    state: tauri::State<'_, CaptureState>,
) -> Result<Option<CapturePayload>, AppError> {
    let mut pending_capture = state
        .pending_capture
        .lock()
        .map_err(|_| AppError::Message("读取待显示截图失败".into()))?;
    Ok(pending_capture.take())
}

#[tauri::command]
async fn save_png_base64(png_base64: String) -> Result<Option<String>, AppError> {
    let bytes = general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|error| AppError::Message(format!("PNG 解码失败：{error}")))?;

    let default_name = format!("screenshot-{}.png", timestamp_millis());
    let path = rfd::FileDialog::new()
        .set_title("保存截图")
        .set_file_name(&default_name)
        .add_filter("PNG 图片", &["png"])
        .save_file();

    let Some(path) = path else {
        return Ok(None);
    };

    std::fs::write(&path, bytes)?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn copy_png_base64(png_base64: String) -> Result<(), AppError> {
    let bytes = general_purpose::STANDARD
        .decode(png_base64)
        .map_err(|error| AppError::Message(format!("PNG 解码失败：{error}")))?;
    let image = image::load_from_memory(&bytes)?.to_rgba8();
    let width = image.width() as usize;
    let height = image.height() as usize;
    let mut clipboard = Clipboard::new()?;
    clipboard.set_image(ImageData {
        width,
        height,
        bytes: Cow::Owned(image.into_raw()),
    })?;
    Ok(())
}

fn capture_desktop() -> Result<CapturePayload, AppError> {
    let screens = Screen::all().map_err(|error| AppError::Message(format!("读取屏幕失败：{error}")))?;
    if screens.is_empty() {
        return Err(AppError::Message("没有可用屏幕".into()));
    }

    let min_x = screens.iter().map(|screen| screen.display_info.x).min().unwrap_or(0);
    let min_y = screens.iter().map(|screen| screen.display_info.y).min().unwrap_or(0);
    let max_x = screens
        .iter()
        .map(|screen| screen.display_info.x + screen.display_info.width as i32)
        .max()
        .unwrap_or(0);
    let max_y = screens
        .iter()
        .map(|screen| screen.display_info.y + screen.display_info.height as i32)
        .max()
        .unwrap_or(0);

    let width = (max_x - min_x).max(1) as u32;
    let height = (max_y - min_y).max(1) as u32;
    let mut canvas: RgbaImage = ImageBuffer::new(width, height);

    for screen in screens {
        let image = screen
            .capture()
            .map_err(|error| AppError::Message(format!("屏幕捕获失败：{error}")))?;
        let x = (screen.display_info.x - min_x).max(0) as u32;
        let y = (screen.display_info.y - min_y).max(0) as u32;
        canvas.copy_from(&image, x, y)?;
    }

    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(canvas).write_to(&mut buffer, ImageOutputFormat::Jpeg(86))?;
    let encoded = general_purpose::STANDARD.encode(buffer.into_inner());

    Ok(CapturePayload {
        image_data_url: format!("data:image/jpeg;base64,{encoded}"),
        width,
        height,
        origin_x: min_x,
        origin_y: min_y,
    })
}

fn show_overlay(app: &AppHandle, payload: CapturePayload) -> Result<(), AppError> {
    let window = ensure_overlay_window(app)?;

    window.hide()?;
    window.set_size(PhysicalSize::new(payload.width, payload.height))?;
    window.set_position(PhysicalPosition::new(payload.origin_x, payload.origin_y))?;
    {
        let state = app.state::<CaptureState>();
        let mut pending_capture = state
            .pending_capture
            .lock()
            .map_err(|_| AppError::Message("缓存待显示截图失败".into()))?;
        pending_capture.replace(payload.clone());
    }
    window.emit("capture-ready", payload)?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

fn ensure_overlay_window(app: &AppHandle) -> Result<tauri::WebviewWindow, AppError> {
    if let Some(window) = app.get_webview_window("overlay") {
        return Ok(window);
    }

    Ok(WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("/overlay/".into()))
        .title("截图")
        .decorations(false)
        .transparent(true)
        .background_color(Color(0, 0, 0, 0))
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .build()?)
}

fn timestamp_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn show_main(app: &AppHandle) {
    let window = app.get_webview_window("main").or_else(|| {
        WebviewWindowBuilder::new(app, "main", WebviewUrl::App("/".into()))
            .title("屏幕截图设置")
            .inner_size(460.0, 430.0)
            .resizable(false)
            .visible(false)
            .build()
            .ok()
    });

    if let Some(window) = window {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &mut tauri::App) -> Result<(), tauri::Error> {
    let show = MenuItem::with_id(app, "show", "打开设置", true, None::<&str>)?;
    let capture = MenuItem::with_id(app, "capture", "立即截图", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &capture, &quit])?;

    let mut builder = TrayIconBuilder::new()
        .tooltip("屏幕截图")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main(app),
            "capture" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = run_capture(app).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}

fn register_capture_shortcut(app: &AppHandle, shortcut: &str) -> Result<(), AppError> {
    app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = run_capture(app).await;
            });
        }
    })?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(CaptureState::default())
        .invoke_handler(tauri::generate_handler![
            start_capture,
            set_shortcut,
            finish_capture,
            take_pending_capture,
            save_png_base64,
            copy_png_base64
        ])
        .setup(|app| {
            build_tray(app)?;
            ensure_overlay_window(app.handle())?;
            register_capture_shortcut(app.handle(), "Alt+A")?;
            *app
                .state::<CaptureState>()
                .shortcut
                .lock()
                .map_err(|_| AppError::Message("快捷键状态初始化失败".into()))? = "Alt+A".into();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run app");
}
