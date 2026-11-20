import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import path from 'node:path';

/** Windows only. Windows offers no way to ask "which keys did this process
 * press", so remote control keeps its own record on disk of what it holds: a
 * line is appended BEFORE a key or button is pressed, and another once Windows
 * has taken its up. After a crash the lines add up to what may still be down.
 *
 * The file is only ever appended to, one whole line per press or release:
 *
 *     tarobot-screen-held 1 <login>
 *     +key 29
 *     -key 29
 *     +button left
 *
 * A key is its scan-code descriptor in decimal; a button is the PHYSICAL
 * button that was pressed. What an interrupted append can leave is a last
 * piece without its newline. That piece is a press that was never made (a
 * press waits for its whole line) or a release that was made but not recorded
 * (the input then stays a candidate, which is the safe side), so a reader
 * drops it, but only if it is the beginning of a line this code writes.
 * Anything else that does not read as above, a last piece of something else
 * included, means the file cannot be trusted at all; the reader says so and
 * guesses nothing. */
const HEADER = /^tarobot-screen-held 1 ([A-Za-z0-9_-]{1,128})$/;
const LINE = /^([+-])(key|button) ([a-z0-9]{1,8})$/;
const BUTTONS = new Set(['left', 'right', 'other']);
/** Past this size the file is replaced by a new one the next time nothing is held. */
export const HELD_JOURNAL_COMPACT_BYTES = 64 * 1024;
const MAX_BYTES = 8 * 1024 * 1024;
const valid = (kind, value) => kind === 'key' ? Number.isInteger(value) && value > 0 && value <= 0x17f : kind === 'button' && BUTTONS.has(value);
const HEADER_START = 'tarobot-screen-held 1 ';
/** Whether `piece` (no newline in it) is how the first line of a record begins. */
const headerPiece = piece => piece.length <= HEADER_START.length ? HEADER_START.startsWith(piece) : piece.startsWith(HEADER_START) && /^[A-Za-z0-9_-]{1,128}$/.test(piece.slice(HEADER_START.length));
/** Whether `piece` is how a press or release line begins: `+key 30`, `-button left`, cut anywhere. */
function entryPiece(piece) {
  if (!piece) return true;
  if (piece[0] !== '+' && piece[0] !== '-') return false;
  const rest = piece.slice(1);
  if (rest.length <= 4) return 'key '.startsWith(rest) || 'button '.startsWith(rest);
  if (rest.startsWith('key ')) return /^[1-9][0-9]{0,2}$/.test(rest.slice(4));
  if (rest.length <= 7) return 'button '.startsWith(rest);
  return rest.startsWith('button ') && [...BUTTONS].some(button => button.startsWith(rest.slice(7)));
}

export class HeldJournal {
  // `#residue`: a file of this journal may be on disk, from opening until a removal succeeds.
  #fd; #broken = false; #residue = false; #bytes = 0; #keys = new Set(); #buttons = new Set();
  /** `login()`: the current login session's name, written once per file.
   * `fs`: the synchronous file functions, replaceable in tests. */
  constructor({ file, login = () => 'unknown', fs = { closeSync, mkdirSync, openSync, rmSync, writeSync } }) { Object.assign(this, { file, login, fs }); }
  get size() { return this.#keys.size + this.#buttons.size; }
  get open() { return this.#fd !== undefined; }
  /** Whether `clear()` still has work: an open file, a held input, a file that
   * may be left on disk (a failed removal or open), or a failed append. */
  get pending() { return this.open || this.size > 0 || this.#residue || this.#broken; }
  #set(kind) { return kind === 'key' ? this.#keys : this.#buttons; }
  /** Writes all of `text` or throws. A short write is continued from where it
   * stopped; one that makes no progress is a failure. After a failure the
   * file may end in a piece of a line, so nothing more is ever appended to it. */
  #append(text) {
    if (this.#broken) throw new Error('screen_held_record_failed');
    try {
      if (this.#fd === undefined) {
        this.#residue = true;
        this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
        // Exclusive: a record that is already there belongs to a recovery that has not finished.
        this.#fd = this.fs.openSync(this.file, 'ax', 0o600);
        const login = String(this.login());
        text = `tarobot-screen-held 1 ${/^[A-Za-z0-9_-]{1,128}$/.test(login) ? login : 'unknown'}\n${text}`;
      }
      const bytes = Buffer.from(text);
      for (let offset = 0; offset < bytes.length;) {
        const written = this.fs.writeSync(this.#fd, bytes, offset, bytes.length - offset);
        if (!Number.isInteger(written) || written <= 0 || written > bytes.length - offset) throw new Error('screen_held_record_failed');
        offset += written;
      }
      this.#bytes += bytes.length;
    } catch { this.#broken = true; throw new Error('screen_held_record_failed'); }
  }
  /** Before a press. Throws unless its line is completely written; then nothing may be pressed. */
  add(kind, value) {
    if (!valid(kind, value)) throw new Error('screen_held_record_failed');
    if (this.#set(kind).has(value)) return;
    this.#append(`+${kind} ${value}\n`);
    this.#set(kind).add(value);
  }
  /** After Windows took the up. If this throws, the input stays a candidate
   * and the caller must end the lease. */
  remove(kind, value) {
    if (!this.#set(kind).has(value)) return;
    this.#append(`-${kind} ${value}\n`);
    this.#set(kind).delete(value);
    // Nothing held is the same as no file: a long session does not grow it without bound.
    if (!this.size && this.#bytes > HELD_JOURNAL_COMPACT_BYTES) this.clear();
  }
  /** Nothing is held any more: the record goes. Throws if it cannot be removed;
   * it is then still `pending`, so the caller tries again. */
  clear() {
    this.close();
    this.fs.rmSync(this.file, { force: true });
    this.#keys.clear(); this.#buttons.clear(); this.#broken = false; this.#residue = false; this.#bytes = 0;
  }
  /** Closes the file and leaves it where it is, for the next start to read. */
  close() { if (this.#fd === undefined) return; const fd = this.#fd; this.#fd = undefined; try { this.fs.closeSync(fd); } catch { /* nothing more can be written either way */ } }
}

/** What a record on disk says:
 * `missing`: there is none, so nothing was ever pressed under it.
 * `valid`: `keys` and `buttons` may still be down; `login` names the session they were pressed in.
 * `corrupt`: it cannot be read as a record. Nothing is known; `login` only if its first line was readable. */
export function readHeldJournal(file, read = readFileSync) {
  let text;
  try { text = read(file, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return { state: 'missing' }; throw error; }
  if (text.length > MAX_BYTES) return { state: 'corrupt' };
  const end = text.lastIndexOf('\n'), piece = text.slice(end + 1);
  // No complete line at all. If what is there is how a record begins, the very
  // first append did not finish and nothing was pressed. If it is anything
  // else, this is not a record cut short: it is something unknown.
  if (end < 0) return headerPiece(piece) ? { state: 'valid', keys: [], buttons: [] } : { state: 'corrupt' };
  const lines = text.slice(0, end).split('\n'), header = HEADER.exec(lines[0]);
  if (!header) return { state: 'corrupt' };
  const login = header[1], keys = new Set(), buttons = new Set();
  if (!entryPiece(piece)) return { state: 'corrupt', login };
  for (const line of lines.slice(1)) {
    const entry = LINE.exec(line);
    if (!entry) return { state: 'corrupt', login };
    const [, sign, kind, raw] = entry, value = kind === 'key' ? Number(raw) : raw;
    if (kind === 'key' && String(value) !== raw || !valid(kind, value)) return { state: 'corrupt', login };
    const set = kind === 'key' ? keys : buttons;
    if (sign === '+') set.add(value); else set.delete(value);
  }
  return { state: 'valid', login, keys: [...keys], buttons: [...buttons] };
}
