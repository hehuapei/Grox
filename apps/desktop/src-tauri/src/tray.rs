//! 主窗口与进程生命周期之间的原生边界。
//!
//! 隐藏窗口不能改变 AgentRuntime、自动化或会话事实；托盘只提供恢复窗口和
//! 显式退出入口，真正的资源清算统一交给 crate 根的 Host shutdown 事务。

use std::sync::Mutex;

use tauri::{
    image::Image,
    menu::{Menu, MenuBuilder, MenuEvent, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Wry,
};

const TRAY_ID: &str = "grox-main-tray";

fn build_menu(app: &AppHandle) -> Result<Menu<Wry>, tauri::Error> {
    let open = MenuItem::with_id(app, "open", "打开 Grox", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 Grox", true, None::<&str>)?;
    MenuBuilder::new(app)
        .item(&open)
        .separator()
        .item(&quit)
        .build()
}

fn handle_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "open" => show_main_window(app),
        "quit" => crate::request_host_exit(app.clone()),
        _ => {}
    }
}

pub(crate) fn hide_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_dock_visibility(false);
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
    }
}

pub(crate) fn show_main_window(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = app.set_dock_visibility(true);
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

pub(crate) fn setup(app: &AppHandle) -> Result<(), String> {
    let menu = build_menu(app).map_err(|error| error.to_string())?;
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))
        .map_err(|error| format!("无法读取托盘图标：{error}"))?;
    #[cfg(target_os = "macos")]
    let show_menu_on_left_click = true;
    #[cfg(not(target_os = "macos"))]
    let show_menu_on_left_click = false;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("Grox")
        .show_menu_on_left_click(show_menu_on_left_click)
        .on_menu_event(handle_menu_event)
        .on_tray_icon_event(|_tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            }
            | TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                #[cfg(not(target_os = "macos"))]
                show_main_window(_tray.app_handle());
            }
            _ => {}
        })
        .build(app)
        .map_err(|error| error.to_string())?;
    app.manage(Mutex::new(tray));
    Ok(())
}
