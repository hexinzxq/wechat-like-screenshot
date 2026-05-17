use std::{io::Cursor, time::Duration};

use base64::{engine::general_purpose, Engine as _};
use image::{imageops, DynamicImage, GenericImage, ImageBuffer, ImageOutputFormat, RgbaImage};
use screenshots::Screen;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[cfg(target_os = "windows")]
use windows_sys::Win32::{
    Foundation::{HWND, POINT},
    UI::{
        Input::KeyboardAndMouse::{
            SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_WHEEL, MOUSEINPUT,
        },
        WindowsAndMessaging::{GetAncestor, SetForegroundWindow, WindowFromPoint, GA_ROOT},
    },
};

#[cfg(target_os = "windows")]
type NativeHwnd = HWND;

#[cfg(not(target_os = "windows"))]
type NativeHwnd = isize;

type ScrollResult<T> = Result<T, String>;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureRequest {
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    cursor_x: i32,
    cursor_y: i32,
    target_hwnd: Option<isize>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrollCaptureFrame {
    image_data_url: String,
    width: u32,
    height: u32,
    target_hwnd: isize,
}

struct DesktopCapture {
    image: RgbaImage,
}

#[tauri::command]
pub async fn begin_scroll_capture(
    app: AppHandle,
    request: ScrollCaptureRequest,
) -> ScrollResult<ScrollCaptureFrame> {
    let request = normalize_scroll_request(request);
    let width = request.source_width;
    let height = request.source_height;
    set_overlay_ignore_cursor(&app, true)?;

    let capture_result = tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(45));
        let target_hwnd = target_window_at(request.cursor_x, request.cursor_y);
        focus_hwnd(target_hwnd);
        Ok::<_, String>(hwnd_to_isize(target_hwnd))
    })
    .await;

    let _ = set_overlay_ignore_cursor(&app, false);
    let target_hwnd =
        capture_result.map_err(|error| format!("scroll capture init failed: {error}"))??;

    Ok(ScrollCaptureFrame {
        width,
        height,
        image_data_url: String::new(),
        target_hwnd,
    })
}

#[tauri::command]
pub async fn step_scroll_capture(
    app: AppHandle,
    request: ScrollCaptureRequest,
    scroll_delta_y: i32,
) -> ScrollResult<ScrollCaptureFrame> {
    let request = normalize_scroll_request(request);
    let should_forward_wheel = scroll_delta_y != 0;
    if should_forward_wheel {
        set_overlay_ignore_cursor(&app, true)?;
    }

    let capture_result = tauri::async_runtime::spawn_blocking(move || {
        let target_hwnd = request
            .target_hwnd
            .map(isize_to_hwnd)
            .filter(|hwnd| !hwnd_is_null(*hwnd))
            .unwrap_or_else(|| target_window_at(request.cursor_x, request.cursor_y));
        if scroll_delta_y != 0 {
            focus_hwnd(target_hwnd);
            std::thread::sleep(Duration::from_millis(35));
            send_wheel_delta(scroll_delta_y);
            std::thread::sleep(Duration::from_millis(95));
        }
        let image = capture_stable_scroll_region(&request)?;
        Ok::<_, String>((image, hwnd_to_isize(target_hwnd)))
    })
    .await;

    if should_forward_wheel {
        let _ = set_overlay_ignore_cursor(&app, false);
    }

    let (image, target_hwnd) =
        capture_result.map_err(|error| format!("scroll capture failed: {error}"))??;

    Ok(ScrollCaptureFrame {
        width: image.width(),
        height: image.height(),
        image_data_url: encode_image_data_url(image, ImageOutputFormat::Png)?,
        target_hwnd,
    })
}

fn normalize_scroll_request(request: ScrollCaptureRequest) -> ScrollCaptureRequest {
    ScrollCaptureRequest {
        source_x: request.source_x,
        source_y: request.source_y,
        source_width: request.source_width.clamp(40, 8192),
        source_height: request.source_height.clamp(40, 8192),
        cursor_x: request.cursor_x,
        cursor_y: request.cursor_y,
        target_hwnd: request.target_hwnd,
    }
}

fn capture_scroll_region(request: &ScrollCaptureRequest) -> ScrollResult<RgbaImage> {
    let desktop = capture_desktop_image()?;
    crop_desktop_area(
        &desktop.image,
        request.source_x,
        request.source_y,
        request.source_width,
        request.source_height,
    )
}

fn capture_stable_scroll_region(request: &ScrollCaptureRequest) -> ScrollResult<RgbaImage> {
    let first = capture_scroll_region(request)?;
    std::thread::sleep(Duration::from_millis(55));
    let second = capture_scroll_region(request)?;
    if images_are_similar(&first, &second) {
        return Ok(second);
    }

    std::thread::sleep(Duration::from_millis(70));
    capture_scroll_region(request)
}

fn capture_desktop_image() -> ScrollResult<DesktopCapture> {
    let screens = Screen::all().map_err(|error| format!("读取屏幕失败：{error}"))?;
    if screens.is_empty() {
        return Err("没有可用屏幕".into());
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
            .map_err(|error| format!("屏幕捕获失败：{error}"))?;
        let x = (screen.display_info.x - min_x).max(0) as u32;
        let y = (screen.display_info.y - min_y).max(0) as u32;
        canvas
            .copy_from(&image, x, y)
            .map_err(|error| format!("屏幕合成失败：{error}"))?;
    }

    Ok(DesktopCapture { image: canvas })
}

fn crop_desktop_area(
    image: &RgbaImage,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> ScrollResult<RgbaImage> {
    if x >= image.width() || y >= image.height() {
        return Err("scroll capture area is outside the desktop".into());
    }

    let crop_width = width.min(image.width() - x).max(1);
    let crop_height = height.min(image.height() - y).max(1);
    Ok(imageops::crop_imm(image, x, y, crop_width, crop_height).to_image())
}

fn encode_image_data_url(image: RgbaImage, format: ImageOutputFormat) -> ScrollResult<String> {
    let mime = match format {
        ImageOutputFormat::Png => "image/png",
        ImageOutputFormat::Jpeg(_) => "image/jpeg",
        _ => "image/png",
    };
    let mut buffer = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image)
        .write_to(&mut buffer, format)
        .map_err(|error| format!("图片编码失败：{error}"))?;
    let encoded = general_purpose::STANDARD.encode(buffer.into_inner());
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn images_are_similar(previous: &RgbaImage, current: &RgbaImage) -> bool {
    if previous.dimensions() != current.dimensions() {
        return false;
    }
    sampled_diff(previous, current, 0, 0, previous.height()) <= 2.8
}

fn sampled_diff(
    previous: &RgbaImage,
    current: &RgbaImage,
    previous_y: u32,
    current_y: u32,
    height: u32,
) -> f64 {
    let width = previous.width().min(current.width());
    if width == 0 || height == 0 {
        return f64::MAX;
    }

    let step_x = (width / 48).max(1);
    let step_y = (height / 72).max(1);
    let mut total = 0f64;
    let mut count = 0u64;
    let end_y = height
        .min(previous.height().saturating_sub(previous_y))
        .min(current.height().saturating_sub(current_y));

    let mut y = 0;
    while y < end_y {
        let mut x = 0;
        while x < width {
            let a = previous.get_pixel(x, previous_y + y).0;
            let b = current.get_pixel(x, current_y + y).0;
            total += ((a[0] as i32 - b[0] as i32).abs()
                + (a[1] as i32 - b[1] as i32).abs()
                + (a[2] as i32 - b[2] as i32).abs()) as f64
                / 3.0;
            count += 1;
            x += step_x;
        }
        y += step_y;
    }

    if count == 0 {
        f64::MAX
    } else {
        total / count as f64
    }
}

fn set_overlay_ignore_cursor(app: &AppHandle, ignore: bool) -> ScrollResult<()> {
    if let Some(window) = app.get_webview_window("overlay") {
        window
            .set_ignore_cursor_events(ignore)
            .map_err(|error| format!("设置截图窗口鼠标穿透失败：{error}"))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn target_window_at(x: i32, y: i32) -> NativeHwnd {
    let point = POINT { x, y };
    unsafe {
        let hwnd = WindowFromPoint(point);
        if hwnd.is_null() {
            hwnd
        } else {
            GetAncestor(hwnd, GA_ROOT)
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn target_window_at(_x: i32, _y: i32) -> NativeHwnd {
    0
}

#[cfg(target_os = "windows")]
fn hwnd_to_isize(hwnd: NativeHwnd) -> isize {
    hwnd as isize
}

#[cfg(not(target_os = "windows"))]
fn hwnd_to_isize(hwnd: NativeHwnd) -> isize {
    hwnd
}

#[cfg(target_os = "windows")]
fn isize_to_hwnd(value: isize) -> NativeHwnd {
    value as NativeHwnd
}

#[cfg(not(target_os = "windows"))]
fn isize_to_hwnd(value: isize) -> NativeHwnd {
    value
}

#[cfg(target_os = "windows")]
fn hwnd_is_null(hwnd: NativeHwnd) -> bool {
    hwnd.is_null()
}

#[cfg(not(target_os = "windows"))]
fn hwnd_is_null(hwnd: NativeHwnd) -> bool {
    hwnd == 0
}

#[cfg(target_os = "windows")]
fn focus_hwnd(hwnd: NativeHwnd) {
    if !hwnd.is_null() {
        unsafe {
            SetForegroundWindow(hwnd);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn focus_hwnd(_hwnd: NativeHwnd) {}

#[cfg(target_os = "windows")]
fn send_wheel_delta(scroll_delta_y: i32) {
    let wheel_delta = if scroll_delta_y > 0 { -120 } else { 120 };
    unsafe {
        let mut input = INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 {
                mi: MOUSEINPUT {
                    dx: 0,
                    dy: 0,
                    mouseData: wheel_delta as u32,
                    dwFlags: MOUSEEVENTF_WHEEL,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        };
        SendInput(1, &mut input, std::mem::size_of::<INPUT>() as i32);
    }
}

#[cfg(not(target_os = "windows"))]
fn send_wheel_delta(_scroll_delta_y: i32) {}
