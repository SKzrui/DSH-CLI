// dcli runner — an interactive, Claude-Code-style driver for the DeepSeek Harness.
//
// Loaded by the `cli` profile as a Cordis plugin (`name: "./runner.js"`), this
// plugin keeps ONE live Agent across many turns in a single process, so the
// session log, tool state, permissions, and the model's request prefix all stay
// warm between messages — real multi-turn continuity, unlike the one-shot
// `headless` profile.
//
// Modes (read from the launcher's cmdlineArgs):
//   dcli                        interactive REPL (offers to resume the last session)
//   dcli "task..."              one-shot: run the task, print the answer, exit
//   dcli -r | --resume          resume the most recent session in this directory
//   dcli -r <id> | --resume <id>  resume a specific session
//   dcli -c | --continue        continue the most recent session, no prompting
//   dcli --list                 list recent sessions in this directory
//   dcli --help | --version
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";

/** Stable Cordis plugin name. */
export const name = "cli-runner";
/** Core services required before a turn can start. */
export const inject = ["agents", "agentDefaultModel", "sessions"];

const VERSION = "0.1.2";

// ---------------------------------------------------------------------------
// Terminal helpers
// ---------------------------------------------------------------------------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
// Reasoning is COLLAPSED by default: only a "● thinking…" marker is shown, and
// the text is collected (viewable with /thinking). Set DCLI_SHOW_REASONING=1
// to stream the full reasoning inline instead.
const streamReasoning = process.env.DCLI_SHOW_REASONING === "1";
const ansi = {
  dim: (s) => `\x1b[2m${s}\x1b[22m`,
  cyan: (s) => `\x1b[36m${s}\x1b[39m`,
  green: (s) => `\x1b[32m${s}\x1b[39m`,
  blue: (s) => `\x1b[94m${s}\x1b[39m`,
  red: (s) => `\x1b[31m${s}\x1b[39m`,
  yellow: (s) => `\x1b[33m${s}\x1b[39m`,
  magenta: (s) => `\x1b[35m${s}\x1b[39m`,
  bold: (s) => `\x1b[1m${s}\x1b[22m`,
  italic: (s) => `\x1b[3m${s}\x1b[23m`,
  strike: (s) => `\x1b[9m${s}\x1b[29m`,
  underline: (s) => `\x1b[4m${s}\x1b[24m`,
  clearLine: "\x1b[2K\r",
  clearScreen: "\x1b[2J\x1b[H",
};
const paint = (fn, s) => (tty ? fn(s) : s);

// ---------------------------------------------------------------------------
// Startup banner — a static blue ASCII whale.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WHALE_BODY = [
  "   ___:____     |\"\\/\"|",
  " ,'        `.    \\  /",
  " |  O        \\___/  |",
  "~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~",
];

const WHALE_SPOUTS = [
  ['        o', '       " "', '      "   "'],
  ['       o o', '      "   "', '       " "'],
  ['      o   o', '     "     "', '      "   "'],
];

const WHALE_LABEL = "  dcli — DeepSeek agent in your terminal";

/** Each frame: spout (3) + body (4) + blank + label = 9 lines. */
const WHALE_FRAMES = WHALE_SPOUTS.map((spout) => [...spout, ...WHALE_BODY, "", WHALE_LABEL]);

function printBanner() {
  for (const line of WHALE_FRAMES[0]) process.stdout.write(paint(ansi.blue, line) + "\n");
}

// ---------------------------------------------------------------------------
// Line editor — raw-mode on TTY, line-based when piped.
// ---------------------------------------------------------------------------
class LineEditor {
  constructor() {
    this._waiter = null; // { resolve, prompt }
    this._lines = []; // pending input lines (piped mode)
    this._line = ""; // current input, may contain "\n" for multi-line pastes
    this._cursorLine = 0; // caret row within _line (raw mode)
    this._cursorCol = 0; // caret column within that row
    this._lastKey = 0; // timestamp of the last key event (paste detection)
    this._inPaste = false; // sticky paste window across chunks
    this._inBracketPaste = false; // inside \x1b[200~…\x1b[201~ (bracketed paste)
    this._dirty = false; // input changed since the last redraw (batch redraws)
    this._enterTimer = null; // pending deferred-Enter timer
    this._enterWasCR = false; // the pending newline was a \r (for CRLF dedupe)
    this._prevWasCR = false;
    this._history = []; // submitted prompt lines (raw mode)
    this._histIdx = -1; // -1 = editing a fresh line, >= 0 = history entry
    this._draft = ""; // the fresh line saved while browsing history
    this._piped = !process.stdin.isTTY;
    if (this._piped) {
      this._pipedBuf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        const parts = this._pipedBuf + chunk;
        const lines = parts.split(/\r?\n/);
        this._pipedBuf = lines.pop(); // trailing partial line (may be "")
        for (const line of lines) this._emit(line);
      });
      process.stdin.on("end", () => {
        if (this._pipedBuf !== "") this._emit(this._pipedBuf);
        this._emit(null); // EOF → clean exit
      });
      process.stdin.resume();
    } else {
      process.stdin.setRawMode(true);
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
      process.stdin.on("data", (chunk) => this._onData(chunk));
      // Bracketed paste: terminals wrap pasted text in \x1b[200~…\x1b[201~,
      // so pasted newlines are unambiguous and never trigger a submit — the
      // input box behaves like the web GUI's (paste, then Enter to send).
      process.stdout.write("\x1b[?2004h");
    }
  }

  // --- multi-line editing helpers (raw mode) --------------------------------
  _parts() {
    return this._line.split("\n");
  }

  _endOfLine() {
    const parts = this._parts();
    this._cursorLine = parts.length - 1;
    this._cursorCol = parts[parts.length - 1].length;
  }

  /** Insert one char at the caret; "\n" splits the line (paste keeps newlines). */
  _insert(ch) {
    const parts = this._parts();
    const line = parts[this._cursorLine] ?? "";
    const col = Math.min(this._cursorCol, line.length);
    if (ch === "\n") {
      parts.splice(this._cursorLine, 1, line.slice(0, col), line.slice(col));
      this._cursorLine += 1;
      this._cursorCol = 0;
    } else {
      parts[this._cursorLine] = line.slice(0, col) + ch + line.slice(col);
      this._cursorCol = col + 1;
    }
    this._line = parts.join("\n");
    this._dirty = true;
  }

  _backspace() {
    const parts = this._parts();
    const line = parts[this._cursorLine] ?? "";
    const col = this._cursorCol;
    if (col > 0) {
      parts[this._cursorLine] = line.slice(0, col - 1) + line.slice(col);
      this._cursorCol = col - 1;
    } else if (this._cursorLine > 0) {
      const prev = parts[this._cursorLine - 1];
      parts.splice(this._cursorLine - 1, 2, prev + line);
      this._cursorLine -= 1;
      this._cursorCol = prev.length;
    } else {
      return;
    }
    this._line = parts.join("\n");
    this._dirty = true;
  }

  _delete() {
    const parts = this._parts();
    const line = parts[this._cursorLine] ?? "";
    const col = Math.min(this._cursorCol, line.length);
    if (col < line.length) {
      parts[this._cursorLine] = line.slice(0, col) + line.slice(col + 1);
    } else if (this._cursorLine < parts.length - 1) {
      parts.splice(this._cursorLine, 2, line + parts[this._cursorLine + 1]);
    } else {
      return;
    }
    this._line = parts.join("\n");
    this._dirty = true;
  }

  _cursorLeft() {
    const parts = this._parts();
    if (this._cursorCol > 0) {
      this._cursorCol -= 1;
    } else if (this._cursorLine > 0) {
      this._cursorLine -= 1;
      this._cursorCol = parts[this._cursorLine].length;
    } else {
      return;
    }
    this._dirty = true;
  }

  _cursorRight() {
    const parts = this._parts();
    const line = parts[this._cursorLine] ?? "";
    if (this._cursorCol < line.length) {
      this._cursorCol += 1;
    } else if (this._cursorLine < parts.length - 1) {
      this._cursorLine += 1;
      this._cursorCol = 0;
    } else {
      return;
    }
    this._dirty = true;
  }

  _cursorUp() {
    if (this._cursorLine > 0) {
      this._cursorLine -= 1;
      this._cursorCol = Math.min(this._cursorCol, (this._parts()[this._cursorLine] ?? "").length);
      this._dirty = true;
    }
  }

  _cursorDown() {
    const parts = this._parts();
    if (this._cursorLine < parts.length - 1) {
      this._cursorLine += 1;
      this._cursorCol = Math.min(this._cursorCol, parts[this._cursorLine].length);
      this._dirty = true;
    }
  }

  _onData(chunk) {
    let prev = this._lastKey;
    // Sticky paste window: once a burst is seen (chars < 40ms apart), stay in
    // paste mode across chunk boundaries until ~150ms of silence, so large
    // pastes that the terminal delivers in chunks still keep their newlines.
    let inPaste = this._inPaste && Date.now() - prev < 150;
    let prevWasCR = this._prevWasCR;
    for (const ch of chunk) {
      const now = Date.now();
      const burst = now - prev < 40;
      prev = now;
      if (burst) inPaste = true;
      if (ch === "\x03") {
        // Ctrl+C
        this._handleInterrupt();
      } else if (ch === "\x04") {
        // Ctrl+D — treat as EOF: interrupt the pending question like Ctrl+C.
        this._handleInterrupt();
      } else if (ch === "\r" || ch === "\n") {
        if (this._waiter === null) {
          // Stray Enter mid-turn: keep the input line empty.
          this._emit("");
        } else if (inPaste || this._inBracketPaste) {
          // Newline inside a paste — literal line break, no submit.
          if (!(ch === "\n" && prevWasCR)) this._insert("\n");
          prevWasCR = ch === "\r";
        } else if (this._enterTimer && ch === "\n" && this._enterWasCR) {
          // Second half of a \r\n pair: the pending \r already covers it.
          prevWasCR = false;
        } else {
          // A newline not clearly part of a paste: defer the decision briefly.
          // If more input follows, it was a paste newline; if silence, it was
          // a manual Enter. This is robust for QuickEdit right-click paste,
          // which types the text line-by-line with small delays.
          this._flushPendingEnter();
          this._enterWasCR = ch === "\r";
          this._enterTimer = setTimeout(() => {
            this._enterTimer = null;
            this._submit();
          }, 150);
        }
      } else if (ch === "\x7f" || ch === "\b") {
        this._flushPendingEnter();
        if (this._waiter !== null) this._backspace();
      } else if (ch === "\x1b") {
        this._flushPendingEnter();
        this._esc = this._waiter !== null ? { kind: null, buf: "" } : null;
      } else if (this._esc) {
        const e = this._esc;
        if (e.kind === null) {
          if (ch === "[") e.kind = "csi";
          else if (ch === "O") e.kind = "ss3";
          else this._esc = null; // lone ESC
        } else if (e.kind === "csi") {
          e.buf += ch;
          const code = ch.codePointAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            this._esc = null;
            this._dispatchEscape(e.buf);
          }
        } else {
          this._esc = null;
          if (ch === "A") this._dispatchEscape("A");
          else if (ch === "B") this._dispatchEscape("B");
        }
      } else if (ch >= " ") {
        this._flushPendingEnter();
        if (this._waiter !== null) this._insert(ch);
      }
    }
    this._lastKey = prev;
    this._inPaste = inPaste;
    this._prevWasCR = prevWasCR;
    if (this._dirty) {
      this._dirty = false;
      this._redraw();
    }
  }

  /** If a newline was deferred and more input arrived, it was a paste newline. */
  _flushPendingEnter() {
    if (this._enterTimer) {
      clearTimeout(this._enterTimer);
      this._enterTimer = null;
      this._insert("\n");
    }
  }

  _submit() {
    const line = this._line;
    this._line = "";
    this._cursorLine = 0;
    this._cursorCol = 0;
    process.stdout.write("\n");
    this._remember(line);
    this._emit(line);
  }

  /** Handle a decoded CSI/SS3 key sequence (payload without the ESC [). */
  _dispatchEscape(seq) {
    switch (seq) {
      case "A": // ↑ — move up a line; on the top line, browse history
        if (this._parts().length > 1) this._cursorUp();
        else this._historyUp();
        break;
      case "B": // ↓ — move down a line; on the last line, history forward
        if (this._parts().length > 1 && this._cursorLine < this._parts().length - 1) this._cursorDown();
        else this._historyDown();
        break;
      case "C": // →
        this._cursorRight();
        break;
      case "D": // ←
        this._cursorLeft();
        break;
      case "H": // Home — start of the current line
        this._cursorCol = 0;
        this._redraw();
        break;
      case "F": // End — end of the current line
        this._cursorCol = (this._parts()[this._cursorLine] ?? "").length;
        this._redraw();
        break;
      case "3~": // Delete — remove the char at the caret
        this._delete();
        break;
      case "200~": // bracketed paste start — all newlines are literal
        this._inBracketPaste = true;
        break;
      case "201~": // bracketed paste end
        this._inBracketPaste = false;
        break;
      default:
        break; // Ctrl+arrows, F-keys, … — ignore
    }
    if (this._dirty) {
      this._dirty = false;
      this._redraw();
    }
  }

  _historyUp() {
    if (this._history.length === 0) return;
    if (this._histIdx === -1) this._draft = this._line;
    if (this._histIdx < this._history.length - 1) {
      this._histIdx += 1;
      this._line = this._history[this._history.length - 1 - this._histIdx];
      this._endOfLine();
      this._redraw();
    }
  }

  _historyDown() {
    if (this._histIdx === -1) return;
    this._histIdx -= 1;
    this._line = this._histIdx === -1 ? this._draft : this._history[this._history.length - 1 - this._histIdx];
    this._endOfLine();
    this._redraw();
  }

  _remember(line) {
    if (!this._rememberEnabled) return; // only the main prompt records history
    if (line === "" || line === this._history[this._history.length - 1]) return;
    this._history.push(line);
    if (this._history.length > 200) this._history.shift();
    this._histIdx = -1;
    this._draft = "";
  }

  _emit(line) {
    const w = this._waiter;
    if (w) {
      this._waiter = null;
      // Piped input: the line arrived while a question was pending — move to a
      // fresh line like Enter would (raw mode already wrote "\n" itself).
      if (this._piped) process.stdout.write("\n");
      w.resolve(line);
    } else if (this._piped) {
      this._lines.push(line);
    } else {
      // Stray Enter while no question is pending (e.g. during a turn with no
      // approval prompt). Re-show the pending prompt so the UI stays intact.
      const pending = this._pendingPrompt;
      if (pending) process.stdout.write("\n" + pending);
    }
  }

  _handleInterrupt() {
    const w = this._waiter;
    if (w) {
      this._waiter = null;
      this._line = "";
      this._cursorLine = 0;
      this._cursorCol = 0;
      process.stdout.write("\n");
      w.resolve(null); // null = interrupted answer
    } else {
      // Nothing pending — treat as a request to exit the process.
      this._onExitRequest?.();
    }
  }

  _rowsFor(parts) {
    const cols = process.stdout.columns || 80;
    let total = 0;
    for (const line of parts) total += Math.max(1, Math.ceil(displayWidth(line) / cols));
    return total;
  }

  _cursorVisualRow() {
    const cols = process.stdout.columns || 80;
    const parts = this._parts();
    let row = 0;
    for (let i = 0; i < this._cursorLine; i++) {
      row += Math.max(1, Math.ceil(displayWidth(parts[i]) / cols));
    }
    const line = parts[this._cursorLine] ?? "";
    row += Math.floor(displayWidth(line.slice(0, this._cursorCol)) / cols);
    return row;
  }

  _cursorVisualCol() {
    const cols = process.stdout.columns || 80;
    const line = this._parts()[this._cursorLine] ?? "";
    return displayWidth(line.slice(0, this._cursorCol)) % cols;
  }

  _redraw() {
    const prompt = this._pendingPrompt ?? "";
    const parts = this._parts();
    const cursorLine = Math.min(this._cursorLine, parts.length - 1);
    const cursorCol = Math.min(this._cursorCol, parts[cursorLine].length);
    const visRow = this._cursorVisualRow();
    const visCol = this._cursorVisualCol();
    const totalRows = this._rowsFor(parts);
    // 1. Move up to the top of the input block (visual rows, wrapping-aware).
    if (visRow > 0) process.stdout.write(`\x1b[${visRow}A`);
    // 2. Go to column 1 and erase everything below (clears stale wrapped rows).
    process.stdout.write("\x1b[1G\x1b[J");
    // 3. Rewrite every line; the terminal handles wrapping.
    for (let i = 0; i < parts.length; i++) {
      if (i === 0) process.stdout.write(prompt);
      process.stdout.write(parts[i]);
      if (i < parts.length - 1) process.stdout.write("\r\n");
    }
    // 4. Cursor is at the end of the last line; move back to the caret row/col.
    const up = totalRows - 1 - visRow;
    if (up > 0) process.stdout.write(`\x1b[${up}A`);
    process.stdout.write(`\x1b[${visCol + 1}G`);
  }

  /** Ask one question; resolves the trimmed line, or null on Ctrl+C. */
  ask(prompt, remember = false) {
    this._pendingPrompt = prompt;
    this._rememberEnabled = remember;
    process.stdout.write(prompt);
    if (this._lines.length > 0) {
      // Piped input: the queued line was already "typed", so move to a fresh
      // line before the answer streams (raw mode does this on Enter).
      process.stdout.write("\n");
      return Promise.resolve(this._lines.shift());
    }
    return new Promise((resolve) => {
      this._waiter = { resolve };
    });
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { mode: "interactive", resume: undefined, continue: false, list: false, config: false, balance: false, configArgs: [], task: undefined, help: false, version: false };
  if (argv[0] === "config") {
    opts.config = true;
    opts.configArgs = argv.slice(1);
    return opts;
  }
  if (argv[0] === "balance") {
    opts.balance = true;
    return opts;
  }
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--version" || a === "-v") opts.version = true;
    else if (a === "--list" || a === "--sessions") opts.list = true;
    else if (a === "--continue" || a === "-c") opts.continue = true;
    else if (a === "--resume" || a === "-r") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        opts.resume = next;
        i++;
      } else {
        opts.resume = true; // bare -r → most recent / picker
      }
    } else rest.push(a);
  }
  if (rest.length > 0) {
    opts.mode = "oneshot";
    opts.task = rest.join(" ");
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`dcli ${VERSION} — DeepSeek Harness agent in your terminal.

Usage:
  dcli                          start an interactive session (offers to resume
                                the most recent session in this directory)
  dcli "task text..."           answer one task and exit (scriptable)
  dcli -r, --resume             resume the most recent session in this directory
  dcli -r <id>, --resume <id>   resume a specific session
  dcli -c, --continue           continue the most recent session, no prompting
  dcli --list                   list recent sessions in this directory
  dcli config                   show / configure API key, endpoint, model
  dcli balance                  show the account balance (from /user/balance)
  dcli "task text..."           answer one task and exit (scriptable)
  dcli --help                   this help
  dcli --version                print the version

Configuration:
  dcli config                           show current configuration
  dcli config set-api-key <key>         store the DeepSeek API key
  dcli config unset-api-key             remove the stored API key
  dcli config set-base-url <url>        set a custom API endpoint (intranet proxy etc.)
  dcli config unset-base-url            reset the endpoint to the default
  dcli config set-model <id> [--provider <p>] [--reasoning off|high|max]
  dcli config list-models [--provider <p>]

Interactive commands:
  /help            show this list
  /sessions        list recent sessions in this directory
  /resume <id>     switch to another session
  /new             start a fresh session
  /apikey <key>    save the DeepSeek API key
  /base-url <url>  set a custom API endpoint (intranet proxy etc.)
  /balance         show the account balance
  /model           show / switch the model (e.g. /model pro, /model flash)
  /reasoning <off|high|max>   set the reasoning effort
  /thinking        show the last turn's reasoning (collapsed by default)
  /session         print the current session id (for --resume)
  /clear           clear the screen
  /quit, /exit     leave (also Ctrl+C at an empty prompt)
`);
}

// ---------------------------------------------------------------------------
// Session discovery — mirrors the JSONL persistence layout:
//   $DSH_HOME/sessions/<project-key>/<session-id>/session.jsonl[.zstd]
// ---------------------------------------------------------------------------
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error("cannot encode an empty project path");
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** Recent sessions for the current working directory, newest first. */
function listSessions() {
  const root = join(resolveDshHome(), "sessions");
  const dir = join(root, projectKey(process.cwd()));
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const sessionDir = join(dir, entry.name);
    let newest = 0;
    try {
      for (const file of readdirSync(sessionDir)) {
        const st = statSync(join(sessionDir, file));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      }
    } catch {
      continue;
    }
    if (newest > 0) sessions.push({ id: entry.name, mtime: newest });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  if (diff < 60000) return `${Math.max(1, Math.floor(diff / 1000))}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function printSessionList(sessions) {
  if (sessions.length === 0) {
    process.stdout.write(paint(ansi.dim, "  no sessions in this directory yet\n"));
    return;
  }
  process.stdout.write(`  Recent sessions in ${process.cwd()}:\n`);
  sessions.slice(0, 10).forEach((s, i) => {
    process.stdout.write(
      `   ${paint(ansi.cyan, String(i + 1))}) ${paint(ansi.dim, s.id)}  (${paint(ansi.dim, timeAgo(s.mtime))})\n`
    );
  });
}

/** Interactive picker for `dcli -r`; resolves to a session id, or undefined for a fresh start. */
async function pickSession(sessions, editor) {
  process.stdout.write(`  Recent sessions in ${process.cwd()}:\n`);
  sessions.slice(0, 10).forEach((s, i) => {
    process.stdout.write(
      `   ${paint(ansi.cyan, String(i + 1))}) ${paint(ansi.dim, s.id)}  (${paint(ansi.dim, timeAgo(s.mtime))})\n`
    );
  });
  process.stdout.write(paint(ansi.dim, "   n) start a new session\n"));
  const answer = await editor.ask(paint(ansi.green, "  Pick [1]: "));
  if (answer === null) return undefined; // Ctrl+C → fresh start
  const a = answer.trim().toLowerCase();
  if (a === "" || a === "1") return sessions[0].id;
  if (a === "n") return undefined;
  const n = parseInt(a, 10);
  if (!Number.isNaN(n) && n >= 1 && n <= sessions.length) return sessions[n - 1].id;
  return sessions[0].id;
}

// ---------------------------------------------------------------------------
// Markdown beautification for streamed assistant text.
// On a TTY (or DCLI_FORMAT=1) tables render as aligned grids, **bold** / *it* /
// `code` / ~~strike~~ / [links](url) get ANSI styling, headings are bold,
// task lists and bullets get pretty markers, blockquotes are dimmed and code
// fences pass through untouched. Piped output stays raw markdown.
// ---------------------------------------------------------------------------
// DCLI_FORMAT=1 forces formatting even when piped; DCLI_FORMAT=0 forces raw.
const formatOutput =
  process.env.DCLI_FORMAT === "1" || (tty && process.env.DCLI_FORMAT !== "0");

const WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u20000-\u2FFFD\u30000-\u3FFFD]/;
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += WIDE_RE.test(ch) ? 2 : 1;
  return w;
}

/** Strip markdown markers + ANSI codes, leaving visible text (for width math). */
function stripMarkup(s) {
  return s
    .replace(/\*\*/g, "")
    .replace(/\*/g, "")
    .replace(/~~/g, "")
    .replace(/`/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\x1b\[[0-9;]*m/g, "");
}

const INLINE_TOKEN_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderToken(tok) {
  if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) return paint(ansi.bold, tok.slice(2, -2));
  if (tok.startsWith("~~") && tok.endsWith("~~") && tok.length > 4) return paint(ansi.strike, tok.slice(2, -2));
  if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) return paint(ansi.dim, tok.slice(1, -1));
  if (tok.startsWith("*") && tok.endsWith("*") && tok.length > 2) return paint(ansi.italic, tok.slice(1, -1));
  const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) return paint(ansi.underline, paint(ansi.cyan, link[1])) + paint(ansi.dim, ` (${link[2]})`);
  return tok;
}

function renderInline(s) {
  if (!formatOutput) return s;
  let out = "";
  let last = 0;
  for (const m of s.matchAll(INLINE_TOKEN_RE)) {
    out += s.slice(last, m.index);
    out += renderToken(m[0]);
    last = m.index + m[0].length;
  }
  out += s.slice(last);
  return out;
}

/** Format one complete (non-table, non-fence) line. */
function formatLine(line) {
  if (!formatOutput) return line;
  const heading = line.match(/^(#{1,6})\s+(.*)$/);
  if (heading) {
    const text = renderInline(heading[2]);
    const level = heading[1].length;
    if (level === 1) return paint(ansi.magenta, "H1 ") + paint(ansi.bold, paint(ansi.magenta, text));
    if (level === 2) return paint(ansi.blue, "H2 ") + paint(ansi.bold, paint(ansi.blue, text));
    if (level === 3) return paint(ansi.cyan, "H3 ") + paint(ansi.bold, text);
    return paint(ansi.bold, text);
  }
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    const width = Math.min(process.stdout.columns ?? 80, 60);
    return paint(ansi.dim, "─".repeat(width));
  }
  const task = line.match(/^(\s{0,3})[-*]\s+\[( |x|X)\]\s+(.*)$/);
  if (task) {
    const mark = task[2].toLowerCase() === "x" ? paint(ansi.green, "☑") : paint(ansi.dim, "☐");
    return `${task[1]}${mark} ${renderInline(task[3])}`;
  }
  const bullet = line.match(/^(\s{0,3})[-*]\s+(.*)$/);
  if (bullet) return `${bullet[1]}${paint(ansi.dim, "•")} ${renderInline(bullet[2])}`;
  const quote = line.match(/^(\s*)>\s?(.*)$/);
  if (quote) return `${quote[1]}${paint(ansi.dim, "│ ")}${renderInline(quote[2])}`;
  return renderInline(line);
}

// --- table detection / rendering ------------------------------------------
const PIPE_LINE_RE = /^\s*\|.*\|\s*$/;
const SEP_LINE_RE = /^\s*\|[\s:|-]+\|\s*$/;

function splitCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

// ---------------------------------------------------------------------------
// Session-event rendering (interactive mode)
// ---------------------------------------------------------------------------
function makeRenderer() {
  let streamedAny = false;
  let activeType = null; // 'reasoning' | 'text' | null — the block streaming now
  let lastChar = "";
  // Line assembler: text deltas accumulate here and are emitted line by line,
  // which is what lets tables (multi-line blocks) and inline markdown be
  // beautified without breaking the streaming feel.
  let lineBuf = "";
  let pendingHeader = null; // possible table header, awaiting its separator
  let table = null; // { header: string[], rows: string[][] }
  let inCode = false; // inside a ``` fence → pass through raw
  let reasoningBuf = ""; // collected reasoning (viewable with /thinking)
  let reasoningChars = 0; // collapsed-reasoning length for the summary line
  let lastReasoning = ""; // the most recent completed reasoning block

  const write = (s) => {
    if (s.length > 0) {
      process.stdout.write(s);
      lastChar = s[s.length - 1];
    }
  };
  const atLineStart = () => lastChar === "" || lastChar === "\n";

  const renderTable = () => {
    if (!table) return;
    const { header, rows } = table;
    const cols = Math.max(header.length, ...rows.map((r) => r.length));
    const widths = Array(cols).fill(0);
    for (const row of [header, ...rows]) {
      for (let c = 0; c < cols; c++) {
        const cell = (row[c] ?? "").trim();
        widths[c] = Math.max(widths[c], displayWidth(stripMarkup(cell)));
      }
    }
    const border = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
    const cellLine = (cells, bold) =>
      "│ " +
      Array.from({ length: cols }, (_, c) => {
        const cell = (cells[c] ?? "").trim();
        const styled = bold ? paint(ansi.bold, renderInline(cell)) : renderInline(cell);
        return styled + " ".repeat(widths[c] - displayWidth(stripMarkup(cell)));
      }).join(" │ ") +
      " │";
    write(border("┌", "┬", "┐") + "\n");
    write(cellLine(header, true) + "\n");
    write(border("├", "┼", "┤") + "\n");
    for (const row of rows) write(cellLine(row) + "\n");
    write(border("└", "┴", "┘") + "\n");
    table = null;
  };

  const writeFormattedLine = (line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      if (!formatOutput) {
        write(line + "\n");
      } else if (inCode) {
        // Fence opener — dim backticks plus a highlighted language tag.
        const lang = line.trim().replace(/^(```|~~~)/, "");
        write(paint(ansi.dim, "```") + (lang !== "" ? " " + paint(ansi.cyan, lang) : "") + "\n");
      } else {
        write(paint(ansi.dim, "```") + "\n");
      }
      return;
    }
    write((inCode ? line : formatLine(line)) + "\n");
  };

  const processLine = (line) => {
    if (inCode) {
      // Inside a code fence: pass through verbatim (fence toggle included).
      writeFormattedLine(line);
      return;
    }
    if (table !== null && line.trim() === "") {
      renderTable();
      write("\n");
      return;
    }
    if (formatOutput && pendingHeader !== null) {
      if (SEP_LINE_RE.test(line)) {
        table = { header: splitCells(pendingHeader), rows: [] };
        pendingHeader = null;
        return; // separator line is consumed
      }
      writeFormattedLine(pendingHeader);
      pendingHeader = null;
    }
    if (formatOutput && table !== null) {
      if (PIPE_LINE_RE.test(line)) {
        table.rows.push(splitCells(line));
        return;
      }
      renderTable();
    }
    if (formatOutput && PIPE_LINE_RE.test(line) && !SEP_LINE_RE.test(line)) {
      pendingHeader = line; // possible header; confirm on the next line
      return;
    }
    writeFormattedLine(line);
  };

  const feed = (text) => {
    lineBuf += text;
    let idx;
    while ((idx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, idx);
      lineBuf = lineBuf.slice(idx + 1);
      processLine(line);
    }
  };

  const feedFlush = () => {
    if (lineBuf !== "") {
      processLine(lineBuf);
      lineBuf = "";
    }
    if (pendingHeader !== null) {
      writeFormattedLine(pendingHeader);
      pendingHeader = null;
    }
    renderTable();
    if (inCode) {
      inCode = false;
    }
  };

  // Keep reasoning and answer on their own lines: every block transition
  // starts on a fresh line instead of gluing the two together.
  const enterBlock = (type) => {
    if (activeType !== type) {
      if (activeType === "text") feedFlush();
      if (activeType !== null && !atLineStart()) write("\n");
      if (type === "reasoning") {
        // Start a new collapsed thinking block.
        reasoningBuf = "";
        reasoningChars = 0;
        if (tty || streamReasoning) write(paint(ansi.dim, "  ● thinking…") + "\n");
      }
      activeType = type;
    }
  };

  return {
    event(session, event) {
      const d = event.data;
      switch (event.type) {
        case "assistant/chunk": {
          const chunk = d.chunk;
          if (chunk.type === "block-start") {
            if (chunk.blockType === "reasoning" || chunk.blockType === "text") {
              enterBlock(chunk.blockType);
            }
          } else if (chunk.type === "text-delta") {
            enterBlock("text");
            streamedAny = true;
            feed(chunk.text);
          } else if (chunk.type === "reasoning-delta") {
            enterBlock("reasoning");
            reasoningBuf += chunk.text;
            reasoningChars += chunk.text.length;
            if (streamReasoning) {
              streamedAny = true;
              write(paint(ansi.dim, chunk.text));
            }
          }
          break;
        }
        case "tool/call": {
          if (!atLineStart()) write("\n");
          const icon = TOOL_ICONS[d.name] ?? "🔧";
          write(
            `  ${icon} ${paint(ansi.cyan, d.name)}${paint(ansi.dim, " " + previewToolCall(d.name, d.arguments) + "\n")}`
          );
          activeType = null;
          break;
        }
        case "tool/result": {
          if (d.error) {
            write(paint(ansi.red, `  ✘ ${d.error.name}: ${d.error.code}\n`));
          } else {
            write(paint(ansi.green, "  ✓ ") + paint(ansi.dim, "done\n"));
          }
          break;
        }
        case "todo/write": {
          break;
        }
        case "turn/end": {
          const kind = d.reason?.kind;
          if (kind === "error") {
            write(paint(ansi.red, `\n  ⚠ turn failed: ${d.reason.error?.message ?? "unknown error"}\n`));
          } else if (kind === "max-tokens") {
            write(paint(ansi.yellow, "\n  ⚠ hit the output-token ceiling\n"));
          } else if (kind === "aborted") {
            write(paint(ansi.yellow, "\n  ⏹ interrupted\n"));
          }
          // Collapse reasoning: one summary line instead of the wall of text.
          if (reasoningBuf !== "") lastReasoning = reasoningBuf;
          if (!streamReasoning && reasoningChars > 0 && tty) {
            write(paint(ansi.dim, `  · thinking ${reasoningChars} chars (use /thinking or DCLI_SHOW_REASONING=1 to view)\n`));
          }
          feedFlush();
          break;
        }
        case "assistant/message": {
          // Safety net: if no chunk streamed (e.g. non-streaming adapter),
          // feed the assembled text blocks through the same formatter.
          if (!streamedAny) {
            const text = d.message.content
              .filter((b) => b.type === "text")
              .map((b) => b.text)
              .join("");
            if (text !== "") {
              feed(text);
            }
          }
          feedFlush();
          break;
        }
        default:
          break;
      }
    },
    resetStep() {
      streamedAny = false;
      activeType = null;
      lastChar = "";
      lineBuf = "";
      pendingHeader = null;
      table = null;
      inCode = false;
      reasoningBuf = "";
      reasoningChars = 0;
    },
    lastReasoning() {
      return lastReasoning;
    },
  };
}

function previewArgs(raw) {
  const s = raw.replace(/\s+/g, " ").trim();
  return s.length > 120 ? s.slice(0, 117) + "…" : s;
}

// Claude-Code-style tool badges: an icon per tool family, plus a friendly
// one-line summary (file paths, commands, patterns) instead of raw JSON.
const TOOL_ICONS = {
  write: "✏",
  edit: "✏",
  str_replace_editor: "✏",
  read: "📖",
  glob: "🔍",
  grep: "🔍",
  pwsh: "💻",
  bash: "💻",
  web_search: "🌐",
  web: "🌐",
  subagent: "🤖",
  subagent_fork: "🤖",
  workflow: "🤖",
  skill: "🧠",
  todo_write: "📋",
  ask_user_question: "❓",
};

function previewToolCall(name, rawArgs) {
  let args;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return previewArgs(rawArgs);
  }
  if (args === null || typeof args !== "object") return previewArgs(rawArgs);
  const first = (...keys) => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === "string" && v.trim() !== "") return v.trim();
    }
    return undefined;
  };
  const file = first("file_path", "path");
  const cmd = first("command", "cmd");
  const pattern = first("pattern", "query", "glob");
  const url = first("url");
  const target = file ?? cmd ?? pattern ?? url;
  if (target !== undefined) return target.length > 120 ? target.slice(0, 117) + "…" : target;
  return previewArgs(rawArgs);
}

// ---------------------------------------------------------------------------
// Configuration: `dcli config` — API key + model selection.
// Uses the same services the web Models page writes through, so a change here
// takes effect immediately (and is visible in the web GUI too).
// ---------------------------------------------------------------------------
const API_KEY_REF = "DEEPSEEK_API_KEY";
const REASONING_EFFORTS = ["off", "high", "max"];
const LLM_DEEPSEEK_NS = settingsNamespace("llm-deepseek");
const DEFAULT_BASE_URL = "https://api.deepseek.com";

function parseConfigArgs(args) {
  const cmd = args[0] ?? "show";
  const opts = { provider: undefined, reasoning: undefined, help: false };
  const positionals = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--provider") opts.provider = args[++i];
    else if (a === "--reasoning") opts.reasoning = args[++i];
    else if (a === "--help" || a === "-h") opts.help = true;
    else positionals.push(a);
  }
  return { cmd, opts, positionals };
}

function printConfigHelp() {
  process.stdout.write(`dcli config — API key / endpoint / model configuration.

Usage:
  dcli config                          show current configuration
  dcli config set-api-key <key>        store the DeepSeek API key
  dcli config unset-api-key            remove the stored API key
  dcli config set-base-url <url>       set a custom API endpoint (intranet proxy etc.)
  dcli config unset-base-url           reset the endpoint to the default
  dcli config set-model <id> [--provider <p>] [--reasoning off|high|max]
  dcli config list-models [--provider <p>]
`);
}

async function runConfig(services, args) {
  const { credentials, agentDefaultModel, llm, settings } = services;
  const { cmd, opts, positionals } = parseConfigArgs(args);
  if (opts.help) {
    printConfigHelp();
    return 0;
  }
  const provider = opts.provider ?? agentDefaultModel.currentSelection().provider;

  const effectiveBaseUrl = () => {
    let resolved;
    try {
      resolved = settings?.get(LLM_DEEPSEEK_NS);
    } catch {}
    return (
      resolved?.baseURL ??
      process.env.DEEPSEEK_BASE_URL ??
      DEFAULT_BASE_URL
    );
  };

  switch (cmd) {
    case "show": {
      const sel = agentDefaultModel.currentSelection();
      const info = await credentials.describe(credentialRef(API_KEY_REF));
      process.stdout.write(paint(ansi.bold, "Configuration") + "\n");
      process.stdout.write(`  provider:  ${sel.provider}\n`);
      process.stdout.write(`  model:     ${sel.model}\n`);
      if (sel.reasoningEffort) process.stdout.write(`  reasoning: ${sel.reasoningEffort}\n`);
      const keyState = info.configured
        ? `configured (source: ${info.source})` + (info.writable ? "" : ", not writable — env shadows the file")
        : "not configured";
      process.stdout.write(`  api key:   ${keyState}\n`);
      process.stdout.write(`  base url:  ${effectiveBaseUrl()}\n`);
      process.stdout.write(`  credentials file: ${join(resolveDshHome(), ".credentials.yaml")}\n`);
      process.stdout.write(`  settings file:    ${join(resolveDshHome(), "settings.yaml")}\n`);
      return 0;
    }
    case "set-base-url": {
      const url = positionals[0];
      if (!url) {
        process.stdout.write(paint(ansi.red, "  ✘ usage: dcli config set-base-url <url>\n"));
        return 1;
      }
      try {
        await settings.update(LLM_DEEPSEEK_NS, { baseURL: url });
        process.stdout.write(paint(ansi.green, `  ✓ base URL set: ${url}\n`));
        return 0;
      } catch (error) {
        process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "unset-base-url": {
      try {
        await settings.replace(LLM_DEEPSEEK_NS, {});
        process.stdout.write(
          paint(ansi.green, `  ✓ base URL reset to ${process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL}\n`)
        );
        return 0;
      } catch (error) {
        process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "set-api-key": {
      const key = positionals[0];
      if (!key) {
        process.stdout.write(paint(ansi.red, "  ✘ usage: dcli config set-api-key <key>\n"));
        return 1;
      }
      try {
        await credentials.set(credentialRef(API_KEY_REF), key);
        process.stdout.write(paint(ansi.green, "  ✓ API key saved\n"));
        return 0;
      } catch (error) {
        process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "unset-api-key": {
      try {
        await credentials.unset(credentialRef(API_KEY_REF));
        process.stdout.write(paint(ansi.green, "  ✓ API key removed\n"));
        return 0;
      } catch (error) {
        process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "list-models": {
      try {
        const models = await llm.listModels(provider);
        if (models.length === 0) {
          process.stdout.write(paint(ansi.dim, `  no models advertised by ${provider}\n`));
          return 0;
        }
        process.stdout.write(`Available models (${provider}):\n`);
        for (const m of models) {
          const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
          process.stdout.write(`  ${paint(ansi.cyan, m.id)}${paint(ansi.dim, name)}\n`);
        }
        return 0;
      } catch (error) {
        process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "set-model": {
      const model = positionals[0];
      if (!model) {
        process.stdout.write(paint(ansi.red, "  ✘ usage: dcli config set-model <id> [--provider <p>] [--reasoning off|high|max]\n"));
        return 1;
      }
      if (opts.reasoning !== undefined && !REASONING_EFFORTS.includes(opts.reasoning)) {
        process.stdout.write(paint(ansi.red, `  ✘ reasoning must be one of: ${REASONING_EFFORTS.join(", ")}\n`));
        return 1;
      }
      let known = false;
      try {
        const models = await llm.listModels(provider);
        known = models.some((m) => m.id === model);
      } catch {}
      if (!known) {
        process.stdout.write(
          paint(ansi.yellow, `  ⚠ "${model}" is not in the ${provider} catalog; saving anyway (see: dcli config list-models)\n`)
        );
      }
      const next = { provider, model };
      if (opts.reasoning !== undefined) next.reasoningEffort = opts.reasoning;
      else if (agentDefaultModel.currentSelection().reasoningEffort) {
        next.reasoningEffort = agentDefaultModel.currentSelection().reasoningEffort;
      }
      try {
        await agentDefaultModel.saveSelection(next);
        const effort = opts.reasoning !== undefined ? ` (reasoning: ${opts.reasoning})` : "";
        process.stdout.write(paint(ansi.green, `  ✓ model set: ${provider}/${model}${effort}\n`));
        return 0;
      } catch (error) {
        process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    default:
      process.stdout.write(paint(ansi.yellow, `  ✘ unknown config command: ${cmd}\n`));
      printConfigHelp();
      return 1;
  }
}

// ---------------------------------------------------------------------------
// Balance: read the account balance from the API's /user/balance endpoint.
// ---------------------------------------------------------------------------
function renderBalance(data) {
  const infos = Array.isArray(data?.balance_infos) ? data.balance_infos : [];
  const available = data?.is_available === true;
  process.stdout.write(
    paint(ansi.bold, "Balance") + "  " + (available ? paint(ansi.green, "✓ available") : paint(ansi.red, "✗ unavailable")) + "\n"
  );
  if (infos.length === 0) {
    process.stdout.write(paint(ansi.dim, "  no balance info\n"));
    return;
  }
  for (const b of infos) {
    const total = b.total_balance ?? "?";
    const topped = b.topped_up_balance ?? "0.00";
    const granted = b.granted_balance ?? "0.00";
    process.stdout.write(
      `  ${paint(ansi.cyan, b.currency ?? "?")}  总余额 ${paint(ansi.bold, total)}  (充值 ${topped} / 赠送 ${granted})\n`
    );
  }
}

async function fetchBalance(credentials, settings) {
  const cred = await credentials.resolve(credentialRef(API_KEY_REF)).catch(() => undefined);
  const key = cred?.value ?? process.env.DEEPSEEK_API_KEY;
  if (!key) {
    process.stdout.write(paint(ansi.yellow, "  no API key configured — run: dcli config set-api-key <key>\n"));
    return 1;
  }
  let resolved;
  try {
    resolved = settings?.get(LLM_DEEPSEEK_NS);
  } catch {}
  const base = resolved?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
  const url = base.replace(/\/+$/, "") + "/user/balance";
  let res;
  try {
    res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
  } catch (error) {
    process.stdout.write(paint(ansi.red, `  ✘ cannot reach ${url}: ${error?.message ?? error}\n`));
    return 1;
  }
  if (res.status === 404) {
    process.stdout.write(paint(ansi.yellow, `  ✘ this endpoint does not expose /user/balance (custom base url?)\n`));
    return 1;
  }
  if (!res.ok) {
    process.stdout.write(paint(ansi.red, `  ✘ HTTP ${res.status}\n`));
    return 1;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    process.stdout.write(paint(ansi.red, "  ✘ invalid response\n"));
    return 1;
  }
  renderBalance(data);
  return 0;
}

// ---------------------------------------------------------------------------
// Core driver
// ---------------------------------------------------------------------------
async function run(ctx, opts, exit) {
  await ctx.get("loader")?.await();
  const agents = ctx.get("agents");
  const defaultModel = ctx.get("agentDefaultModel");
  const sessions = ctx.get("sessions");
  const credentials = ctx.get("credentials");
  const llm = ctx.get("llm");
  const settings = ctx.get("settings");
  if (agents === undefined || defaultModel === undefined || sessions === undefined) {
    throw new Error("cli-runner: agents / agentDefaultModel / sessions services missing");
  }
  const selection = defaultModel.currentSelection();

  // ---- config mode --------------------------------------------------------
  if (opts.config) {
    const code = await runConfig(
      {
        credentials: ctx.get("credentials"),
        agentDefaultModel: defaultModel,
        llm: ctx.get("llm"),
        settings: ctx.get("settings"),
      },
      opts.configArgs
    );
    exit(code);
    return;
  }

  // ---- balance mode -------------------------------------------------------
  if (opts.balance) {
    const code = await fetchBalance(ctx.get("credentials"), ctx.get("settings"));
    exit(code);
    return;
  }

  const editor = new LineEditor();
  const renderer = makeRenderer();
  let handle = null; // { agent, dispose }
  let liveSelection = null; // mutable {current, assembled} ref for the live agent
  let busy = false;
  let quitting = false;
  let cancelSent = false;

  const modelDesc = `${selection.provider}/${selection.model}`;

  // Re-read the live default selection on every agent start, so `/model` and
  // `/reasoning` are picked up by newly created agents too.
  const makeOptions = () => {
    const s = defaultModel.currentSelection();
    return { provider: s.provider, model: s.model };
  };

  const wire = (agent, selectionRef) => {
    liveSelection = selectionRef;
    agent.ctx.on("session/event", (session, event) => {
      if (session === agent.session) renderer.event(session, event);
    });
    agent.ctx.on("approval/request", async (req) => {
      const toolName = req.toolName ?? "tool";
      const reason = req.reason ? ` (${req.reason})` : "";
      const answer = await editor.ask(
        paint(ansi.yellow, "  ⚠ Allow") + ` ${paint(ansi.cyan, toolName)}${reason}? ` + paint(ansi.dim, "[y/N] ")
      );
      if (answer === null) return "rejected"; // Ctrl+C denies
      const a = answer.trim().toLowerCase();
      return a === "y" || a === "yes" ? "allowed-once" : "rejected";
    });
  };

  const startAgent = async (sessionId, resumeId) => {
    if (handle) {
      try {
        await Promise.race([handle.dispose(), sleep(2000)]);
      } catch {}
    }
    // One mutable selection ref per agent: prompt assembly and request routing
    // read it on every step, so mutating `current` switches the model live —
    // no restart needed (see installModelSelection).
    const selectionRef = { current: defaultModel.currentSelection(), assembled: undefined };
    const created = resumeId
      ? await agents.resume({
          resumeSessionId: SessionId(resumeId),
          agentOptions: makeOptions(),
          setup: (agentCtx) => {
            installModelSelection(agentCtx, selectionRef);
          },
        })
      : await agents.create({
          sessionId,
          meta: { cwd: process.cwd() },
          agentOptions: makeOptions(),
          setup: (agentCtx) => {
            installModelSelection(agentCtx, selectionRef);
          },
        });
    handle = created;
    wire(created.agent, selectionRef);
    await created.agent.whenIdle();
    return created.agent;
  };

  const submit = async (agent, text) => {
    busy = true;
    cancelSent = false;
    renderer.resetStep();
    agent.followup(
      createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "user" },
      })
    );
    try {
      await agent.whenIdle();
    } finally {
      busy = false;
    }
    await sessions.flush(agent.session);
  };

  const shutdown = async () => {
    if (handle) {
      const agent = handle.agent;
      // Never let a hung flush/dispose trap the user at a dead prompt: race
      // each teardown step against a short timeout.
      try {
        await Promise.race([sessions.flush(agent.session), sleep(2000)]);
      } catch {}
      try {
        await Promise.race([handle.dispose(), sleep(2000)]);
      } catch {}
      handle = null;
    }
  };

  // Restore the terminal so a leftover raw-mode stdin can't leave the shell
  // in a weird state.
  const restoreTerminal = () => {
    try {
      if (process.stdin.isTTY) process.stdout.write("\x1b[?2004l"); // disable bracketed paste
      if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {}
  };

  // The one exit path: restore the terminal, request the graceful app exit,
  // and keep a last-resort kill so the process can never stay alive forever.
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    restoreTerminal();
    try {
      exit(code);
    } catch {}
    setTimeout(() => process.exit(code), 8000).unref();
  };

  editor._onExitRequest = async () => {
    if (quitting) {
      // Already tearing down but stuck — force it on the next Ctrl+C.
      process.stdout.write(paint(ansi.yellow, "\n  ⏹ force exit\n"));
      finish(130);
      return;
    }
    if (busy) {
      if (!cancelSent) {
        // First Ctrl+C during a turn: cancel the live turn.
        cancelSent = true;
        process.stdout.write(paint(ansi.yellow, "\n  ⏹ cancelling…\n"));
        try {
          handle?.agent.cancel({ kind: "user" });
        } catch {}
        return;
      }
      // Second Ctrl+C during a turn: force quit.
      process.stdout.write(paint(ansi.yellow, "\n  ⏹ force exit\n"));
      finish(130);
      return;
    }
    quitting = true;
    process.stdout.write("\n");
    await shutdown();
    finish(0);
  };

  // ---- resolve a session to resume, if any --------------------------------
  if (opts.list) {
    printSessionList(listSessions());
    finish(0);
    return;
  }
  let resumeTarget = undefined;
  let skipResumePrompt = false;
  if (typeof opts.resume === "string") {
    resumeTarget = opts.resume;
    skipResumePrompt = true;
  } else if (opts.resume === true || opts.continue) {
    skipResumePrompt = true;
    const sessions = listSessions();
    if (sessions.length === 0) {
      process.stdout.write(paint(ansi.yellow, "  no previous sessions in this directory; starting fresh\n"));
    } else if (opts.continue || !process.stdin.isTTY) {
      resumeTarget = sessions[0].id;
    } else {
      resumeTarget = (await pickSession(sessions, editor)) ?? undefined;
    }
  }
  if (resumeTarget === undefined && !skipResumePrompt && process.stdin.isTTY) {
    // Fresh start, but there is a previous conversation here — offer to resume.
    const sessions = listSessions();
    if (sessions.length > 0) {
      const latest = sessions[0];
      const answer = await editor.ask(
        paint(ansi.yellow, `  Resume previous session (${latest.id}, ${timeAgo(latest.mtime)})? `) +
          paint(ansi.dim, "[y/N] ")
      );
      if (answer !== null && /^y(es)?$/i.test(answer.trim())) resumeTarget = latest.id;
    }
  }

  // ---- one-shot mode -----------------------------------------------------
  if (opts.mode === "oneshot") {
    const agent = resumeTarget
      ? await startAgent(undefined, resumeTarget)
      : await startAgent(SessionId(`session-${randomUUID()}`), undefined);
    await submit(agent, opts.task);
    // Exit code follows the final turn outcome (mirrors dsh headless).
    const last = [...agent.session.events].reverse().find((e) => e.type === "turn/end");
    await shutdown();
    finish(last?.data?.reason?.kind === "completed" ? 0 : 1);
    return;
  }

  // ---- resume / fresh interactive ----------------------------------------
  if (resumeTarget !== undefined) {
    try {
      const agent = await startAgent(undefined, resumeTarget);
      process.stdout.write("\n");
      printBanner();
      process.stdout.write(
        `\n${paint(ansi.green, "▶ resumed")} ${paint(ansi.dim, resumeTarget)} (${paint(ansi.dim, modelDesc)})\n\n`
      );
      await interactiveLoop(agent);
      await shutdown();
      finish(0);
      return;
    } catch (error) {
      process.stdout.write(paint(ansi.red, `\n  ✘ cannot resume ${resumeTarget}: ${error?.message ?? error}\n`));
      await shutdown();
      finish(1);
      return;
    }
  }

  // ---- fresh interactive --------------------------------------------------
  const agent = await startAgent(SessionId(`session-${randomUUID()}`), undefined);
  process.stdout.write("\n");
  printBanner();
  process.stdout.write(
    `\n${paint(ansi.bold, "dcli")} ${paint(ansi.dim, VERSION)} — ${paint(ansi.dim, modelDesc)}\n` +
      `${paint(ansi.dim, "cwd: " + process.cwd())}\n` +
      `${paint(ansi.dim, "session: " + agent.session.id + "  (resume with: dcli --resume " + agent.session.id + ")")}\n` +
      `${paint(ansi.dim, "type /help for commands, Ctrl+C to interrupt or exit")}\n\n`
  );
  await interactiveLoop(agent);

  // ---- interactive loop ----------------------------------------------------
  async function interactiveLoop(agent) {
    let current = agent;
    while (!quitting) {
      const line = await editor.ask(paint(ansi.green, "❯ "), true);
      if (line === null) break; // Ctrl+C at the prompt
      const text = line.trim();
      if (text === "") continue;

      if (text.startsWith("/")) {
        const [cmd, ...rest] = text.split(/\s+/);
        const arg = rest.join(" ");
        switch (cmd) {
          case "/help":
            printHelp();
            continue;
          case "/quit":
          case "/exit":
            quitting = true;
            break;
          case "/new": {
            process.stdout.write(paint(ansi.dim, "  ↻ new session\n"));
            current = await startAgent(SessionId(`session-${randomUUID()}`), undefined);
            continue;
          }
          case "/sessions": {
            printSessionList(listSessions());
            continue;
          }
          case "/resume": {
            if (arg === "") {
              process.stdout.write(paint(ansi.yellow, "  usage: /resume <session-id> (see /sessions)\n"));
              continue;
            }
            try {
              process.stdout.write(paint(ansi.dim, `  ↻ resuming ${arg}\n`));
              current = await startAgent(undefined, arg);
            } catch (error) {
              process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
            }
            continue;
          }
          case "/session":
            process.stdout.write(paint(ansi.dim, `  ${current.session.id}\n`));
            continue;
          case "/apikey": {
            if (arg === "") {
              process.stdout.write(paint(ansi.yellow, "  usage: /apikey <key>  (also: dcli config set-api-key <key>)\n"));
              continue;
            }
            try {
              await credentials.set(credentialRef(API_KEY_REF), arg);
              process.stdout.write(paint(ansi.green, "  ✓ API key saved\n"));
            } catch (error) {
              process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
            }
            continue;
          }
          case "/base-url": {
            if (arg === "") {
              let resolved;
              try {
                resolved = settings?.get(LLM_DEEPSEEK_NS);
              } catch {}
              process.stdout.write(
                `  base url: ${paint(ansi.cyan, resolved?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL)}\n`
              );
              process.stdout.write(paint(ansi.dim, "  usage: /base-url <url>  (also: dcli config set-base-url <url>)\n"));
              continue;
            }
            try {
              await settings.update(LLM_DEEPSEEK_NS, { baseURL: arg });
              process.stdout.write(paint(ansi.green, `  ✓ base URL set: ${arg} (next message)\n`));
            } catch (error) {
              process.stdout.write(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
            }
            continue;
          }
          case "/balance": {
            await fetchBalance(credentials, settings);
            continue;
          }
          case "/model": {
            const sel = defaultModel.currentSelection();
            if (arg === "") {
              process.stdout.write(
                `  current: ${paint(ansi.cyan, sel.provider + "/" + sel.model)}` +
                  (sel.reasoningEffort ? paint(ansi.dim, ` (reasoning: ${sel.reasoningEffort})`) : "") +
                  "\n"
              );
              let models = [];
              try {
                models = await llm.listModels(sel.provider);
              } catch {}
              if (models.length > 0) {
                process.stdout.write(`  available (${sel.provider}):\n`);
                models.forEach((m, i) => {
                  process.stdout.write(`   ${paint(ansi.cyan, String(i + 1))}) ${paint(ansi.dim, m.id)}\n`);
                });
              }
              process.stdout.write(paint(ansi.dim, "  usage: /model <id>   /reasoning <off|high|max>\n"));
              continue;
            }
            // Resolve the target: exact id, or a unique partial match ("pro" → deepseek-v4-pro).
            let target = arg;
            let known = false;
            try {
              const models = await llm.listModels(sel.provider);
              const exact = models.find((m) => m.id === arg);
              const partial = models.filter(
                (m) => m.id.includes(arg) || (m.name ?? "").toLowerCase().includes(arg.toLowerCase())
              );
              if (exact) {
                target = exact.id;
                known = true;
              } else if (partial.length === 1) {
                target = partial[0].id;
                known = true;
              } else if (partial.length > 1) {
                process.stdout.write(
                  paint(ansi.yellow, `  ✘ "${arg}" matches ${partial.map((m) => m.id).join(", ")} — use the full id\n`)
                );
                continue;
              }
            } catch {}
            if (!known) {
              process.stdout.write(
                paint(ansi.yellow, `  ⚠ "${arg}" is not in the ${sel.provider} catalog; switching anyway\n`)
              );
              target = arg;
            }
            const next = {
              provider: sel.provider,
              model: target,
              ...(sel.reasoningEffort ? { reasoningEffort: sel.reasoningEffort } : {}),
            };
            await defaultModel.saveSelection(next); // persists for future sessions
            if (liveSelection) liveSelection.current = next; // live: applies to the next step
            process.stdout.write(paint(ansi.green, `  ✓ model → ${target} (next message)\n`));
            continue;
          }
          case "/reasoning": {
            if (!REASONING_EFFORTS.includes(arg)) {
              process.stdout.write(paint(ansi.yellow, `  usage: /reasoning <${REASONING_EFFORTS.join("|")}>\n`));
              continue;
            }
            const sel = defaultModel.currentSelection();
            const next = {
              provider: sel.provider,
              model: sel.model,
              reasoningEffort: arg,
            };
            await defaultModel.saveSelection(next); // persists for future sessions
            if (liveSelection) liveSelection.current = next; // live: applies to the next step
            process.stdout.write(paint(ansi.green, `  ✓ reasoning → ${arg} (next message)\n`));
            continue;
          }
          case "/thinking": {
            const reasoning = renderer.lastReasoning();
            if (reasoning) {
              process.stdout.write(paint(ansi.dim, "  ── thinking ──\n"));
              process.stdout.write(paint(ansi.dim, reasoning));
              if (!reasoning.endsWith("\n")) process.stdout.write("\n");
              process.stdout.write(paint(ansi.dim, "  ──────────────\n"));
            } else {
              process.stdout.write(paint(ansi.dim, "  no reasoning recorded for the last turn\n"));
            }
            continue;
          }
          case "/clear":
            if (tty) process.stdout.write(ansi.clearScreen);
            continue;
          default:
            process.stdout.write(paint(ansi.yellow, `  unknown command: ${cmd} (try /help)\n`));
            continue;
        }
        if (quitting) break;
        continue;
      }

      await submit(current, text);
      process.stdout.write("\n");
    }
  }

  await shutdown();
  finish(0);
}

// ---------------------------------------------------------------------------
// Cordis plugin entry
// ---------------------------------------------------------------------------
export function apply(ctx) {
  const exit = ctx.get("appExit");
  if (exit === undefined) {
    throw new Error("cli-runner: the launcher must provide ctx.appExit before the tree mounts");
  }
  const argv = ctx.get("cmdlineArgs")?.get() ?? [];
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    exit(0);
    return;
  }
  if (opts.version) {
    process.stdout.write(VERSION + "\n");
    exit(0);
    return;
  }
  run(ctx, opts, exit).catch((error) => {
    process.stderr.write(`dcli: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
}
