// Reel backend — startup
#![allow(unused_imports)]
use crate::*;

#[cfg(windows)]
pub(crate) fn show_startup_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;

    fn wide(text: &str) -> Vec<u16> {
        std::ffi::OsStr::new(text)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            utype: u32,
        ) -> i32;
    }

    let busy = message.contains("0x800700AA")
        || message.contains("800700AA")
        || message.to_lowercase().contains("занят");
    let hint = if busy {
        "Похоже, Reel уже запущен — проверь значок в трее. \
         Если окна нет, закрой все копии Reel через диспетчер задач и запусти снова. \
         Если не помогло — у программы нет доступа на запись к %APPDATA% (папка с exe \
         может быть в песочнице с ограниченными правами)."
    } else {
        "Подробности записаны в журнал: Настройки → «Открыть логи»."
    };
    let text = format!("Reel не смог запуститься.\n\n{message}\n\n{hint}");
    let text = wide(&text);
    let caption = wide("Reel");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            0x0000_0010 | 0x0004_0000,
        );
    }
}

#[cfg(not(windows))]
pub(crate) fn show_startup_error(message: &str) {
    eprintln!("Reel failed to start: {message}");
}
