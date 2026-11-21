//! Runs the unit tests of src-tauri/legacy/windows_source_guard.rs (owned by
//! Opus, called from the migration exporter) on any platform, and compiles its
//! Windows system calls for the Windows target.
#[path = "../../src-tauri/legacy/windows_source_guard.rs"]
#[allow(dead_code, unused_imports)]
mod guard;

/// Windows CI only (not run on the development Mac): the system path end to end.
#[cfg(windows)]
mod system {
    use super::guard;
    use windows::{core::PCWSTR, Win32::{Foundation::CloseHandle, System::Threading::CreateMutexW}};

    /// The guard's mutexes, window classes and windows belong to the whole
    /// process, and the exporter acquires them once per process. Each case
    /// therefore runs in a fresh process of this test binary, so no case sees
    /// state another case left registered. The case's own assertions run
    /// unchanged in that child; any child failure fails the case here.
    ///
    /// The single-instance mutexes and the `FindWindowW` lookups are shared by
    /// the whole session, so the children also run one at a time whatever the
    /// harness thread count (`cargo test` from the repository root runs this
    /// binary in parallel).
    fn in_own_process(name: &str, case: impl FnOnce()) {
        const CASE: &str = "TAROBOT_SOURCE_GUARD_CASE";
        static ONE_CHILD_AT_A_TIME: std::sync::Mutex<()> = std::sync::Mutex::new(());
        if std::env::var_os(CASE).is_some_and(|value| value == name) { return case(); }
        let output = {
            // Released before any assertion below, so a failed case cannot poison it.
            let _serial = ONE_CHILD_AT_A_TIME.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--exact", &format!("system::{name}"), "--test-threads=1", "--nocapture"])
                .env(CASE, name).output().unwrap()
        };
        let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
        // Indented on stderr: a harness counting `test result:` lines on stdout
        // must see only this binary's own result.
        for line in text.lines() { eprintln!("    [own process] {line}"); }
        assert!(output.status.success(), "system::{name} failed in its own process");
        assert!(text.contains("test result: ok. 1 passed;"), "system::{name} did not run in its own process");
    }

    /// Declares a case that runs in its own process under its own function
    /// name, so a case can never run another case's body in its place.
    macro_rules! own_process_test {
        ($(#[$meta:meta])* fn $name:ident() $body:block) => {
            $(#[$meta])*
            #[test]
            fn $name() { in_own_process(stringify!($name), || $body); }
        };
    }

    own_process_test! {
        /// A test runner is not started by Electron main: refused, nothing held.
        fn a_process_not_started_by_electron_main_is_refused() {
            assert_eq!(guard::acquire().err(), Some(guard::PARENT_UNKNOWN));
        }
    }

    own_process_test! {
        /// A late old App does exactly this (tauri-plugin-single-instance 2.4.4):
        /// find `<id>-sic`/`<id>-siw`, send WM_COPYDATA, then exit. Bounded here so
        /// a broken message pump fails the test instead of hanging it.
        fn a_late_old_app_finds_the_guard_window_and_its_forward_is_acknowledged() {
            use windows::Win32::{Foundation::{LPARAM, WPARAM}, System::DataExchange::COPYDATASTRUCT,
                UI::WindowsAndMessaging::{FindWindowW, SendMessageTimeoutW, SMTO_NORMAL, WM_COPYDATA}};
            let wide = |value: String| value.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
            let windows = guard::forwarding_windows().expect("guard windows");
            for id in guard::IDENTIFIERS {
                let (class, title) = (wide(format!("{id}-sic")), wide(format!("{id}-siw")));
                let window = unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(title.as_ptr())) }.expect("an old App would find it");
                let data = b"C:\\|C:\\TaroBot\\tarocub-client.exe|tarocub://conversation/x\0";
                let copy = COPYDATASTRUCT { dwData: 1542, cbData: data.len() as u32, lpData: data.as_ptr() as _ };
                let mut result = 0usize;
                let sent = unsafe { SendMessageTimeoutW(window, WM_COPYDATA, WPARAM(0), LPARAM(&copy as *const _ as isize), SMTO_NORMAL, 5000, Some(&mut result)) };
                assert_ne!(sent.0, 0, "forward must be answered promptly");
                assert_eq!(result, 1);
            }
            drop(windows);
            // After the export the windows are gone and an old App runs normally.
            let (class, title) = (wide("com.tarobot.client-sic".into()), wide("com.tarobot.client-siw".into()));
            assert!(unsafe { FindWindowW(PCWSTR(class.as_ptr()), PCWSTR(title.as_ptr())) }.is_err());
        }
    }

    own_process_test! {
        /// An old Tauri App holds its single-instance mutex from setup onwards.
        fn a_running_old_tauri_app_is_detected_by_its_single_instance_mutex() {
            let name: Vec<u16> = "com.tarobot.client-sim".encode_utf16().chain(Some(0)).collect();
            let held = unsafe { CreateMutexW(None, true, PCWSTR(name.as_ptr())) }.unwrap();
            let result = guard::acquire().err();
            unsafe { let _ = CloseHandle(held); }
            assert_eq!(result, Some(guard::IN_USE));
        }
    }
}
