//! Finds the video on an embed page by opening it in a real browser window and noting what
//! the page's player loads. Pages here are hostile code: the window gets one permission,
//! `capture_report`, and nothing it sends is trusted. Choosing among the finds is the
//! frontend's job (src/lib/capture.ts).

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::webview::NewWindowResponse;
use tauri::{
    AppHandle, Emitter, Manager, State, Url, Webview, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

const EVENT: &str = "capture";
const HOOK: &str = include_str!("capture_hook.js");
const LABEL_PREFIX: &str = "capture-";
const MAX_ADDRESS: usize = 8192;
const MAX_TEXT: usize = 512;
/// A page reporting more than this is misbehaving, and the player's own load came long before.
const MAX_FINDS: usize = 200;

struct Session {
    id: String,
    /// A page opened from this machine may report this machine. Others may not.
    local_page: bool,
    /// Address and what's known about it, so only news gets through.
    seen: HashMap<String, (Option<u64>, Option<u32>)>,
}

#[derive(Default)]
pub struct Captures {
    sessions: Mutex<HashMap<String, Session>>,
    next: AtomicU64,
}

impl Captures {
    fn label_of(&self, id: &str) -> Option<String> {
        let sessions = self.sessions.lock().expect("capture list poisoned");
        sessions
            .iter()
            .find(|(_, session)| session.id == id)
            .map(|(label, _)| label.clone())
    }
}

/// What a page says it found. Every field is untrusted.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Report {
    url: String,
    via: String,
    content_type: Option<String>,
    duration: Option<f64>,
    width: Option<u32>,
    frame: String,
    user_agent: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Event {
    Found {
        id: String,
        url: String,
        via: String,
        content_type: Option<String>,
        duration: Option<f64>,
        width: Option<u32>,
        referer: String,
        user_agent: Option<String>,
    },
    Closed {
        id: String,
    },
}

/// Open the page. Finds arrive as `capture` events until `capture_close`.
#[tauri::command]
pub async fn capture_open(
    app: AppHandle,
    state: State<'_, Captures>,
    id: String,
    url: String,
    visible: bool,
) -> Result<(), String> {
    let page = web_address(&url).ok_or("Only http and https pages can be opened")?;
    let label = format!("{LABEL_PREFIX}{}", state.next.fetch_add(1, Ordering::Relaxed));
    state.sessions.lock().expect("capture list poisoned").insert(
        label.clone(),
        Session {
            id: id.clone(),
            local_page: is_private_host(&page),
            seen: HashMap::new(),
        },
    );

    let window = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(page))
        .title("strem-dl: press play to find the video")
        .inner_size(960.0, 600.0)
        .visible(visible)
        .incognito(true)
        .initialization_script_for_all_frames(HOOK)
        // Never `tauri:` or a file: those would give the page a trusted origin.
        .on_navigation(|url| matches!(url.scheme(), "http" | "https" | "about"))
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .build();
    let window = match window {
        Ok(window) => window,
        Err(error) => {
            state.sessions.lock().expect("capture list poisoned").remove(&label);
            return Err(error.to_string());
        }
    };

    let closed_app = app.clone();
    window.on_window_event(move |event| {
        if !matches!(event, WindowEvent::Destroyed) {
            return;
        }
        // Still listed means the person closed it, rather than `capture_close`.
        let state = closed_app.state::<Captures>();
        let session = state.sessions.lock().expect("capture list poisoned").remove(&label);
        if let Some(session) = session {
            let _ = closed_app.emit_to("main", EVENT, Event::Closed { id: session.id });
        }
    });
    Ok(())
}

/// Bring up a hidden capture window, for a person to press play.
#[tauri::command]
pub async fn capture_show(app: AppHandle, state: State<'_, Captures>, id: String) -> Result<(), String> {
    let window = state.label_of(&id).and_then(|label| app.get_webview_window(&label));
    if let Some(window) = window {
        window.show().map_err(|error| error.to_string())?;
        let _ = window.set_focus();
    }
    Ok(())
}

#[tauri::command]
pub async fn capture_close(app: AppHandle, state: State<'_, Captures>, id: String) -> Result<(), String> {
    let Some(label) = state.label_of(&id) else {
        return Ok(());
    };
    state.sessions.lock().expect("capture list poisoned").remove(&label);
    if let Some(window) = app.get_webview_window(&label) {
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// The one command a capture window may call.
#[tauri::command]
pub fn capture_report(app: AppHandle, webview: Webview, state: State<'_, Captures>, report: Report) {
    let event = {
        let mut sessions = state.sessions.lock().expect("capture list poisoned");
        // Asked of the window it came from, never of the page.
        match sessions.get_mut(webview.label()) {
            Some(session) => accept(session, report),
            None => None,
        }
    };
    if let Some(event) = event {
        // Only to the app's own window: other capture pages must not hear about it.
        let _ = app.emit_to("main", EVENT, event);
    }
}

/// Turn a report into an event, if it holds up and says something new.
fn accept(session: &mut Session, report: Report) -> Option<Event> {
    if report.url.len() > MAX_ADDRESS || report.frame.len() > MAX_ADDRESS {
        return None;
    }
    let url = web_address(&report.url)?;
    let frame = web_address(&report.frame)?;
    if !session.local_page && is_private_host(&url) {
        return None;
    }

    let duration = report.duration.filter(|value| value.is_finite() && *value > 0.0);
    let news = (duration.map(|value| value as u64), report.width);
    match session.seen.get(url.as_str()) {
        Some(known) if *known == news => return None,
        None if session.seen.len() >= MAX_FINDS => return None,
        _ => {}
    }
    session.seen.insert(url.to_string(), news);

    Some(Event::Found {
        id: session.id.clone(),
        url: url.to_string(),
        via: clean_text(&report.via)?,
        content_type: report.content_type.as_deref().and_then(clean_text),
        duration,
        width: report.width,
        referer: frame.to_string(),
        user_agent: report.user_agent.as_deref().and_then(clean_text),
    })
}

fn web_address(text: &str) -> Option<Url> {
    if text.chars().any(char::is_control) {
        return None;
    }
    Url::parse(text)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https") && url.host().is_some())
}

/// Text that ends up in a request header: a line break there would add headers of the page's choosing.
fn clean_text(text: &str) -> Option<String> {
    let good = text.len() <= MAX_TEXT && !text.is_empty() && !text.chars().any(char::is_control);
    good.then(|| text.to_string())
}

/// So a page can't point the app's downloader at this machine or its network.
fn is_private_host(url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return true;
    };
    let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.');
    if host.eq_ignore_ascii_case("localhost") || host.to_ascii_lowercase().ends_with(".localhost") {
        return true;
    }
    let is_private = |address: IpAddr| match address {
        IpAddr::V4(ip) => {
            ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || ip.is_broadcast()
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            let mapped = ip.to_ipv4_mapped().is_some_and(|mapped| {
                mapped.is_loopback() || mapped.is_private() || mapped.is_link_local() || mapped.is_unspecified()
            });
            ip.is_loopback() || ip.is_unspecified() || mapped || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
        }
    };
    host.parse().is_ok_and(is_private)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session {
            id: "link".into(),
            local_page: false,
            seen: HashMap::new(),
        }
    }

    fn report(url: &str) -> Report {
        Report {
            url: url.into(),
            via: "xhr".into(),
            content_type: Some("application/vnd.apple.mpegurl".into()),
            duration: None,
            width: None,
            frame: "https://host.example/e/1".into(),
            user_agent: Some("Mozilla/5.0".into()),
        }
    }

    #[test]
    fn passes_on_a_find_with_the_frame_as_referer() {
        let event = accept(&mut session(), report("https://cdn.example/master.m3u8")).unwrap();
        let Event::Found { id, url, referer, user_agent, .. } = event else {
            panic!("expected a find");
        };
        assert_eq!(id, "link");
        assert_eq!(url, "https://cdn.example/master.m3u8");
        assert_eq!(referer, "https://host.example/e/1");
        assert_eq!(user_agent.as_deref(), Some("Mozilla/5.0"));
    }

    #[test]
    fn refuses_anything_but_web_addresses() {
        for bad in [
            "file:///etc/passwd",
            "tauri://localhost/",
            "javascript:alert(1)",
            "data:video/mp4;base64,AA",
            "blob:https://a.example/1",
            "not an address",
        ] {
            assert_eq!(accept(&mut session(), report(bad)), None, "{bad}");
        }
    }

    #[test]
    fn refuses_a_frame_that_is_not_a_web_address() {
        let mut bad = report("https://cdn.example/a.m3u8");
        bad.frame = "file:///etc/passwd".into();
        assert_eq!(accept(&mut session(), bad), None);
    }

    #[test]
    fn line_breaks_cannot_reach_a_header() {
        let mut bad = report("https://cdn.example/a.m3u8");
        bad.frame = "https://host.example/\r\nX-Evil: 1".into();
        assert_eq!(accept(&mut session(), bad), None);

        let mut agent = report("https://cdn.example/a.m3u8");
        agent.user_agent = Some("Mozilla\r\nX-Evil: 1".into());
        let Some(Event::Found { user_agent, .. }) = accept(&mut session(), agent) else {
            panic!("expected a find");
        };
        assert_eq!(user_agent, None);
    }

    #[test]
    fn refuses_oversized_addresses() {
        let long = format!("https://cdn.example/{}", "a".repeat(MAX_ADDRESS));
        assert_eq!(accept(&mut session(), report(&long)), None);
    }

    #[test]
    fn a_remote_page_cannot_report_this_machine_or_its_network() {
        for private in [
            "http://localhost:8080/a.m3u8",
            "http://app.localhost/a.m3u8",
            "http://127.0.0.1/a.m3u8",
            "http://10.0.0.8/a.m3u8",
            "http://192.168.1.1/a.m3u8",
            "http://172.16.0.1/a.m3u8",
            "http://169.254.169.254/latest",
            "http://0.0.0.0/a.m3u8",
            "http://[::1]/a.m3u8",
            "http://[::ffff:127.0.0.1]/a.m3u8",
            "http://[fd00::1]/a.m3u8",
            "http://[fe80::1]/a.m3u8",
        ] {
            assert_eq!(accept(&mut session(), report(private)), None, "{private}");
        }
    }

    #[test]
    fn a_local_page_may_report_local_addresses() {
        let mut local = session();
        local.local_page = true;
        assert!(accept(&mut local, report("http://127.0.0.1:4599/a.m3u8")).is_some());
    }

    #[test]
    fn repeats_only_when_there_is_news() {
        let mut session = session();
        let address = "https://cdn.example/a";
        assert!(accept(&mut session, report(address)).is_some());
        assert_eq!(accept(&mut session, report(address)), None);

        let mut longer = report(address);
        longer.duration = Some(5890.2);
        longer.width = Some(1280);
        assert!(accept(&mut session, longer).is_some());
    }

    #[test]
    fn ignores_durations_that_mean_nothing() {
        let mut odd = report("https://cdn.example/a");
        odd.duration = Some(f64::INFINITY);
        let Some(Event::Found { duration, .. }) = accept(&mut session(), odd) else {
            panic!("expected a find");
        };
        assert_eq!(duration, None);
    }

    #[test]
    fn stops_listening_to_a_page_that_reports_too_much() {
        let mut session = session();
        for n in 0..MAX_FINDS {
            assert!(accept(&mut session, report(&format!("https://cdn.example/{n}"))).is_some());
        }
        assert_eq!(accept(&mut session, report("https://cdn.example/one-more")), None);
        // What it already reported can still gain details.
        let mut known = report("https://cdn.example/0");
        known.duration = Some(10.0);
        assert!(accept(&mut session, known).is_some());
    }
}
