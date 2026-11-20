//! Remote screen: Windows system input, monitor bounds, session state and the
//! local-takeover monitor. Runs inside the App's main process, at the App's own
//! integrity level: nothing here elevates, switches desktop or installs anything.
//!
//! Everything sent to `SendInput` is first built as plain values (`Input`), and
//! every decision (what is held, whether the session may be controlled, whether
//! the hooks still see input) is a function of plain values. Tests read those
//! back and replay partial insertion on any host; nothing in a test posts input.
use std::collections::{BTreeSet, VecDeque};
use std::sync::{atomic::{AtomicBool, AtomicU64, Ordering}, Arc, Mutex};

/// `winuser.h` values, repeated so the pure half builds without the `windows`
/// crate. `os` asserts at compile time that they equal the crate's constants.
pub mod flag {
    pub const KEY_EXTENDED: u32 = 0x0001; pub const KEY_UP: u32 = 0x0002; pub const KEY_UNICODE: u32 = 0x0004; pub const KEY_SCANCODE: u32 = 0x0008;
    pub const MOVE: u32 = 0x0001; pub const LEFT_DOWN: u32 = 0x0002; pub const LEFT_UP: u32 = 0x0004; pub const RIGHT_DOWN: u32 = 0x0008; pub const RIGHT_UP: u32 = 0x0010;
    pub const MIDDLE_DOWN: u32 = 0x0020; pub const MIDDLE_UP: u32 = 0x0040; pub const WHEEL: u32 = 0x0800; pub const HWHEEL: u32 = 0x1000;
    pub const VIRTUAL_DESK: u32 = 0x4000; pub const ABSOLUTE: u32 = 0x8000;
}
/// Bit of a key descriptor that marks an extended (E0) key; the low byte is the Set 1 scan code.
pub const EXTENDED: u16 = 0x100;
const MODIFIER_KEYS: [u16; 8] = [0x2a, 0x36, 0x1d, EXTENDED | 0x1d, 0x38, EXTENDED | 0x38, EXTENDED | 0x5b, EXTENDED | 0x5c];
const SCAN_ENTER: u16 = 0x1c;
const SCAN_TAB: u16 = 0x0f;
const MAX_TEXT_UNITS: usize = 2048;
/// Most inputs handed to one `SendInput` call when typing text.
pub const TEXT_BATCH: usize = 64;
pub const WHEEL_MAX: i32 = 2400;
/// A hook thread that has not turned its loop for this long may have missed
/// input: Windows drops a low-level hook call that is not answered in time
/// (300 ms by default) and silently removes a hook that keeps timing out.
pub const HOOK_GAP_MS: u64 = 250;
/// How long the hooks get to report an inserted event before it counts as unseen.
pub const HOOK_SETTLE_MS: u64 = 300;

/// One `INPUT`, without the per-process tag that `os` stamps on every event.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Input {
    /// Always by scan code or Unicode unit: `vk` is 0 in everything this backend builds.
    Key { vk: u16, scan: u16, flags: u32 },
    Mouse { dx: i32, dy: i32, data: i32, flags: u32 },
}
impl Input {
    fn is_key(&self) -> bool { matches!(self, Input::Key { .. }) }
    /// A press of something: these are refused while the foreground window would not receive them.
    fn is_down(&self) -> bool {
        match *self {
            Input::Key { flags, .. } => flags & flag::KEY_UP == 0,
            Input::Mouse { flags, .. } => flags & (flag::LEFT_DOWN | flag::RIGHT_DOWN | flag::MIDDLE_DOWN) != 0,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Button { Left, Right, Other }
impl Button {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value { "left" => Ok(Self::Left), "right" => Ok(Self::Right), "other" => Ok(Self::Other), _ => Err("screen_input_invalid".into()) }
    }
    pub fn name(self) -> &'static str { match self { Self::Left => "left", Self::Right => "right", Self::Other => "other" } }
    fn down(self) -> u32 { match self { Self::Left => flag::LEFT_DOWN, Self::Right => flag::RIGHT_DOWN, Self::Other => flag::MIDDLE_DOWN } }
    fn up(self) -> u32 { match self { Self::Left => flag::LEFT_UP, Self::Right => flag::RIGHT_UP, Self::Other => flag::MIDDLE_UP } }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mouse { Move, Drag, Down, Up }
impl Mouse {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value { "move" => Ok(Self::Move), "drag" => Ok(Self::Drag), "down" => Ok(Self::Down), "up" => Ok(Self::Up), _ => Err("screen_input_invalid".into()) }
    }
}
/// Physical pixels. `x`/`y` are negative for a monitor left of or above the primary one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect { pub x: i32, pub y: i32, pub width: i32, pub height: i32 }

fn key(descriptor: u16, down: bool) -> Result<Input, String> {
    let scan = descriptor & 0xff;
    if descriptor & !(EXTENDED | 0xff) != 0 || scan == 0 || scan > 0x7f { return Err("screen_input_invalid".into()); }
    let flags = flag::KEY_SCANCODE | if descriptor & EXTENDED != 0 { flag::KEY_EXTENDED } else { 0 } | if down { 0 } else { flag::KEY_UP };
    Ok(Input::Key { vk: 0, scan, flags })
}
/// One physical key by position. `modifier` must say what the key is, as on
/// macOS; a repeat is simply another down, which is what a held key sends.
pub fn key_inputs(descriptor: u16, down: bool, modifier: bool) -> Result<Vec<Input>, String> {
    if modifier != MODIFIER_KEYS.contains(&descriptor) { return Err("screen_input_invalid".into()); }
    Ok(vec![key(descriptor, down)?])
}
/// Committed text as Unicode key events, one down and one up per UTF-16 unit in
/// order (a surrogate pair is two units, high first). No clipboard. Line breaks
/// and tabs are the Enter and Tab keys, which every program accepts.
pub fn text_inputs(text: &str) -> Result<Vec<Input>, String> {
    let units = text.encode_utf16().count();
    if units == 0 || units > MAX_TEXT_UNITS || text.chars().any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t')) { return Err("screen_input_invalid".into()); }
    let mut inputs = Vec::with_capacity(units * 2);
    for c in text.replace("\r\n", "\n").replace('\r', "\n").chars() {
        match c {
            '\n' | '\t' => { let scan = if c == '\n' { SCAN_ENTER } else { SCAN_TAB }; inputs.push(key(scan, true)?); inputs.push(key(scan, false)?); }
            _ => { let mut buffer = [0u16; 2];
                for unit in c.encode_utf16(&mut buffer).iter() {
                    inputs.push(Input::Key { vk: 0, scan: *unit, flags: flag::KEY_UNICODE });
                    inputs.push(Input::Key { vk: 0, scan: *unit, flags: flag::KEY_UNICODE | flag::KEY_UP });
                } }
        }
    }
    Ok(inputs)
}
/// `inputs` (from `text_inputs`) split for separate `SendInput` calls, never
/// inside a down/up pair, so a refused call leaves at most one unit pressed.
pub fn text_batches(inputs: &[Input]) -> impl Iterator<Item = &[Input]> { inputs.chunks(TEXT_BATCH - TEXT_BATCH % 2) }

/// Where `point` is on the virtual desktop in the 0..65535 units of an absolute
/// move. Windows turns units back into pixels as `(units * size) >> 16`, so the
/// middle of the pixel's range is the value that cannot land on a neighbour.
pub fn absolute(point: (i32, i32), desktop: Rect) -> Result<(i32, i32), String> {
    let (x, y) = (point.0 as i64 - desktop.x as i64, point.1 as i64 - desktop.y as i64);
    if desktop.width < 1 || desktop.height < 1 || desktop.width > 65536 || desktop.height > 65536 || x < 0 || y < 0 || x >= desktop.width as i64 || y >= desktop.height as i64 {
        return Err("screen_point_out_of_bounds".into());
    }
    Ok((((2 * x + 1) * 32768 / desktop.width as i64) as i32, ((2 * y + 1) * 32768 / desktop.height as i64) as i32))
}
fn movement(point: (i32, i32), desktop: Rect) -> Result<Input, String> {
    let (dx, dy) = absolute(point, desktop)?;
    Ok(Input::Mouse { dx, dy, data: 0, flags: flag::MOVE | flag::ABSOLUTE | flag::VIRTUAL_DESK })
}
/// A pointer event at `point`. A button event is the move followed by the
/// button, in one call. `button` is a PHYSICAL button: the caller has already
/// decided which one (`physical_button`) and recorded it, so nothing here
/// looks at the swap setting again. `clicks` is checked and otherwise unused:
/// Windows makes a double click out of the timing of two real presses, never
/// out of a count.
pub fn mouse_inputs(action: Mouse, button: Button, point: (i32, i32), desktop: Rect, clicks: i64) -> Result<Vec<Input>, String> {
    if !(1..=3).contains(&clicks) { return Err("screen_input_invalid".into()); }
    let mut inputs = vec![movement(point, desktop)?];
    match action {
        Mouse::Move | Mouse::Drag => {}
        Mouse::Down => inputs.push(Input::Mouse { dx: 0, dy: 0, data: 0, flags: button.down() }),
        Mouse::Up => inputs.push(Input::Mouse { dx: 0, dy: 0, data: 0, flags: button.up() }),
    }
    Ok(inputs)
}
/// Wheel amounts in `WHEEL_DELTA` units at `point`: `vertical` > 0 turns the
/// wheel away from the user (content up), `horizontal` > 0 to the right.
pub fn wheel_inputs(point: (i32, i32), desktop: Rect, vertical: i32, horizontal: i32) -> Result<Vec<Input>, String> {
    if vertical.abs() > WHEEL_MAX || horizontal.abs() > WHEEL_MAX { return Err("screen_input_invalid".into()); }
    if vertical == 0 && horizontal == 0 { return Ok(Vec::new()); }
    let mut inputs = vec![movement(point, desktop)?];
    if vertical != 0 { inputs.push(Input::Mouse { dx: 0, dy: 0, data: vertical, flags: flag::WHEEL }); }
    if horizontal != 0 { inputs.push(Input::Mouse { dx: 0, dy: 0, data: horizontal, flags: flag::HWHEEL }); }
    Ok(inputs)
}

/// What this process has pressed and Windows has taken, and not yet released.
/// Independent of the lease tracking in JS, and changed only by what
/// `SendInput` reports as inserted.
#[derive(Default, Debug, Clone, PartialEq, Eq)]
pub struct Held { keys: BTreeSet<u16>, units: BTreeSet<u16>, buttons: BTreeSet<Button> }
impl Held {
    pub const fn new() -> Self { Self { keys: BTreeSet::new(), units: BTreeSet::new(), buttons: BTreeSet::new() } }
    pub fn len(&self) -> usize { self.keys.len() + self.units.len() + self.buttons.len() }
    pub fn is_empty(&self) -> bool { self.len() == 0 }
    fn apply(&mut self, input: &Input) {
        match *input {
            Input::Key { vk: 0, scan, flags } => {
                let down = flags & flag::KEY_UP == 0;
                if flags & flag::KEY_UNICODE != 0 { if down { self.units.insert(scan); } else { self.units.remove(&scan); } }
                else { let descriptor = scan | if flags & flag::KEY_EXTENDED != 0 { EXTENDED } else { 0 };
                    if down { self.keys.insert(descriptor); } else { self.keys.remove(&descriptor); } }
            }
            Input::Key { .. } => {}
            Input::Mouse { flags, .. } => for button in [Button::Left, Button::Right, Button::Other] {
                if flags & button.down() != 0 { self.buttons.insert(button); }
                if flags & button.up() != 0 { self.buttons.remove(&button); }
            },
        }
    }
    /// Ups for what is held now and was not in `before`: the Unicode units
    /// AND the real keys (Enter, Tab) a text call pressed. What the lease
    /// already held before that call is not touched.
    fn releases_since(&self, before: &Held) -> Vec<Input> {
        let mut inputs: Vec<Input> = self.units.difference(&before.units).map(|unit| Input::Key { vk: 0, scan: *unit, flags: flag::KEY_UNICODE | flag::KEY_UP }).collect();
        inputs.extend(self.keys.difference(&before.keys).filter_map(|descriptor| key(*descriptor, false).ok()));
        inputs
    }
    /// Ups for everything held: ordinary keys and text units first, then
    /// modifiers, then buttons. A button is lifted where the pointer is now:
    /// nothing moves the pointer of the person at the computer back.
    fn releases(&self) -> Vec<Input> {
        let mut inputs: Vec<Input> = self.units.iter().map(|unit| Input::Key { vk: 0, scan: *unit, flags: flag::KEY_UNICODE | flag::KEY_UP }).collect();
        for modifier in [false, true] {
            for descriptor in self.keys.iter().filter(|descriptor| MODIFIER_KEYS.contains(descriptor) == modifier) {
                if let Ok(up) = key(*descriptor, false) { inputs.push(up); }
            }
        }
        for button in &self.buttons { inputs.push(Input::Mouse { dx: 0, dy: 0, data: 0, flags: button.up() }); }
        inputs
    }
}

/// Whether `inputs` may be posted now. `controllable` is the session check made
/// immediately before posting. `foreground_higher` is whether the foreground
/// window runs at a higher integrity level than this process: `Some(false)`
/// when it does not (or there is no foreground window), `None` when that could
/// not be read. Windows gives such a window none of this process's input and
/// reports nothing, so a press is refused unless the answer is a known "no".
/// Releases are never refused for that reason: an up that is dropped is harmless.
pub fn admit(inputs: &[Input], controllable: bool, foreground_higher: Option<bool>) -> Result<(), String> {
    if !controllable { return Err("screen_locked".into()); }
    if inputs.iter().any(Input::is_down) && foreground_higher != Some(false) { return Err("screen_input_blocked".into()); }
    Ok(())
}
/// Whether crash recovery may read key state now. `GetAsyncKeyState` reports
/// zero while UI Privilege Isolation keeps this process from the foreground
/// thread, so with a higher-integrity window in front (or no answer) every
/// recorded key would read as up and the record would be deleted while a key
/// may still be down. Recovery then waits, keeping the record, and is retried.
pub fn recovery_readable(controllable: bool, foreground_higher: Option<bool>) -> Result<(), String> {
    if !controllable || foreground_higher != Some(false) { return Err("screen_release_pending".into()); }
    Ok(())
}
/// Posts `inputs` and records exactly what Windows took. `post` returns
/// `SendInput`'s count: how many leading inputs were inserted. Fewer than asked
/// is a failure and is never retried here: the caller ends the lease, and
/// `release_all_with` lifts whatever the inserted part pressed.
pub fn submit_with(held: &mut Held, inputs: &[Input], watch: Option<&MonitorState>, now_ms: u64, post: &mut dyn FnMut(&[Input]) -> usize) -> Result<(), String> {
    if inputs.is_empty() { return Ok(()); }
    let inserted = post(inputs).min(inputs.len());
    for input in &inputs[..inserted] { held.apply(input); }
    if let Some(state) = watch { state.sent(&inputs[..inserted], now_ms); }
    if inserted == inputs.len() { Ok(()) } else { Err("screen_input_blocked".into()) }
}
/// After a text call Windows took only part of: lifts what that call pressed
/// and did not release, a Unicode unit or a real Enter or Tab, inside the same
/// native call that saw the failure. `before` is what was held when the text
/// call began. What Windows refuses even now stays recorded for the general
/// release.
pub fn release_since_with(held: &mut Held, before: &Held, watch: Option<&MonitorState>, now_ms: u64, post: &mut dyn FnMut(&[Input]) -> usize) -> Result<u32, String> {
    release_with(held, held.releases_since(before), watch, now_ms, post)
}
/// Releases everything held. What Windows does not take stays recorded as
/// held, and the call fails, so the same ups are tried again later.
pub fn release_all_with(held: &mut Held, watch: Option<&MonitorState>, now_ms: u64, post: &mut dyn FnMut(&[Input]) -> usize) -> Result<u32, String> {
    release_with(held, held.releases(), watch, now_ms, post)
}
fn release_with(held: &mut Held, ups: Vec<Input>, watch: Option<&MonitorState>, now_ms: u64, post: &mut dyn FnMut(&[Input]) -> usize) -> Result<u32, String> {
    if ups.is_empty() { return Ok(0); }
    let inserted = post(&ups).min(ups.len());
    for input in &ups[..inserted] { held.apply(input); }
    if let Some(state) = watch { state.sent(&ups[..inserted], now_ms); }
    if inserted == ups.len() { Ok(inserted as u32) } else { Err("screen_release_pending".into()) }
}

/// Buttons arrive by meaning: `Left` is the main button of the person
/// controlling, `Right` the secondary one. Windows applies its own left/right
/// swap to posted buttons exactly as to a real mouse, so on a computer set up
/// for the left hand the main button is the physical right one.
pub fn physical_button(button: Button, swapped: bool) -> Button {
    match (button, swapped) { (Button::Left, true) => Button::Right, (Button::Right, true) => Button::Left, (button, _) => button }
}
/// After the App died during control. `keys` (descriptors) and `buttons`
/// (PHYSICAL buttons, exactly the ones that were pressed) are what the dead
/// process wrote to disk BEFORE it pressed them, so they are the only inputs
/// remote control can have left down. Nothing else on the keyboard or mouse is
/// examined: not the other mouse button, whatever the swap setting is now. Of
/// the recorded ones, only what Windows still reports as down is lifted: an up
/// for a button that is not down would, for the secondary button, open a menu.
/// If the person at the computer holds one of these very keys at that moment,
/// it is lifted too; that cannot be told apart.
pub fn candidate_releases(keys: &[u16], buttons: &[Button], key_down: &dyn Fn(u16) -> bool, button_down: &dyn Fn(Button) -> bool) -> Result<Vec<Input>, String> {
    if keys.len() > 256 || buttons.len() > 16 { return Err("screen_input_invalid".into()); }
    let keys: BTreeSet<u16> = keys.iter().copied().collect();
    let mut ups = Vec::new();
    for modifier in [false, true] {
        for descriptor in keys.iter().filter(|descriptor| MODIFIER_KEYS.contains(descriptor) == modifier) {
            let up = key(*descriptor, false)?;
            if key_down(*descriptor) { ups.push(up); }
        }
    }
    for button in buttons.iter().copied().collect::<BTreeSet<Button>>() { if button_down(button) { ups.push(Input::Mouse { dx: 0, dy: 0, data: 0, flags: button.up() }); } }
    Ok(ups)
}

// ---------------- session ----------------
/// What Windows said about this process's session. `None` is a read that failed.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionFacts {
    pub session: Option<u32>,
    /// `WTS_CONNECTSTATE_CLASS` of this session; 0 is `WTSActive`.
    pub connect_state: Option<i32>,
    /// `WTSINFOEX_LEVEL1.SessionFlags`: 0 locked, 1 unlocked, anything else unknown.
    pub lock: Option<i32>,
    pub logon_time: Option<i64>,
    /// The token's logon session (`TOKEN_STATISTICS.AuthenticationId`): low, high.
    pub logon: Option<(u32, i32)>,
    pub station: Option<String>,
    pub own_desktop: Option<String>,
    /// The desktop that receives input now, if this process may open it at all.
    pub input_desktop: Option<String>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session { pub available: bool, pub on_console: bool, pub locked: bool, pub unique: Option<String> }
impl Session { pub fn controllable(&self) -> bool { self.available && self.on_console && !self.locked } }
const WTS_ACTIVE: i32 = 0;
const WTS_UNLOCKED: i32 = 1;
/// Anything not positively known counts against control. `on_console` here
/// means: an interactive window station, a connected session, and the desktop
/// receiving input is the one this process runs on (not the lock screen, a
/// consent prompt or another desktop). A console session and an active remote
/// one are not told apart. `unique` names the login without any account name.
pub fn classify(facts: &SessionFacts) -> Session {
    let unique = match (facts.session, facts.logon, facts.logon_time) {
        (Some(session), Some((low, high)), Some(time)) if session != 0 => Some(format!("{session:x}-{:08x}{low:08x}-{:x}", high as u32, time as u64)),
        _ => None,
    };
    let available = unique.is_some() && facts.connect_state.is_some() && facts.lock.is_some() && facts.station.is_some() && facts.own_desktop.is_some();
    let on_console = available && facts.connect_state == Some(WTS_ACTIVE)
        && facts.station.as_deref().is_some_and(|name| name.eq_ignore_ascii_case("WinSta0"))
        && matches!((&facts.own_desktop, &facts.input_desktop), (Some(own), Some(input)) if !own.is_empty() && own.eq_ignore_ascii_case(input));
    Session { available, on_console, locked: facts.lock != Some(WTS_UNLOCKED), unique: if available { unique } else { None } }
}

// ---------------- local input monitor (keyboard + mouse takeover) ----------------
// Low-level keyboard and mouse hooks on a thread of their own, installed only
// while a control lease is live. The callbacks only COUNT events: ours (injected
// and carrying this process's tag) and everything else, which is the person at
// the computer or another program. No key code, character or position is read,
// kept or reported.

/// Events of one kind (keyboard or mouse) this process inserted, with the time
/// of insertion kept until the hook of that kind has seen them. The time that
/// matters is that of the OLDEST unseen event: later inserts never move it.
#[derive(Default)]
struct Outstanding { total: u64, marks: VecDeque<(u64, u64)> }
const OUTSTANDING_MARKS: usize = 64;
impl Outstanding {
    fn add(&mut self, count: u64, now_ms: u64) {
        if count == 0 { return; }
        self.total += count;
        // Full: fold into the newest mark, which keeps its (older) time. Never later than the truth.
        if self.marks.len() == OUTSTANDING_MARKS { if let Some(newest) = self.marks.back_mut() { newest.0 = self.total; return; } }
        self.marks.push_back((self.total, now_ms));
    }
    /// When the oldest event the hook has not seen was inserted, given how many it has seen.
    fn oldest_unseen(&mut self, seen: u64) -> Option<u64> {
        while self.marks.front().is_some_and(|mark| mark.0 <= seen) { self.marks.pop_front(); }
        self.marks.front().map(|mark| mark.1)
    }
}
/// One monitor generation. A hook thread only touches the state it was started
/// with, so an old thread that is still exiting cannot write into a new one.
#[derive(Default)]
pub struct MonitorState {
    cancelled: AtomicBool, alive: AtomicBool, failed: AtomicBool, exited: AtomicBool,
    foreign: AtomicU64, interrupted: AtomicU64,
    /// Tagged events the hooks saw. The hooks touch nothing but these counters.
    own_keys: AtomicU64, own_mouse: AtomicU64, turned_ms: AtomicU64,
    /// What `SendInput` took while alive: keyboard, mouse. Only the posting thread and the poll lock it.
    outstanding: Mutex<[Outstanding; 2]>,
}
impl MonitorState {
    /// Called for a generation that was alive before the post, so its hooks were there to see it.
    fn sent(&self, inserted: &[Input], now_ms: u64) {
        if inserted.is_empty() { return; }
        let keys = inserted.iter().filter(|input| input.is_key()).count() as u64;
        if let Ok(mut outstanding) = self.outstanding.lock() { outstanding[0].add(keys, now_ms); outstanding[1].add(inserted.len() as u64 - keys, now_ms); }
    }
    #[cfg(test)]
    fn sent_totals(&self) -> (u64, u64) { let outstanding = self.outstanding.lock().unwrap(); (outstanding[0].total, outstanding[1].total) }
    /// The hook thread turned its loop.
    pub fn turned(&self, now_ms: u64) {
        let last = self.turned_ms.swap(now_ms, Ordering::AcqRel);
        if last != 0 && now_ms.saturating_sub(last) > HOOK_GAP_MS { self.interrupted.fetch_add(1, Ordering::Relaxed); }
    }
    /// One event seen by a hook.
    pub fn saw(&self, keyboard: bool, verdict: HookVerdict) {
        match (verdict, keyboard) {
            (HookVerdict::Foreign, _) => { self.foreign.fetch_add(1, Ordering::Relaxed); }
            (HookVerdict::Own, true) => { self.own_keys.fetch_add(1, Ordering::AcqRel); }
            (HookVerdict::Own, false) => { self.own_mouse.fetch_add(1, Ordering::AcqRel); }
        }
    }
    fn seen(&self) -> (u64, u64) { (self.own_keys.load(Ordering::Acquire), self.own_mouse.load(Ordering::Acquire)) }
    /// Signs that the hooks no longer see input. Windows removes a hook that
    /// timed out without telling anyone, so a running thread proves nothing.
    /// Two signs are used: the thread's loop stopped turning for more than
    /// `HOOK_GAP_MS`, or an event this process inserted has not been seen by
    /// the hook of its kind `HOOK_SETTLE_MS` after it was inserted. The clock
    /// of the second sign is the oldest unseen event's, per kind: more input,
    /// of the same kind or the other, never postpones it. Neither sign is a
    /// guarantee. A hook lost while this process inserts nothing of that kind
    /// and the thread keeps turning is not noticed until the next insert. A
    /// loaded computer can exceed either limit with healthy hooks, which ends
    /// the lease for no real reason. Both limits are untested on a real desktop.
    fn blind(&self, now_ms: u64) -> bool {
        let turned = self.turned_ms.load(Ordering::Acquire);
        if now_ms.saturating_sub(turned) > HOOK_GAP_MS { return true; }
        // Fewer seen than inserted. More seen than counted here (input this
        // process posted outside a lease) proves nothing either way.
        let (keys, mouse) = self.seen();
        let Ok(mut outstanding) = self.outstanding.lock() else { return true };
        [keys, mouse].into_iter().zip(outstanding.iter_mut()).any(|(seen, kind)| kind.oldest_unseen(seen).is_some_and(|since| now_ms.saturating_sub(since) > HOOK_SETTLE_MS))
    }
}
static CURRENT: Mutex<Option<Arc<MonitorState>>> = Mutex::new(None);
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub struct MonitorPoll { pub alive: bool, pub failed: bool, pub foreign: u64, pub interrupted: u64 }
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum HookVerdict { Own, Foreign }
/// Ours only if Windows says the event was injected AND it carries this
/// process's tag. Everything else counts as someone else, including input
/// injected by another program.
pub fn hook_verdict(injected: bool, extra: usize, tag: usize) -> HookVerdict { if injected && extra == tag { HookVerdict::Own } else { HookVerdict::Foreign } }

/// Starts a new generation without blocking; readiness or failure arrives
/// through `monitor_poll_at`. Any previous generation is cancelled.
pub fn monitor_start_with(runner: fn(Arc<MonitorState>)) -> Result<(), String> {
    let mut current = CURRENT.lock().map_err(|_| "screen_monitor_unavailable")?;
    if let Some(old) = current.take() { old.cancelled.store(true, Ordering::Release); }
    let state = Arc::new(MonitorState::default());
    let thread_state = state.clone();
    std::thread::Builder::new().name("tarobot-screen-monitor".into())
        .spawn(move || { runner(thread_state.clone()); thread_state.alive.store(false, Ordering::Release); thread_state.exited.store(true, Ordering::Release); })
        .map_err(|_| "screen_monitor_unavailable")?;
    *current = Some(state);
    Ok(())
}
/// Current generation only; counters reset on read. A monitor that can no
/// longer be trusted reports `interrupted`, which ends the lease.
pub fn monitor_poll_at(now_ms: u64) -> MonitorPoll {
    let Some(state) = CURRENT.lock().ok().and_then(|current| current.clone()) else { return MonitorPoll { alive: false, failed: false, foreign: 0, interrupted: 0 } };
    let alive = state.alive.load(Ordering::Acquire);
    if alive && state.blind(now_ms) { state.interrupted.fetch_add(1, Ordering::Relaxed); }
    MonitorPoll { alive, failed: state.failed.load(Ordering::Acquire), foreign: state.foreign.swap(0, Ordering::Relaxed), interrupted: state.interrupted.swap(0, Ordering::Relaxed) }
}
/// Cancels the current generation. Never joins: the thread leaves its loop
/// within one wait and removes its own hooks.
pub fn monitor_stop() { if let Some(state) = CURRENT.lock().ok().and_then(|mut current| current.take()) { state.cancelled.store(true, Ordering::Release); } }
fn watching() -> Option<Arc<MonitorState>> { CURRENT.lock().ok().and_then(|current| current.clone()).filter(|state| state.alive.load(Ordering::Acquire)) }

#[cfg(target_os = "windows")]
pub use os::*;
#[cfg(target_os = "windows")]
mod os {
    use super::*;
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::OnceLock;
    use windows::core::{BOOL, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO};
    use windows::Win32::Security::{GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TokenIntegrityLevel, TokenStatistics, TOKEN_MANDATORY_LABEL, TOKEN_QUERY, TOKEN_STATISTICS};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW, WTS_CURRENT_SESSION};
    use windows::Win32::System::StationsAndDesktops::{CloseDesktop, GetProcessWindowStation, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, UOI_NAME};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2};
    use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, MapVirtualKeyW, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
        MAPVK_VSC_TO_VK_EX, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK,
        MOUSEEVENTF_WHEEL, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY};
    use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, GetCursorPos, GetForegroundWindow, GetSystemMetrics, GetWindowThreadProcessId, MsgWaitForMultipleObjectsEx, PeekMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
        HHOOK, KBDLLHOOKSTRUCT, LLKHF_INJECTED, LLMHF_INJECTED, MSG, MSLLHOOKSTRUCT, MWMO_INPUTAVAILABLE, PM_REMOVE, QS_ALLINPUT, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_SWAPBUTTON, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN, WH_KEYBOARD_LL, WH_MOUSE_LL};

    const _: () = {
        assert!(flag::KEY_EXTENDED == KEYEVENTF_EXTENDEDKEY.0 && flag::KEY_UP == KEYEVENTF_KEYUP.0 && flag::KEY_UNICODE == KEYEVENTF_UNICODE.0 && flag::KEY_SCANCODE == KEYEVENTF_SCANCODE.0);
        assert!(flag::MOVE == MOUSEEVENTF_MOVE.0 && flag::LEFT_DOWN == MOUSEEVENTF_LEFTDOWN.0 && flag::LEFT_UP == MOUSEEVENTF_LEFTUP.0 && flag::RIGHT_DOWN == MOUSEEVENTF_RIGHTDOWN.0 && flag::RIGHT_UP == MOUSEEVENTF_RIGHTUP.0);
        assert!(flag::MIDDLE_DOWN == MOUSEEVENTF_MIDDLEDOWN.0 && flag::MIDDLE_UP == MOUSEEVENTF_MIDDLEUP.0 && flag::WHEEL == MOUSEEVENTF_WHEEL.0 && flag::HWHEEL == MOUSEEVENTF_HWHEEL.0);
        assert!(flag::VIRTUAL_DESK == MOUSEEVENTF_VIRTUALDESK.0 && flag::ABSOLUTE == MOUSEEVENTF_ABSOLUTE.0);
    };

    /// Stamped on every event (`dwExtraInfo`) so the hooks can tell this
    /// process's remote input from everything else. Random per process: another
    /// copy of the App is "someone else" too.
    pub fn tag() -> usize {
        static TAG: OnceLock<usize> = OnceLock::new();
        *TAG.get_or_init(|| (uuid::Uuid::new_v4().as_u128() as usize) | 1)
    }
    fn now_ms() -> u64 {
        static START: OnceLock<std::time::Instant> = OnceLock::new();
        START.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64 + 1
    }
    pub fn to_os(input: &Input, tag: usize) -> INPUT {
        match *input {
            Input::Key { vk, scan, flags } => INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: KEYBD_EVENT_FLAGS(flags), time: 0, dwExtraInfo: tag } } },
            Input::Mouse { dx, dy, data, flags } => INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: MOUSE_EVENT_FLAGS(flags), time: 0, dwExtraInfo: tag } } },
        }
    }
    fn post(inputs: &[Input]) -> usize {
        let tag = tag();
        let raw: Vec<INPUT> = inputs.iter().map(|input| to_os(input, tag)).collect();
        unsafe { SendInput(&raw, std::mem::size_of::<INPUT>() as i32) as usize }
    }

    /// Per-monitor-aware-v2 for the calling thread while alive: coordinates
    /// read and posted under it are physical pixels on every monitor.
    struct Physical(DPI_AWARENESS_CONTEXT);
    impl Physical {
        fn enter() -> Result<Self, String> {
            let previous = unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
            if previous.0.is_null() { Err("screen_input_unavailable".into()) } else { Ok(Self(previous)) }
        }
    }
    impl Drop for Physical { fn drop(&mut self) { unsafe { SetThreadDpiAwarenessContext(self.0) }; } }
    fn virtual_desktop() -> Result<Rect, String> {
        let _physical = Physical::enter()?;
        let rect = unsafe { Rect { x: GetSystemMetrics(SM_XVIRTUALSCREEN), y: GetSystemMetrics(SM_YVIRTUALSCREEN), width: GetSystemMetrics(SM_CXVIRTUALSCREEN), height: GetSystemMetrics(SM_CYVIRTUALSCREEN) } };
        if rect.width < 1 || rect.height < 1 { Err("screen_input_unavailable".into()) } else { Ok(rect) }
    }
    unsafe extern "system" fn monitor_rect(monitor: HMONITOR, _dc: HDC, _clip: *mut RECT, data: LPARAM) -> BOOL {
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        // SAFETY: `data` is the Vec `monitors` owns for the whole enumeration, which is synchronous.
        let rects = unsafe { &mut *(data.0 as *mut Vec<Option<Rect>>) };
        rects.push(unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool().then(|| {
            let r = info.rcMonitor; Rect { x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top }
        }));
        true.into()
    }
    /// Physical bounds of every monitor, as Windows itself lists them. All or nothing.
    pub fn monitors() -> Result<Vec<Rect>, String> {
        let _physical = Physical::enter()?;
        let mut rects: Vec<Option<Rect>> = Vec::new();
        if !unsafe { EnumDisplayMonitors(None, None, Some(monitor_rect), LPARAM(&mut rects as *mut _ as isize)) }.as_bool() { return Err("screen_input_unavailable".into()); }
        rects.into_iter().collect::<Option<Vec<Rect>>>().filter(|list| !list.is_empty() && list.len() <= 64).ok_or_else(|| "screen_input_unavailable".into())
    }
    /// Physical pixels, the units of every point this backend posts.
    pub fn cursor() -> Result<(i32, i32), String> {
        let _physical = Physical::enter()?;
        let mut point = POINT::default();
        unsafe { GetCursorPos(&mut point) }.map_err(|_| "screen_input_unavailable")?;
        Ok((point.x, point.y))
    }

    // ---- session ----
    struct Token(HANDLE);
    impl Drop for Token { fn drop(&mut self) { unsafe { let _ = CloseHandle(self.0); } } }
    fn token_of(process: HANDLE) -> Option<Token> {
        let mut token = HANDLE::default();
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
        Some(Token(token))
    }
    fn logon_of_process() -> Option<(u32, i32)> {
        static LOGON: OnceLock<Option<(u32, i32)>> = OnceLock::new();
        *LOGON.get_or_init(|| {
            let token = token_of(unsafe { GetCurrentProcess() })?;
            let mut statistics = TOKEN_STATISTICS::default(); let mut size = 0u32;
            unsafe { GetTokenInformation(token.0, TokenStatistics, Some(&mut statistics as *mut _ as *mut c_void), std::mem::size_of::<TOKEN_STATISTICS>() as u32, &mut size) }.ok()?;
            Some((statistics.AuthenticationId.LowPart, statistics.AuthenticationId.HighPart))
        })
    }
    /// The mandatory integrity level (its RID) of `process`.
    fn integrity(process: HANDLE) -> Option<u32> {
        let token = token_of(process)?;
        let mut buffer = [0u64; 16]; let mut size = 0u32;
        unsafe { GetTokenInformation(token.0, TokenIntegrityLevel, Some(buffer.as_mut_ptr() as *mut c_void), std::mem::size_of_val(&buffer) as u32, &mut size) }.ok()?;
        // SAFETY: the call succeeded, so the buffer starts with a TOKEN_MANDATORY_LABEL whose SID lies inside it.
        unsafe {
            let sid = (*(buffer.as_ptr() as *const TOKEN_MANDATORY_LABEL)).Label.Sid;
            let count = GetSidSubAuthorityCount(sid);
            if count.is_null() || *count == 0 { return None; }
            let rid = GetSidSubAuthority(sid, (*count - 1) as u32);
            if rid.is_null() { None } else { Some(*rid) }
        }
    }
    /// See `admit`. Read-only: nothing is done to the other process.
    fn foreground_higher() -> Option<bool> {
        static OWN: OnceLock<Option<u32>> = OnceLock::new();
        let window = unsafe { GetForegroundWindow() };
        if window.0.is_null() { return Some(false); }
        let mut process_id = 0u32;
        if unsafe { GetWindowThreadProcessId(window, Some(&mut process_id)) } == 0 || process_id == 0 { return None; }
        if process_id == unsafe { GetCurrentProcessId() } { return Some(false); }
        let own = (*OWN.get_or_init(|| integrity(unsafe { GetCurrentProcess() })))?;
        let process = Token(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, process_id) }.ok()?);
        Some(integrity(process.0)? > own)
    }
    fn object_name(object: HANDLE) -> Option<String> {
        let mut buffer = [0u16; 128]; let mut needed = 0u32;
        unsafe { GetUserObjectInformationW(object, UOI_NAME, Some(buffer.as_mut_ptr() as *mut c_void), std::mem::size_of_val(&buffer) as u32, Some(&mut needed)) }.ok()?;
        let length = buffer.iter().position(|unit| *unit == 0)?;
        Some(String::from_utf16_lossy(&buffer[..length]))
    }
    /// The desktop receiving input now. A lock screen or consent prompt is a
    /// desktop this process may not open, which is `None`.
    fn input_desktop() -> Option<String> {
        // DESKTOP_READOBJECTS: the least access that lets the name be read.
        let desktop = unsafe { OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_ACCESS_FLAGS(0x0001)) }.ok()?;
        let name = object_name(HANDLE(desktop.0));
        unsafe { let _ = CloseDesktop(desktop); }
        name
    }
    /// Connection state, lock state and logon time of this process's session.
    fn terminal_session() -> Option<(i32, i32, i64)> {
        let mut buffer = PWSTR::null(); let mut bytes = 0u32;
        unsafe { WTSQuerySessionInformationW(None, WTS_CURRENT_SESSION, WTSSessionInfoEx, &mut buffer, &mut bytes) }.ok()?;
        if buffer.is_null() { return None; }
        // SAFETY: on success the buffer holds one WTSINFOEXW; level 1 is the only level there is.
        let facts = unsafe {
            let info = &*(buffer.0 as *const WTSINFOEXW);
            (bytes as usize >= std::mem::size_of::<WTSINFOEXW>() && info.Level == 1).then(|| { let level = &info.Data.WTSInfoExLevel1; (level.SessionState.0, level.SessionFlags, level.LogonTime) })
        };
        unsafe { WTSFreeMemory(buffer.0 as *mut c_void) };
        facts
    }
    pub fn session_facts() -> SessionFacts {
        let mut session = 0u32;
        let session = unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) }.ok().map(|_| session);
        let terminal = terminal_session();
        SessionFacts {
            session, connect_state: terminal.map(|t| t.0), lock: terminal.map(|t| t.1), logon_time: terminal.map(|t| t.2), logon: logon_of_process(),
            // Neither handle is owned: they belong to the process and the thread.
            station: unsafe { GetProcessWindowStation() }.ok().and_then(|station| object_name(HANDLE(station.0))),
            own_desktop: unsafe { GetThreadDesktop(GetCurrentThreadId()) }.ok().and_then(|desktop| object_name(HANDLE(desktop.0))),
            input_desktop: input_desktop(),
        }
    }
    pub fn session_state() -> Session { classify(&session_facts()) }

    // ---- posting ----
    static HELD: Mutex<Held> = Mutex::new(Held::new());
    /// Every post is checked against the session as it is at this moment; the
    /// caller's own readiness check may be a quarter of a second old.
    fn submit(inputs: &[Input]) -> Result<(), String> {
        if inputs.is_empty() { return Ok(()); }
        admit(inputs, session_state().controllable(), if inputs.iter().any(Input::is_down) { foreground_higher() } else { Some(false) })?;
        let mut held = HELD.lock().map_err(|_| "screen_input_failed")?;
        submit_with(&mut held, inputs, watching().as_deref(), now_ms(), &mut post)
    }
    fn pixel(value: f64) -> Result<i32, String> {
        if value.is_finite() && value.fract() == 0.0 && value.abs() <= 1_000_000.0 { Ok(value as i32) } else { Err("screen_point_out_of_bounds".into()) }
    }
    /// Which physical button Windows takes for `button` by meaning, as the
    /// swap setting is at this moment. The caller records the answer and then
    /// presses exactly that button with `post_mouse`.
    pub fn physical_button_now(button: Button) -> Button { physical_button(button, unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0) }
    /// `button` is physical; see `mouse_inputs`.
    pub fn post_mouse(action: Mouse, button: Button, x: f64, y: f64, clicks: i64) -> Result<(), String> {
        submit(&mouse_inputs(action, button, (pixel(x)?, pixel(y)?), virtual_desktop()?, clicks)?)
    }
    pub fn post_scroll(x: f64, y: f64, vertical: i32, horizontal: i32) -> Result<(), String> {
        submit(&wheel_inputs((pixel(x)?, pixel(y)?), virtual_desktop()?, vertical, horizontal)?)
    }
    pub fn post_key(descriptor: u16, down: bool, modifier: bool) -> Result<(), String> { submit(&key_inputs(descriptor, down, modifier)?) }
    pub fn post_text(text: &str) -> Result<(), String> {
        let inputs = text_inputs(text)?;
        let before = HELD.lock().map_err(|_| "screen_input_failed")?.clone();
        for batch in text_batches(&inputs) {
            if let Err(error) = submit(batch) {
                // The batch may have ended on a down: of a unit, or of a real Enter or Tab. Lift what this call pressed, now.
                if let Ok(mut held) = HELD.lock() { let _ = release_since_with(&mut held, &before, watching().as_deref(), now_ms(), &mut post); }
                return Err(error);
            }
        }
        Ok(())
    }
    pub fn held() -> u32 { HELD.lock().map(|held| held.len() as u32).unwrap_or(u32::MAX) }
    /// Lifts what this process still holds. Ups are posted only to the desktop
    /// this process runs on; while another desktop has the input they stay
    /// recorded and the call fails, to be tried again when it is back.
    pub fn release_all() -> Result<u32, String> {
        let mut held = HELD.lock().map_err(|_| "screen_input_failed")?;
        if held.is_empty() { return Ok(0); }
        if !session_state().controllable() { return Err("screen_release_pending".into()); }
        release_all_with(&mut held, watching().as_deref(), now_ms(), &mut post)
    }
    /// See `candidate_releases`. Fails without posting while the session cannot
    /// take input or key state cannot be trusted (`recovery_readable`); the
    /// caller keeps its record and tries again.
    pub fn release_candidates(keys: &[u16], buttons: &[Button]) -> Result<u32, String> {
        recovery_readable(session_state().controllable(), foreground_higher())?;
        let key_down = |descriptor: u16| {
            let vk = unsafe { MapVirtualKeyW((descriptor & 0xff) as u32 | if descriptor & EXTENDED != 0 { 0xe000 } else { 0 }, MAPVK_VSC_TO_VK_EX) };
            vk != 0 && unsafe { GetAsyncKeyState(vk as i32) } < 0
        };
        // VK_LBUTTON, VK_RBUTTON, VK_MBUTTON: the physical buttons, whatever the swap setting.
        let button_down = |button: Button| unsafe { GetAsyncKeyState(match button { Button::Left => 0x01, Button::Right => 0x02, Button::Other => 0x04 }) } < 0;
        let ups = candidate_releases(keys, buttons, &key_down, &button_down)?;
        if ups.is_empty() { return Ok(0); }
        if post(&ups) == ups.len() { Ok(ups.len() as u32) } else { Err("screen_release_pending".into()) }
    }

    // ---- hooks ----
    thread_local! { static HOOKED: RefCell<Option<Arc<MonitorState>>> = const { RefCell::new(None) }; }
    fn seen(keyboard: bool, injected: bool, extra: usize) {
        HOOKED.with(|state| if let Some(state) = state.borrow().as_ref() { state.saw(keyboard, hook_verdict(injected, extra, tag())); });
    }
    unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && lparam.0 != 0 {
            // SAFETY: for a low-level keyboard hook with code >= 0, lparam points to a KBDLLHOOKSTRUCT.
            let event = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
            seen(true, event.flags.contains(LLKHF_INJECTED), event.dwExtraInfo);
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
    unsafe extern "system" fn mouse_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code >= 0 && lparam.0 != 0 {
            // SAFETY: for a low-level mouse hook with code >= 0, lparam points to an MSLLHOOKSTRUCT.
            let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
            seen(false, event.flags & LLMHF_INJECTED != 0, event.dwExtraInfo);
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
    struct Hook(HHOOK);
    impl Drop for Hook { fn drop(&mut self) { unsafe { let _ = UnhookWindowsHookEx(self.0); } } }
    /// Installs both hooks on this thread and turns its message loop until
    /// cancelled. The hooks are removed here, on the thread that owns them.
    fn hook_runner(state: Arc<MonitorState>) {
        let module = unsafe { GetModuleHandleW(None) }.ok().map(|module| module.into());
        let install = |kind, procedure| unsafe { SetWindowsHookExW(kind, Some(procedure), module, 0) }.ok().map(Hook);
        let (Some(_keyboard), Some(_mouse)) = (install(WH_KEYBOARD_LL, keyboard_hook as _), install(WH_MOUSE_LL, mouse_hook as _)) else { state.failed.store(true, Ordering::Release); return; };
        if state.cancelled.load(Ordering::Acquire) { return; }
        HOOKED.with(|slot| *slot.borrow_mut() = Some(state.clone()));
        state.turned(now_ms());
        state.alive.store(true, Ordering::Release);
        let mut message = MSG::default();
        while !state.cancelled.load(Ordering::Acquire) {
            // Hook calls are delivered inside PeekMessageW; the wait only bounds how long a cancel takes.
            unsafe {
                MsgWaitForMultipleObjectsEx(None, 50, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {}
            }
            state.turned(now_ms());
        }
        state.alive.store(false, Ordering::Release);
        HOOKED.with(|slot| *slot.borrow_mut() = None);
    }
    pub fn monitor_start() -> Result<(), String> { monitor_start_with(hook_runner) }
    pub fn monitor_poll() -> MonitorPoll { monitor_poll_at(now_ms()) }
}

#[cfg(test)]
mod tests {
    //! Construction, bookkeeping and decisions only. Nothing here posts input,
    //! installs a hook or reads the session; `os` is not even built off Windows.
    use super::*;
    const DESKTOP: Rect = Rect { x: -1920, y: -200, width: 4480, height: 1640 };
    fn scancode(scan: u16, flags: u32) -> Input { Input::Key { vk: 0, scan, flags } }
    /// What Windows does with an absolute move.
    fn lands(units: i32, size: i32) -> i32 { ((units as i64 * size as i64) >> 16) as i32 }

    #[test]
    fn keys_are_scan_codes_with_the_extended_and_up_flags_and_no_virtual_key() {
        assert_eq!(key_inputs(0x11, true, false).unwrap(), vec![scancode(0x11, flag::KEY_SCANCODE)]);
        assert_eq!(key_inputs(0x11, false, false).unwrap(), vec![scancode(0x11, flag::KEY_SCANCODE | flag::KEY_UP)]);
        assert_eq!(key_inputs(EXTENDED | 0x4b, true, false).unwrap(), vec![scancode(0x4b, flag::KEY_SCANCODE | flag::KEY_EXTENDED)]);
        assert_eq!(key_inputs(EXTENDED | 0x1d, false, true).unwrap(), vec![scancode(0x1d, flag::KEY_SCANCODE | flag::KEY_EXTENDED | flag::KEY_UP)]);
        // The numeric-pad 4 and the left arrow differ only by the extended flag.
        assert_ne!(key_inputs(0x4b, true, false).unwrap(), key_inputs(EXTENDED | 0x4b, true, false).unwrap());
        assert!(key_inputs(0x1d, true, false).is_err(), "Control must be posted as a modifier");
        assert!(key_inputs(0x11, true, true).is_err());
        for bad in [0x00, 0x80, 0x200 | 0x11, EXTENDED] { assert!(key_inputs(bad, true, false).is_err(), "{bad:#x}"); }
    }
    #[test]
    fn text_is_unicode_down_and_up_per_unit_in_order_with_enter_and_tab_as_keys() {
        let unicode = |unit: u16| [scancode(unit, flag::KEY_UNICODE), scancode(unit, flag::KEY_UNICODE | flag::KEY_UP)];
        let pair: Vec<u16> = "😀".encode_utf16().collect();
        assert_eq!(text_inputs("中😀").unwrap(), [unicode(0x4e2d), unicode(pair[0]), unicode(pair[1])].concat());
        let enter = [scancode(SCAN_ENTER, flag::KEY_SCANCODE), scancode(SCAN_ENTER, flag::KEY_SCANCODE | flag::KEY_UP)];
        let tab = [scancode(SCAN_TAB, flag::KEY_SCANCODE), scancode(SCAN_TAB, flag::KEY_SCANCODE | flag::KEY_UP)];
        assert_eq!(text_inputs("a\r\nb\rc\td").unwrap(), [&unicode(0x61)[..], &enter, &unicode(0x62), &enter, &unicode(0x63), &tab, &unicode(0x64)].concat());
        assert!(text_inputs("").is_err() && text_inputs("\u{7}").is_err() && text_inputs(&"x".repeat(2049)).is_err());
        assert_eq!(text_inputs(&"x".repeat(2048)).unwrap().len(), 4096);
        let long = text_inputs(&"😀".repeat(50)).unwrap();
        let batches: Vec<&[Input]> = text_batches(&long).collect();
        assert!(batches.len() > 1 && batches.iter().all(|batch| batch.len() <= TEXT_BATCH && batch.len() % 2 == 0), "no batch ends between a down and its up");
        assert_eq!(batches.concat(), long);
    }
    #[test]
    fn an_absolute_move_lands_on_the_asked_pixel_on_every_monitor_of_the_virtual_desktop() {
        // Left of and above the primary monitor, the far corners, and every pixel of an odd width.
        for point in [(-1920, -200), (-1, 0), (0, 0), (2559, 1439), (-1920, 1439), (2559, -200), (1, 1), (1280, 720)] {
            let (dx, dy) = absolute(point, DESKTOP).unwrap();
            assert!((0..=65535).contains(&dx) && (0..=65535).contains(&dy));
            assert_eq!((lands(dx, DESKTOP.width) + DESKTOP.x, lands(dy, DESKTOP.height) + DESKTOP.y), point);
        }
        for width in [1, 2, 1366, 1920, 3839, 7681, 65536] {
            let desktop = Rect { x: -7, y: 0, width, height: 1 };
            for x in (0..width).step_by((width as usize / 997).max(1)).chain([width - 1]) { assert_eq!(lands(absolute((x - 7, 0), desktop).unwrap().0, width), x, "width {width}"); }
        }
        for outside in [(-1921, 0), (2560, 0), (0, -201), (0, 1440)] { assert!(absolute(outside, DESKTOP).is_err()); }
        assert!(absolute((0, 0), Rect { x: 0, y: 0, width: 0, height: 10 }).is_err() && absolute((0, 0), Rect { x: 0, y: 0, width: 65537, height: 10 }).is_err());
    }
    #[test]
    fn pointer_events_move_first_and_a_click_count_never_adds_clicks() {
        let moved = Input::Mouse { dx: absolute((10, 20), DESKTOP).unwrap().0, dy: absolute((10, 20), DESKTOP).unwrap().1, data: 0, flags: flag::MOVE | flag::ABSOLUTE | flag::VIRTUAL_DESK };
        let button = |flags| Input::Mouse { dx: 0, dy: 0, data: 0, flags };
        assert_eq!(mouse_inputs(Mouse::Move, Button::Left, (10, 20), DESKTOP, 1).unwrap(), vec![moved]);
        assert_eq!(mouse_inputs(Mouse::Drag, Button::Right, (10, 20), DESKTOP, 1).unwrap(), vec![moved], "a drag is a move while Windows knows the button is down");
        for clicks in 1..=3 {
            assert_eq!(mouse_inputs(Mouse::Down, Button::Left, (10, 20), DESKTOP, clicks).unwrap(), vec![moved, button(flag::LEFT_DOWN)]);
            assert_eq!(mouse_inputs(Mouse::Up, Button::Left, (10, 20), DESKTOP, clicks).unwrap(), vec![moved, button(flag::LEFT_UP)]);
        }
        assert_eq!(mouse_inputs(Mouse::Down, Button::Right, (10, 20), DESKTOP, 1).unwrap()[1], button(flag::RIGHT_DOWN));
        assert_eq!(mouse_inputs(Mouse::Up, Button::Other, (10, 20), DESKTOP, 1).unwrap()[1], button(flag::MIDDLE_UP));
        assert!(mouse_inputs(Mouse::Down, Button::Left, (10, 20), DESKTOP, 0).is_err() && mouse_inputs(Mouse::Down, Button::Left, (10, 20), DESKTOP, 4).is_err());
        assert!(mouse_inputs(Mouse::Move, Button::Left, (9000, 0), DESKTOP, 1).is_err());
        assert!(Mouse::parse("hover").is_err() && Button::parse("middle").is_err());
    }
    #[test]
    fn wheel_amounts_keep_their_sign_and_axis_and_are_bounded() {
        let wheel = |data, flags| Input::Mouse { dx: 0, dy: 0, data, flags };
        let both = wheel_inputs((10, 20), DESKTOP, -120, 36).unwrap();
        assert_eq!(both.len(), 3);
        assert_eq!((both[1], both[2]), (wheel(-120, flag::WHEEL), wheel(36, flag::HWHEEL)));
        assert_eq!(wheel_inputs((10, 20), DESKTOP, 0, -5).unwrap()[1..], [wheel(-5, flag::HWHEEL)]);
        assert_eq!(wheel_inputs((10, 20), DESKTOP, 7, 0).unwrap()[1..], [wheel(7, flag::WHEEL)], "an amount below one notch is sent as it is");
        assert!(wheel_inputs((10, 20), DESKTOP, 0, 0).unwrap().is_empty());
        assert!(wheel_inputs((10, 20), DESKTOP, WHEEL_MAX + 1, 0).is_err() && wheel_inputs((10, 20), DESKTOP, 0, -WHEEL_MAX - 1).is_err());
    }
    /// A `SendInput` that takes `limit` inputs per call and remembers them.
    fn taking(limit: usize, taken: &mut Vec<Input>) -> impl FnMut(&[Input]) -> usize + '_ { move |inputs| { let count = limit.min(inputs.len()); taken.extend_from_slice(&inputs[..count]); count } }

    #[test]
    fn what_is_held_follows_what_windows_took_not_what_was_asked() {
        let mut held = Held::new(); let mut taken = Vec::new();
        let chord = [key_inputs(EXTENDED | 0x1d, true, true).unwrap(), key_inputs(0x2e, true, false).unwrap(), mouse_inputs(Mouse::Down, Button::Left, (0, 0), DESKTOP, 1).unwrap()].concat();
        // Windows takes only the first two: right Control and C. The move and the button never happened.
        assert_eq!(submit_with(&mut held, &chord, None, 1, &mut taking(2, &mut taken)), Err("screen_input_blocked".into()));
        assert_eq!((held.keys.iter().copied().collect::<Vec<_>>(), held.buttons.len()), (vec![0x2e, EXTENDED | 0x1d], 0));
        assert_eq!(taken.len(), 2, "the refused rest is not posted again");
        // Nothing taken at all: nothing is held.
        let mut none = Held::new();
        assert_eq!(submit_with(&mut none, &chord, None, 1, &mut |_| 0), Err("screen_input_blocked".into()));
        assert!(none.is_empty());
        // Everything taken, then released one by one.
        let mut all = Held::new();
        submit_with(&mut all, &chord, None, 1, &mut |inputs| inputs.len()).unwrap();
        assert_eq!(all.len(), 3);
        submit_with(&mut all, &key_inputs(0x2e, false, false).unwrap(), None, 1, &mut |inputs| inputs.len()).unwrap();
        submit_with(&mut all, &mouse_inputs(Mouse::Up, Button::Left, (0, 0), DESKTOP, 1).unwrap(), None, 1, &mut |inputs| inputs.len()).unwrap();
        assert_eq!((all.keys.iter().copied().collect::<Vec<_>>(), all.buttons.len()), (vec![EXTENDED | 0x1d], 0));
        // A reported count larger than the batch is not trusted beyond the batch.
        assert!(submit_with(&mut Held::new(), &chord, None, 1, &mut |_| 99).is_ok());
        assert!(submit_with(&mut Held::new(), &[], None, 1, &mut |_| panic!("an empty batch is not posted")).is_ok());
    }
    #[test]
    fn release_lifts_ordinary_keys_then_modifiers_then_buttons_in_place_and_keeps_what_was_refused() {
        let mut held = Held::new();
        let presses = [key_inputs(0x2a, true, true).unwrap(), key_inputs(0x1e, true, false).unwrap(), key_inputs(EXTENDED | 0x5b, true, true).unwrap(), key_inputs(EXTENDED | 0x48, true, false).unwrap(),
            mouse_inputs(Mouse::Down, Button::Right, (5, 5), DESKTOP, 1).unwrap(), vec![scancode(0x4e2d, flag::KEY_UNICODE)]].concat();
        submit_with(&mut held, &presses, None, 1, &mut |inputs| inputs.len()).unwrap();
        let expected = vec![scancode(0x4e2d, flag::KEY_UNICODE | flag::KEY_UP),
            scancode(0x1e, flag::KEY_SCANCODE | flag::KEY_UP), scancode(0x48, flag::KEY_SCANCODE | flag::KEY_EXTENDED | flag::KEY_UP),
            scancode(0x2a, flag::KEY_SCANCODE | flag::KEY_UP), scancode(0x5b, flag::KEY_SCANCODE | flag::KEY_EXTENDED | flag::KEY_UP),
            Input::Mouse { dx: 0, dy: 0, data: 0, flags: flag::RIGHT_UP }];
        assert_eq!(held.releases(), expected);
        assert!(expected.iter().all(|input| !matches!(input, Input::Mouse { flags, .. } if flags & flag::MOVE != 0)), "a release never moves the pointer");
        // Windows takes three ups: the two modifiers and the button stay held and the call fails.
        let mut taken = Vec::new();
        assert_eq!(release_all_with(&mut held, None, 1, &mut taking(3, &mut taken)), Err("screen_release_pending".into()));
        assert_eq!(taken, expected[..3]);
        assert_eq!((held.keys.iter().copied().collect::<Vec<_>>(), held.units.len(), held.buttons.len()), (vec![0x2a, EXTENDED | 0x5b], 0, 1));
        // Refused entirely (another desktop has the input): everything stays for the next try.
        assert_eq!(release_all_with(&mut held, None, 1, &mut |_| 0), Err("screen_release_pending".into()));
        assert_eq!(held.len(), 3);
        // Taken: nothing is left, and a second release posts nothing.
        assert_eq!(release_all_with(&mut held, None, 1, &mut |inputs| inputs.len()), Ok(3));
        assert!(held.is_empty());
        assert_eq!(release_all_with(&mut held, None, 1, &mut |_| panic!("nothing to release")), Ok(0));
    }
    #[test]
    fn a_text_call_windows_took_half_of_lifts_what_it_pressed_units_and_real_keys_and_nothing_else() {
        let mut held = Held::new(); let mut taken = Vec::new();
        submit_with(&mut held, &key_inputs(0x2a, true, true).unwrap(), None, 1, &mut |inputs| inputs.len()).unwrap();
        let before = held.clone();
        // Windows takes three of four: 中 down and up, then only the down of 文.
        assert!(submit_with(&mut held, &text_inputs("中文").unwrap(), None, 1, &mut taking(3, &mut taken)).is_err());
        assert_eq!((held.units.iter().copied().collect::<Vec<_>>(), held.keys.len()), (vec![0x6587], 1));
        assert_eq!(release_since_with(&mut held, &before, None, 1, &mut |_| 0), Err("screen_release_pending".into()));
        assert_eq!(held.units.len(), 1, "refused: still recorded, and the general release will try it again");
        let mut lifted = Vec::new();
        assert_eq!(release_since_with(&mut held, &before, None, 1, &mut taking(9, &mut lifted)), Ok(1));
        assert_eq!(lifted, vec![scancode(0x6587, flag::KEY_UNICODE | flag::KEY_UP)]);
        assert_eq!(held, before, "the Shift this lease holds is not touched");
        assert_eq!(release_since_with(&mut held, &before, None, 1, &mut |_| panic!("the text call left nothing")), Ok(0));
        // A line break and a tab are real keys. Windows takes only the first input: the key is down.
        for (text, scan) in [("\t", SCAN_TAB), ("\n", SCAN_ENTER), ("\r\n", SCAN_ENTER)] {
            let mut held = before.clone(); let mut lifted = Vec::new();
            assert!(submit_with(&mut held, &text_inputs(text).unwrap(), None, 1, &mut |_| 1).is_err());
            assert_eq!(held.keys.iter().copied().collect::<Vec<_>>(), vec![scan, 0x2a], "{text:?}");
            assert_eq!(release_since_with(&mut held, &before, None, 1, &mut taking(9, &mut lifted)), Ok(1));
            assert_eq!(lifted, vec![scancode(scan, flag::KEY_SCANCODE | flag::KEY_UP)]);
            assert_eq!(held, before);
        }
        // A key the lease already held before the text call is the lease's, not the text's.
        let mut tabbed = Held::new();
        submit_with(&mut tabbed, &key_inputs(SCAN_TAB, true, false).unwrap(), None, 1, &mut |inputs| inputs.len()).unwrap();
        let holding_tab = tabbed.clone();
        assert!(submit_with(&mut tabbed, &text_inputs("\t").unwrap(), None, 1, &mut |_| 1).is_err());
        assert_eq!(release_since_with(&mut tabbed, &holding_tab, None, 1, &mut |_| panic!("nothing new is held")), Ok(0));
        assert_eq!(tabbed, holding_tab);
    }
    #[test]
    fn a_press_needs_a_controllable_session_and_a_foreground_window_known_not_to_be_elevated() {
        let down = key_inputs(0x1e, true, false).unwrap(); let up = key_inputs(0x1e, false, false).unwrap();
        let click = mouse_inputs(Mouse::Down, Button::Left, (0, 0), DESKTOP, 1).unwrap(); let moved = mouse_inputs(Mouse::Move, Button::Left, (0, 0), DESKTOP, 1).unwrap();
        let typed = text_inputs("a").unwrap();
        for inputs in [&down, &click, &typed] {
            assert_eq!(admit(inputs, true, Some(false)), Ok(()));
            assert_eq!(admit(inputs, true, Some(true)), Err("screen_input_blocked".into()), "elevated foreground window");
            assert_eq!(admit(inputs, true, None), Err("screen_input_blocked".into()), "integrity could not be read");
            assert_eq!(admit(inputs, false, Some(false)), Err("screen_locked".into()));
        }
        // Ups, moves and wheel are not presses: only the session decides.
        for inputs in [&up, &moved, &wheel_inputs((0, 0), DESKTOP, 120, 0).unwrap()] {
            assert_eq!(admit(inputs, true, None), Ok(()));
            assert_eq!(admit(inputs, false, Some(false)), Err("screen_locked".into()));
        }
    }
    #[test]
    fn recovery_lifts_only_recorded_inputs_that_are_still_down() {
        let up = |descriptor: u16| key(descriptor, false).unwrap();
        let button = |flags| Input::Mouse { dx: 0, dy: 0, data: 0, flags };
        let recorded = [EXTENDED | 0x1d, 0x1e, 0x2a, EXTENDED | 0x4b, 0x1e];
        // Everything recorded is still down: ordinary keys, then modifiers, then buttons; a repeated record is one up.
        assert_eq!(candidate_releases(&recorded, &[Button::Other], &|_| true, &|_| true).unwrap(),
            vec![up(0x1e), up(EXTENDED | 0x4b), up(0x2a), up(EXTENDED | 0x1d), button(flag::MIDDLE_UP)]);
        // Only what Windows reports as down is lifted.
        assert_eq!(candidate_releases(&recorded, &[Button::Left], &|descriptor| descriptor == 0x2a, &|_| false).unwrap(), vec![up(0x2a)]);
        assert!(candidate_releases(&recorded, &[Button::Left, Button::Right, Button::Other], &|_| false, &|_| false).unwrap().is_empty(), "nothing down: nothing is posted, no stray secondary-button up");
        // Nothing recorded: nothing is asked about and nothing is lifted, whatever is down on the computer.
        assert!(candidate_releases(&[], &[], &|_| panic!("the keyboard is not examined"), &|_| panic!("the mouse is not examined")).unwrap().is_empty());
        let asked = std::cell::RefCell::new(Vec::new());
        candidate_releases(&[0x1e], &[], &|descriptor| { asked.borrow_mut().push(descriptor); false }, &|_| panic!("no button was recorded")).unwrap();
        assert_eq!(*asked.borrow(), vec![0x1e], "only the recorded key is asked about");
        // A recorded button is that physical button and no other: the person's own other button is never lifted.
        assert!(candidate_releases(&[], &[Button::Left], &|_| false, &|button| button == Button::Right).unwrap().is_empty(), "only the physical right button is down, and it was not recorded");
        assert_eq!(candidate_releases(&[], &[Button::Right, Button::Right], &|_| false, &|_| true).unwrap(), vec![button(flag::RIGHT_UP)]);
        assert_eq!(candidate_releases(&[], &[Button::Right, Button::Left], &|_| false, &|_| true).unwrap(), vec![button(flag::LEFT_UP), button(flag::RIGHT_UP)]);
        assert!(candidate_releases(&[], &[Button::Other], &|_| false, &|button| button != Button::Other).unwrap().is_empty());
        let asked_buttons = std::cell::RefCell::new(Vec::new());
        candidate_releases(&[], &[Button::Left], &|_| panic!("no key was recorded"), &|button| { asked_buttons.borrow_mut().push(button); false }).unwrap();
        assert_eq!(*asked_buttons.borrow(), vec![Button::Left], "the other buttons are not even asked about");
        // A record that is not a key this backend can press is refused whole.
        assert!(candidate_releases(&[0x1e, 0x00], &[], &|_| true, &|_| true).is_err() && candidate_releases(&[0x2ff], &[], &|_| true, &|_| true).is_err());
        assert!(candidate_releases(&[0x1e; 257], &[], &|_| true, &|_| true).is_err());
    }
    #[test]
    fn recovery_waits_while_an_elevated_or_unknown_foreground_hides_key_state() {
        // UIPI makes GetAsyncKeyState read zero: reading then would report nothing down and delete the record.
        assert_eq!(recovery_readable(true, Some(true)), Err("screen_release_pending".into()));
        assert_eq!(recovery_readable(true, None), Err("screen_release_pending".into()));
        assert_eq!(recovery_readable(false, Some(false)), Err("screen_release_pending".into()));
        assert_eq!(recovery_readable(true, Some(false)), Ok(()));
    }
    #[test]
    fn a_button_is_named_by_meaning_and_pressed_as_the_physical_one_windows_will_take_for_it() {
        for button in [Button::Left, Button::Right, Button::Other] { assert_eq!(physical_button(button, false), button); assert_eq!(Button::parse(button.name()), Ok(button)); }
        assert_eq!((physical_button(Button::Left, true), physical_button(Button::Right, true), physical_button(Button::Other, true)), (Button::Right, Button::Left, Button::Other));
    }
    fn facts() -> SessionFacts {
        SessionFacts { session: Some(2), connect_state: Some(0), lock: Some(1), logon_time: Some(0x01db_1234_5678_9abc), logon: Some((0x0004_c2a1, 0)),
            station: Some("WinSta0".into()), own_desktop: Some("Default".into()), input_desktop: Some("Default".into()) }
    }
    #[test]
    fn a_session_is_controllable_only_when_everything_was_read_and_says_so() {
        let ready = classify(&facts());
        assert_eq!(ready, Session { available: true, on_console: true, locked: false, unique: Some("2-000000000004c2a1-1db123456789abc".into()) });
        assert!(ready.controllable());
        assert!(ready.unique.as_ref().unwrap().chars().all(|c| c.is_ascii_hexdigit() || c == '-') && ready.unique.as_ref().unwrap().len() <= 64);
        let with = |change: fn(&mut SessionFacts)| { let mut changed = facts(); change(&mut changed); classify(&changed) };
        // Not positively unlocked.
        for lock in [Some(0), Some(-1), None] { let mut f = facts(); f.lock = lock; let s = classify(&f); assert!(s.locked && !s.controllable(), "{lock:?}"); }
        // Disconnected or otherwise not active.
        for state in [1, 4, 5, 9] { let mut f = facts(); f.connect_state = Some(state); let s = classify(&f); assert!(s.available && !s.on_console && !s.controllable(), "{state}"); }
        // The services session, a failed read of any fact, another window station.
        assert!(!with(|f| f.session = Some(0)).available && !with(|f| f.session = None).available);
        assert!(!with(|f| f.connect_state = None).available && !with(|f| f.logon = None).available && !with(|f| f.logon_time = None).available);
        assert!(!with(|f| f.station = None).available && !with(|f| f.own_desktop = None).available);
        assert!(!with(|f| f.station = Some("Service-0x0-3e7$".into())).on_console);
        // The lock screen and a consent prompt cannot be opened; another desktop has another name.
        assert!(!with(|f| f.input_desktop = None).on_console && !with(|f| f.input_desktop = Some("Winlogon".into())).on_console);
        assert!(!with(|f| f.own_desktop = Some(String::new())).on_console);
        assert!(with(|f| f.input_desktop = Some("default".into())).controllable(), "names are not case sensitive");
        // Nothing unavailable carries an identity; another login is another identity.
        assert_eq!(with(|f| f.connect_state = None).unique, None);
        assert_ne!(with(|f| f.logon = Some((0x0004_c2a2, 0))).unique, ready.unique);
        assert_ne!(with(|f| f.logon_time = Some(1)).unique, ready.unique);
        assert_ne!(with(|f| f.session = Some(3)).unique, ready.unique);
    }
    #[test]
    fn only_injected_events_with_this_process_tag_are_ours() {
        assert_eq!(hook_verdict(true, 0xabc1, 0xabc1), HookVerdict::Own);
        assert_eq!(hook_verdict(false, 0xabc1, 0xabc1), HookVerdict::Foreign, "a hardware event that happens to carry the value");
        assert_eq!(hook_verdict(true, 0, 0xabc1), HookVerdict::Foreign, "injected by another program");
        assert_eq!(hook_verdict(true, 0xabc3, 0xabc1), HookVerdict::Foreign, "another copy of the App");
        assert_eq!(hook_verdict(false, 0, 0xabc1), HookVerdict::Foreign);
    }
    // Scheduling tests use fake runners; no hook is ever installed here.
    static SERIAL: Mutex<()> = Mutex::new(());
    fn wait(check: impl Fn() -> bool) -> bool { for _ in 0..400 { if check() { return true; } std::thread::sleep(std::time::Duration::from_millis(5)); } false }
    fn fake_alive(state: Arc<MonitorState>) {
        state.turned(1000); state.alive.store(true, Ordering::Release);
        while !state.cancelled.load(Ordering::Acquire) { std::thread::sleep(std::time::Duration::from_millis(5)); }
    }
    fn fake_late(state: Arc<MonitorState>) {
        std::thread::sleep(std::time::Duration::from_millis(60));
        if state.cancelled.load(Ordering::Acquire) { return; }
        fake_alive(state);
    }
    fn fake_fail(state: Arc<MonitorState>) { state.failed.store(true, Ordering::Release); }
    const QUIET: MonitorPoll = MonitorPoll { alive: true, failed: false, foreign: 0, interrupted: 0 };

    #[test]
    fn monitor_start_does_not_block_and_reports_readiness_or_failure_by_poll() {
        let _guard = SERIAL.lock().unwrap();
        monitor_stop();
        assert_eq!(monitor_poll_at(1000), MonitorPoll { alive: false, failed: false, foreign: 0, interrupted: 0 });
        let started = std::time::Instant::now();
        monitor_start_with(fake_late).unwrap();
        assert!(started.elapsed() < std::time::Duration::from_millis(30), "start returns before the hooks exist");
        assert!(!monitor_poll_at(1000).alive);
        assert!(wait(|| monitor_poll_at(1000).alive));
        monitor_start_with(fake_fail).unwrap();
        assert!(wait(|| monitor_poll_at(1000).failed));
        monitor_stop();
    }
    #[test]
    fn stop_is_bounded_and_a_late_start_after_stop_never_becomes_alive() {
        let _guard = SERIAL.lock().unwrap();
        monitor_start_with(fake_late).unwrap();
        let state = CURRENT.lock().unwrap().clone().unwrap();
        let stopped = std::time::Instant::now();
        monitor_stop();
        assert!(stopped.elapsed() < std::time::Duration::from_millis(5), "stop never joins on the caller");
        assert!(wait(|| state.exited.load(Ordering::Acquire)));
        assert!(!state.alive.load(Ordering::Acquire));
        assert_eq!(monitor_poll_at(1000), MonitorPoll { alive: false, failed: false, foreign: 0, interrupted: 0 });
        assert!(watching().is_none());
    }
    #[test]
    fn an_old_generation_cannot_write_into_a_new_one() {
        let _guard = SERIAL.lock().unwrap();
        monitor_start_with(fake_alive).unwrap();
        assert!(wait(|| monitor_poll_at(1000).alive));
        let old = CURRENT.lock().unwrap().clone().unwrap();
        monitor_start_with(fake_alive).unwrap();
        assert!(old.cancelled.load(Ordering::Acquire));
        // A late callback of the old hooks, and a late report for an old post.
        old.saw(true, HookVerdict::Foreign); old.saw(false, HookVerdict::Foreign); old.interrupted.fetch_add(1, Ordering::Relaxed);
        assert!(wait(|| monitor_poll_at(1000).alive));
        assert_eq!(monitor_poll_at(1000), QUIET, "the new generation is unaffected by the old one");
        assert!(wait(|| old.exited.load(Ordering::Acquire)));
        monitor_stop();
    }
    #[test]
    fn the_person_at_the_computer_is_counted_per_poll_and_our_own_input_is_not() {
        let _guard = SERIAL.lock().unwrap();
        monitor_start_with(fake_alive).unwrap();
        assert!(wait(|| monitor_poll_at(1000).alive));
        let state = watching().unwrap();
        state.saw(true, HookVerdict::Own); state.saw(false, HookVerdict::Own);
        // Not posted through here, so nothing is expected and nothing is missing.
        assert_eq!(monitor_poll_at(1000), QUIET);
        state.saw(true, HookVerdict::Foreign); state.saw(false, HookVerdict::Foreign); state.saw(false, HookVerdict::Foreign);
        assert_eq!(monitor_poll_at(1000), MonitorPoll { foreign: 3, ..QUIET });
        assert_eq!(monitor_poll_at(1000), QUIET, "counts are reported once");
        monitor_stop();
    }
    #[test]
    fn a_hook_thread_that_stops_turning_is_reported_even_though_it_still_exists() {
        let _guard = SERIAL.lock().unwrap();
        monitor_start_with(fake_alive).unwrap();
        assert!(wait(|| monitor_poll_at(1000).alive));
        let state = watching().unwrap();
        assert_eq!(monitor_poll_at(1000 + HOOK_GAP_MS), QUIET);
        assert_eq!(monitor_poll_at(1001 + HOOK_GAP_MS), MonitorPoll { interrupted: 1, ..QUIET }, "seen from the poll while the thread is stuck");
        // The thread itself notices a turn that came too late, once.
        state.turned(2000);
        assert_eq!(monitor_poll_at(2000), MonitorPoll { interrupted: 1, ..QUIET });
        state.turned(2000 + HOOK_GAP_MS);
        assert_eq!(monitor_poll_at(2000 + HOOK_GAP_MS), QUIET);
        monitor_stop();
    }
    #[test]
    fn keyboard_and_mouse_hooks_must_each_see_what_this_process_inserted() {
        let _guard = SERIAL.lock().unwrap();
        for (lost_keyboard, lost_mouse) in [(false, false), (true, false), (false, true)] {
            monitor_start_with(fake_alive).unwrap();
            assert!(wait(|| monitor_poll_at(1000).alive));
            let state = watching().unwrap();
            let mut held = Held::new();
            let inputs = [key_inputs(0x1e, true, false).unwrap(), mouse_inputs(Mouse::Down, Button::Left, (0, 0), DESKTOP, 1).unwrap()].concat();
            // Windows takes the key and the move; the button is refused.
            assert!(submit_with(&mut held, &inputs, Some(&state), 1000, &mut |_| 2).is_err());
            assert_eq!(state.sent_totals(), (1, 1), "only what was inserted is expected");
            state.turned(1200);
            assert_eq!(monitor_poll_at(1000 + HOOK_SETTLE_MS), QUIET, "the hooks get time to report");
            if !lost_keyboard { state.saw(true, HookVerdict::Own); }
            if !lost_mouse { state.saw(false, HookVerdict::Own); }
            state.turned(1400);
            let expected = if lost_keyboard || lost_mouse { MonitorPoll { interrupted: 1, ..QUIET } } else { QUIET };
            assert_eq!(monitor_poll_at(1001 + HOOK_SETTLE_MS), expected, "keyboard lost: {lost_keyboard}, mouse lost: {lost_mouse}");
            // The release is expected by the hooks as well.
            if !lost_keyboard && !lost_mouse {
                release_all_with(&mut held, Some(&state), 1400, &mut |inputs| inputs.len()).unwrap();
                assert_eq!(state.sent_totals().0, 2);
                state.turned(1600);
                assert_eq!(monitor_poll_at(1401 + HOOK_SETTLE_MS), MonitorPoll { interrupted: 1, ..QUIET }, "an up the keyboard hook never saw");
            }
            monitor_stop();
        }
    }
    /// A generation whose hook thread turns every 50 ms; `step(now)` advances it.
    fn turning() -> Arc<MonitorState> {
        monitor_start_with(fake_alive).unwrap();
        assert!(wait(|| monitor_poll_at(1000).alive));
        watching().unwrap()
    }
    #[test]
    fn continuing_input_never_postpones_the_deadline_of_the_oldest_unseen_event() {
        let _guard = SERIAL.lock().unwrap();
        let state = turning(); let mut held = Held::new();
        // 41 key events, one every 50 ms; the keyboard hook sees none of them. The thread keeps turning.
        let mut reported_at = None;
        for index in 0..41u64 {
            let now = 1000 + index * 50;
            state.turned(now);
            let input = key_inputs(0x1e, index % 2 == 0, false).unwrap();
            submit_with(&mut held, &input, Some(&state), now, &mut |inputs| inputs.len()).unwrap();
            if monitor_poll_at(now).interrupted > 0 && reported_at.is_none() { reported_at = Some(now); }
        }
        // The first event went unseen at 1000: it is overdue just after 1300, whatever was sent since.
        assert_eq!(reported_at, Some(1350), "reported at the first poll past the oldest event's limit");
        state.turned(3001);
        assert_eq!(monitor_poll_at(3001), MonitorPoll { interrupted: 1, ..QUIET }, "and at every poll while it stays unseen");
        monitor_stop();
    }
    #[test]
    fn a_healthy_hook_that_answers_late_is_not_reported_however_long_the_stream() {
        let _guard = SERIAL.lock().unwrap();
        let state = turning(); let mut held = Held::new();
        // Every event is seen 200 ms after it was inserted: late, inside the limit, for three seconds.
        let mut seen = 0u64;
        for index in 0..60u64 {
            let now = 1000 + index * 50;
            state.turned(now);
            while seen + 4 <= index { state.saw(true, HookVerdict::Own); seen += 1; }
            submit_with(&mut held, &key_inputs(0x1e, index % 2 == 0, false).unwrap(), Some(&state), now, &mut |inputs| inputs.len()).unwrap();
            assert_eq!(monitor_poll_at(now), QUIET, "at {now}");
        }
        // Once the answers stop, the oldest unanswered event decides: the 57th, inserted at 3800.
        state.turned(4000);
        assert_eq!(monitor_poll_at(3800 + HOOK_SETTLE_MS), QUIET);
        state.turned(4101);
        assert_eq!(monitor_poll_at(3801 + HOOK_SETTLE_MS), MonitorPoll { interrupted: 1, ..QUIET });
        monitor_stop();
    }
    #[test]
    fn input_of_one_kind_does_not_cover_for_the_lost_hook_of_the_other() {
        let _guard = SERIAL.lock().unwrap();
        let state = turning(); let mut held = Held::new();
        // One key goes unseen; then a healthy stream of mouse moves, each seen at once.
        submit_with(&mut held, &key_inputs(0x1e, true, false).unwrap(), Some(&state), 1000, &mut |inputs| inputs.len()).unwrap();
        let mut reported_at = None;
        for index in 1..=20u64 {
            let now = 1000 + index * 50;
            state.turned(now);
            submit_with(&mut held, &mouse_inputs(Mouse::Move, Button::Left, (0, 0), DESKTOP, 1).unwrap(), Some(&state), now, &mut |inputs| inputs.len()).unwrap();
            state.saw(false, HookVerdict::Own);
            if monitor_poll_at(now).interrupted > 0 && reported_at.is_none() { reported_at = Some(now); }
        }
        assert_eq!(reported_at, Some(1350));
        monitor_stop();
    }
    #[test]
    fn a_very_long_unseen_stream_stays_bounded_and_is_never_judged_later_than_the_truth() {
        let mut outstanding = Outstanding::default();
        for index in 0..10_000u64 { outstanding.add(1, 1000 + index); }
        assert_eq!((outstanding.total, outstanding.marks.len()), (10_000, OUTSTANDING_MARKS));
        assert_eq!(outstanding.oldest_unseen(0), Some(1000));
        // Seen up to the folded tail: what is left is dated no later than it was really inserted.
        let folded_from = (OUTSTANDING_MARKS - 1) as u64;
        assert_eq!(outstanding.oldest_unseen(folded_from), Some(1000 + folded_from));
        assert_eq!(outstanding.oldest_unseen(9_999), Some(1000 + folded_from), "conservative for the folded part");
        assert_eq!(outstanding.oldest_unseen(10_000), None);
        outstanding.add(0, 5000);
        assert_eq!(outstanding.oldest_unseen(10_000), None);
    }
}
