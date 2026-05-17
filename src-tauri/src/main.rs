#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod scroll_capture;

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
use scroll_capture::{begin_scroll_capture, step_scroll_capture};
use serde::Serialize;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    utils::config::Color,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{BOOL, HWND, LPARAM, RECT},
    Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS},
    UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, IsIconic, IsWindowVisible},
};

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
    windows: Vec<CaptureWindow>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CaptureWindow {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

struct DesktopCapture {
    image: RgbaImage,
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

    let mut should_wait_for_hidden_window = false;
    if let Some(window) = app.get_webview_window("main") {
        let was_visible = window.is_visible().unwrap_or(false);
        let _ = window.hide();
        should_wait_for_hidden_window |= was_visible;
    }

    if let Some(window) = app.get_webview_window("overlay") {
        let was_visible = window.is_visible().unwrap_or(false);
        let _ = window.set_position(PhysicalPosition::new(-32000, -32000));
        let _ = window.hide();
        should_wait_for_hidden_window |= was_visible;
        if let Ok(mut pending_capture) = state.pending_capture.lock() {
            pending_capture.take();
        }
    }

    if should_wait_for_hidden_window {
        std::thread::sleep(Duration::from_millis(120));
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

    if previous == shortcut && app.global_shortcut().is_registered(shortcut.as_str()) {
        return Ok(());
    }

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
    let state = app.state::<CaptureState>();
    if let Ok(mut pending_capture) = state.pending_capture.lock() {
        pending_capture.take();
    }
    if let Some(window) = app.get_webview_window("overlay") {
        let _ = window.set_ignore_cursor_events(false);
        window.set_position(PhysicalPosition::new(-32000, -32000))?;
        window.hide()?;
    }
    Ok(())
}

#[tauri::command]
async fn lock_overlay_window(
    app: AppHandle,
    width: u32,
    height: u32,
    origin_x: i32,
    origin_y: i32,
) -> Result<(), AppError> {
    if let Some(window) = app.get_webview_window("overlay") {
        align_overlay_window(&window, width, height, origin_x, origin_y)?;
        let _ = window.set_content_protected(true);
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
    let capture = capture_desktop_image()?;
    let windows = detect_capture_windows(
        capture.origin_x,
        capture.origin_y,
        capture.width,
        capture.height,
    );
    let image_data_url = encode_image_data_url(capture.image, ImageOutputFormat::Jpeg(86))?;

    Ok(CapturePayload {
        image_data_url,
        width: capture.width,
        height: capture.height,
        origin_x: capture.origin_x,
        origin_y: capture.origin_y,
        windows,
    })
}

fn capture_desktop_image() -> Result<DesktopCapture, AppError> {
    let screens =
        Screen::all().map_err(|error| AppError::Message(format!("读取屏幕失败：{error}")))?;
    if screens.is_empty() {
        return Err(AppError::Message("没有可用屏幕".into()));
    }

    let min_x = screens
        .iter()
        .map(|screen| screen.display_info.x)
        .min()
        .unwrap_or(0);
    let min_y = screens
        .iter()
        .map(|screen| screen.display_info.y)
        .min()
        .unwrap_or(0);
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

    Ok(DesktopCapture {
        image: canvas,
        width,
        height,
        origin_x: min_x,
        origin_y: min_y,
    })
}

fn encode_image_data_url(image: RgbaImage, format: ImageOutputFormat) -> Result<String, AppError> {
    let mime = match format {
        ImageOutputFormat::Png => "image/png",
        ImageOutputFormat::Jpeg(_) => "image/jpeg",
        _ => "image/png",
    };
    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image).write_to(&mut buffer, format)?;
    let encoded = general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(format!("data:{mime};base64,{encoded}"))
}

#[cfg(target_os = "windows")]
fn detect_capture_windows(
    origin_x: i32,
    origin_y: i32,
    desktop_width: u32,
    desktop_height: u32,
) -> Vec<CaptureWindow> {
    let mut raw_windows: Vec<RECT> = Vec::new();
    unsafe {
        EnumWindows(
            Some(enum_capture_window),
            &mut raw_windows as *mut Vec<RECT> as LPARAM,
        );
    }

    let desktop_right = origin_x + desktop_width as i32;
    let desktop_bottom = origin_y + desktop_height as i32;
    raw_windows
        .into_iter()
        .filter_map(|rect| {
            let left = rect.left.max(origin_x);
            let top = rect.top.max(origin_y);
            let right = rect.right.min(desktop_right);
            let bottom = rect.bottom.min(desktop_bottom);
            let width = right - left;
            let height = bottom - top;
            if width < 60 || height < 40 {
                return None;
            }

            Some(CaptureWindow {
                x: left - origin_x,
                y: top - origin_y,
                width: width as u32,
                height: height as u32,
            })
        })
        .collect()
}

#[cfg(not(target_os = "windows"))]
fn detect_capture_windows(
    _origin_x: i32,
    _origin_y: i32,
    _desktop_width: u32,
    _desktop_height: u32,
) -> Vec<CaptureWindow> {
    Vec::new()
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn enum_capture_window(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if hwnd.is_null() || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 {
        return 1;
    }

    let mut cloaked = 0u32;
    let cloaked_result = DwmGetWindowAttribute(
        hwnd,
        DWMWA_CLOAKED as u32,
        &mut cloaked as *mut u32 as *mut _,
        std::mem::size_of::<u32>() as u32,
    );
    if cloaked_result >= 0 && cloaked != 0 {
        return 1;
    }

    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    let bounds_result = DwmGetWindowAttribute(
        hwnd,
        DWMWA_EXTENDED_FRAME_BOUNDS as u32,
        &mut rect as *mut RECT as *mut _,
        std::mem::size_of::<RECT>() as u32,
    );
    if bounds_result < 0 && GetWindowRect(hwnd, &mut rect) == 0 {
        return 1;
    }

    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    if width >= 60 && height >= 40 {
        let windows = &mut *(lparam as *mut Vec<RECT>);
        windows.push(rect);
    }

    1
}

fn show_overlay(app: &AppHandle, payload: CapturePayload) -> Result<(), AppError> {
    let window = ensure_overlay_window(app)?;
    let width = payload.width;
    let height = payload.height;
    let origin_x = payload.origin_x;
    let origin_y = payload.origin_y;

    window.hide()?;
    align_overlay_window(&window, width, height, origin_x, origin_y)?;
    let _ = window.set_content_protected(true);
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
    align_overlay_window(&window, width, height, origin_x, origin_y)?;
    Ok(())
}

fn align_overlay_window(
    window: &tauri::WebviewWindow,
    width: u32,
    height: u32,
    origin_x: i32,
    origin_y: i32,
) -> Result<(), AppError> {
    window.set_resizable(false)?;
    window.set_size(PhysicalSize::new(width, height))?;
    window.set_position(PhysicalPosition::new(origin_x, origin_y))?;

    for _ in 0..3 {
        let inner_size = window.inner_size()?;
        let outer_size = window.outer_size()?;
        let inner_position = window.inner_position()?;
        let outer_position = window.outer_position()?;

        let frame_width = outer_size.width.saturating_sub(inner_size.width);
        let frame_height = outer_size.height.saturating_sub(inner_size.height);
        let target_outer_width = width.saturating_add(frame_width);
        let target_outer_height = height.saturating_add(frame_height);

        if outer_size.width != target_outer_width || outer_size.height != target_outer_height {
            window.set_size(PhysicalSize::new(target_outer_width, target_outer_height))?;
        }

        let offset_x = inner_position.x - outer_position.x;
        let offset_y = inner_position.y - outer_position.y;
        let target_outer_x = origin_x - offset_x;
        let target_outer_y = origin_y - offset_y;

        if outer_position.x != target_outer_x || outer_position.y != target_outer_y {
            window.set_position(PhysicalPosition::new(target_outer_x, target_outer_y))?;
        }

        let aligned_size = window.inner_size()?;
        let aligned_position = window.inner_position()?;
        if aligned_size.width == width
            && aligned_size.height == height
            && aligned_position.x == origin_x
            && aligned_position.y == origin_y
        {
            break;
        }
    }

    Ok(())
}

fn ensure_overlay_window(app: &AppHandle) -> Result<tauri::WebviewWindow, AppError> {
    if let Some(window) = app.get_webview_window("overlay") {
        return Ok(window);
    }

    Ok(
        WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("/overlay/".into()))
            .title("截图")
            .decorations(false)
            .transparent(true)
            .background_color(Color(0, 0, 0, 0))
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .drag_and_drop(false)
            .disable_drag_drop_handler()
            .visible(false)
            .build()?,
    )
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
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _shortcut, event| {
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
            lock_overlay_window,
            take_pending_capture,
            save_png_base64,
            copy_png_base64,
            begin_scroll_capture,
            step_scroll_capture
        ])
        .setup(|app| {
            build_tray(app)?;
            if let Err(error) = register_capture_shortcut(app.handle(), "Alt+A") {
                eprintln!("failed to register default shortcut Alt+A: {error}");
            }
            *app.state::<CaptureState>()
                .shortcut
                .lock()
                .map_err(|_| AppError::Message("快捷键状态初始化失败".into()))? = "Alt+A".into();
            show_main(app.handle());

            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = ensure_overlay_window(&app_handle);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run app");
}
