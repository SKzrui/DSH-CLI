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
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { zstdDecompressSync } from "node:zlib";
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

// Keep in sync with package.json (the launcher reports the same version).
const VERSION = "0.2.0";

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
// Startup banner — a static blue ASCII whale with a water splash.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const WHALE_BANNER = [
  "        ooo",
  '       " """',
  '      "   "',
  '   ___:____      "  "|',
  " ,'        \\.     \\//",
  " |  O        \\___/  |",
  "~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~^~",
  "",
  `  dcli v${VERSION} — DeepSeek agent in your terminal`,
];

function printBanner() {
  for (const line of WHALE_BANNER) out(paint(ansi.blue, line) + "\n");
}

// ---------------------------------------------------------------------------
// Split screen — scrollable output region + fixed input footer (TTY only).
// Enabled by default for interactive TTY sessions; set DCLI_SPLIT=0 to fall
// back to the classic streaming layout.
// ---------------------------------------------------------------------------
class SplitScreen {
  constructor() {
    this.active = false;
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this._detectedCols = undefined; // probed window width (buffer may be wider)
    this.pending = ""; // partial output line awaiting its newline
    this.busyLabel = null; // busy indicator: "thinking" or a tool name
    this.busyStart = 0; // when the busy period began (elapsed counter)
    this.busyLastSec = -1; // last displayed seconds (only changed digits redraw)
    this.busyPadLen = undefined; // padding for shrinking second counts
    this._busyTimer = null; // 1s interval refreshing the elapsed counter
    this._onResize = () => {
      this.rows = process.stdout.rows || 24;
      // Never let the console BUFFER width (wider than the window in cmd)
      // clobber the probed window width; shrink only when the buffer shrank.
      this.cols =
        this._detectedCols !== undefined
          ? Math.min(this._detectedCols, process.stdout.columns || 80)
          : process.stdout.columns || 80;
      if (this.active) activeEditor?.drawInput();
    };
  }
  /**
   * Native-scrollback layout: NO scroll region, NO mouse tracking, NO internal
   * scrolling. Output flows as ordinary terminal lines, so the terminal's own
   * scrollback (and the mouse wheel) holds the whole conversation — just like
   * Claude Code and every other CLI. The input box is redrawn at the bottom
   * after every completed output line; thinking shows as a FIXED elapsed-time
   * indicator on the row just above the box (only while the model thinks).
   */
  enter() {
    this.active = true;
    this.pending = "";
    this.busyLabel = null;
    if (activeEditor !== null) activeEditor._lastBoxTop = undefined;
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
    process.stdout.on("resize", this._onResize);
    activeEditor?.drawInput();
  }
  leave() {
    if (!this.active) return;
    this.active = false;
    process.stdout.off("resize", this._onResize);
    process.stdout.write("\x1b[?25h"); // never leave the cursor hidden
    process.stdout.write("\x1b[2J\x1b[H");
  }
  /** Append output; completed lines flow at the bottom, above the input box. */
  write(text) {
    if (!this.active) {
      process.stdout.write(text);
      return;
    }
    this.pending += String(text);
    let idx;
    while ((idx = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, idx);
      this.pending = this.pending.slice(idx + 1);
      this.writeLine(line);
    }
  }
  /** 1-based row of the fixed busy indicator (just above the input box). */
  indicatorRow() {
    return Math.max(1, this.rows - Math.max(1, inputRows()));
  }
  /** Write one complete line, redraw the box (and the indicator if busy). */
  writeLine(line) {
    const rows = this.rows;
    const n = Math.max(1, inputRows());
    const cols = Math.max(1, this.cols);
    const top = rows - n + 1;
    // Clear the WHOLE box region first: the output line is written on the
    // box's last row and then the screen scrolls — any uncleared box row
    // above it (e.g. a wrapped approval prompt) would leak into the output
    // region, one copy per written line.
    for (let r = top; r <= rows; r++) process.stdout.write(`\x1b[${r};1H\x1b[2K`);
    // Manually wrap long lines at the detected width so the terminal never
    // soft-wraps at a wider console-buffer width (cmd: buffer 120, window 80 —
    // anything past the window would be invisible).
    const segments = wrapCell(line, cols);
    process.stdout.write(`\x1b[${rows};1H`);
    process.stdout.write(segments[0] ?? "");
    for (let k = 1; k < segments.length; k++) {
      process.stdout.write("\n");
      process.stdout.write(segments[k]);
    }
    const busy = this.busyLabel !== null;
    // Scroll the box height so the output lands just above the box; while
    // busy, flow one row higher so the indicator row stays free.
    for (let k = 0; k < n + (busy ? 1 : 0) - Math.max(0, segments.length - 1); k++) process.stdout.write("\n");
    activeEditor?.drawInput();
    if (busy) this.updateBusy(true);
  }
  /**
   * Fixed status indicator on the row just above the input box. `label` is
   * "thinking" or a tool name; the elapsed seconds tick every second. Only
   * one indicator shows at a time, and the row is reserved until cleared.
   */
  setBusy(label, startMs) {
    if (!this.active) return;
    if (this.busyLabel === label) return; // same state — keep the start time
    const wasBusy = this.busyLabel !== null;
    this.busyLabel = label;
    this.busyStart = startMs;
    this.busyLastSec = -1;
    this.busyPadLen = undefined;
    if (!wasBusy) {
      process.stdout.write("\x1b[1S"); // scroll the screen up one row
      activeEditor?.drawInput();
    }
    this.updateBusy(true);
    if (this._busyTimer === null) {
      this._busyTimer = setInterval(() => {
        try {
          this.updateBusy();
        } catch {}
      }, 1000);
      this._busyTimer.unref?.();
    }
  }
  clearBusy() {
    if (!this.active || this.busyLabel === null) return;
    this.busyLabel = null;
    process.stdout.write(`\x1b[${this.indicatorRow()};1H\x1b[2K`);
    activeEditor?.drawInput();
    if (this._busyTimer !== null) {
      clearInterval(this._busyTimer);
      this._busyTimer = null;
    }
  }
  /** Redraw the indicator with the current elapsed seconds (only changed digits). */
  updateBusy(force = false) {
    if (!this.active || this.busyLabel === null) return;
    const sec = Math.max(0, Math.floor((Date.now() - this.busyStart) / 1000));
    if (!force && sec === this.busyLastSec) return;
    this.busyLastSec = sec;
    const row = this.indicatorRow();
    const text = `${sec}s`;
    const col = 6 + this.busyLabel.length; // "  ● " + label + " " → seconds
    if (force) {
      process.stdout.write(`\x1b[${row};1H\x1b[2K`);
      process.stdout.write(paint(ansi.dim, paint(ansi.italic, `  ● ${this.busyLabel} ${text}`)));
    } else {
      process.stdout.write(`\x1b[${row};${col}H${text}`);
      if (this.busyPadLen !== undefined && this.busyPadLen > text.length) {
        process.stdout.write(" ".repeat(this.busyPadLen - text.length));
      }
      this.busyPadLen = text.length;
    }
    activeEditor?.focusInput(); // keep the caret parked in the input box
  }
  /** Thinking is just the busy state with label "thinking" (kept for callers). */
  setThinking(on) {
    if (on) this.setBusy("thinking", Date.now());
    else this.clearBusy();
  }
  updateThinking(force = false) {
    this.updateBusy(force);
  }
  focusLost() {} // kept as a no-op for interface compatibility
}

const split = new SplitScreen();
/** The single interactive editor (raw mode), for split-screen row math. */
let activeEditor = null;
/** How many terminal rows the input footer currently needs. */
function inputRows() {
  return activeEditor !== null ? activeEditor.inputRows() : 1;
}
/** Route one output chunk: into the split region when active, else stdout. */
const out = (s) => {
  if (split.active) split.write(s);
  else process.stdout.write(s);
};
/** Move the caret into the input footer (no redraw — for the append fast path). */
function inputFocus() {
  if (!split.active) return;
  process.stdout.write("\x1b[?25h"); // a key arrived — reveal the caret in the box
  if (activeEditor !== null) activeEditor.focusInput();
}

/**
 * Best-effort REAL terminal width. `process.stdout.columns` on Windows is the
 * console BUFFER width, which can be wider than the window (cmd defaults:
 * buffer 120, window 80) — text then wraps outside the visible area and long
 * input looks cut/duplicated. Chain: $DCLI_TERM_COLS override → ANSI size
 * query (CSI 18 t, Windows Terminal / modern terminals) → PowerShell window
 * query (legacy conhost) → undefined (caller falls back to columns).
 */
async function detectTerminalCols() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return undefined;
  if (process.env.DCLI_TERM_COLS) {
    const w = Number(process.env.DCLI_TERM_COLS);
    if (Number.isFinite(w) && w >= 20 && w <= 500) return w;
  }
  // 1) ANSI "report text area size" — fast, no subprocess.
  const viaAnsi = await new Promise((resolve) => {
    let done = false;
    const finish = (w) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      if (!wasRaw) {
        try {
          process.stdin.setRawMode(false);
        } catch {}
      }
      resolve(w);
    };
    const onData = (chunk) => {
      const m = /\x1b\[8;(\d+);(\d+)t/.exec(chunk.toString());
      if (m) finish(Number(m[2]));
    };
    const wasRaw = process.stdin.isRaw;
    const timer = setTimeout(() => finish(undefined), 120);
    try {
      if (!wasRaw) process.stdin.setRawMode(true);
      process.stdin.on("data", onData);
      process.stdout.write("\x1b[18t");
    } catch {
      finish(undefined);
    }
  });
  if (viaAnsi !== undefined) return viaAnsi;
  // 2) Windows legacy conhost: the console window size via PowerShell (the
  // child inherits our console, so [Console]::WindowWidth is the window).
  if (process.platform === "win32") {
    const viaPs = await new Promise((resolve) => {
      let child;
      try {
        child = spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", "Write-Output ([Console]::WindowWidth)"],
          { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
        );
      } catch {
        resolve(undefined);
        return;
      }
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {}
        resolve(undefined);
      }, 1500);
      child.on("close", () => {
        clearTimeout(timer);
        const w = Number(out.trim());
        if (Number.isFinite(w) && w >= 20 && w <= 500) resolve(w);
        else resolve(undefined);
      });
    });
    if (viaPs !== undefined) return viaPs;
  }
  return undefined;
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
    this._lastVisRow = 0; // visual row the caret was left at after the last redraw
    this._lastBoxTop = undefined; // previous footer box top (clear stale rows on shrink)
    this._enterTimer = null; // pending deferred-Enter timer
    this._enterWasCR = false; // the pending newline was a \r (for CRLF dedupe)
    this._prevWasCR = false;
    this._history = []; // submitted prompt lines (raw mode)
    this._histIdx = -1; // -1 = editing a fresh line, >= 0 = history entry
    this._draft = ""; // the fresh line saved while browsing history
    this._piped = !process.stdin.isTTY;
    this._mainPrompt = "❯ "; // the persistent footer prompt (split mode)
    if (!this._piped) activeEditor = this;
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
      this._line = parts.join("\n");
      this._dirty = true;
      return;
    }
    const atEnd = this._cursorLine === parts.length - 1 && col === line.length;
    parts[this._cursorLine] = line.slice(0, col) + ch + line.slice(col);
    this._cursorCol = col + 1;
    this._line = parts.join("\n");
    const fitsFooter =
      !split.active ||
      displayWidth((this._pendingPrompt ?? this._mainPrompt) + this._line) < Math.max(1, split.cols);
    if (atEnd && fitsFooter) {
      // Fast path: caret at the end of the last line — the terminal renders
      // the char in place, so skip the full erase+rewrite (that per-key
      // redraw is what makes typing flicker). Keep the caret's visual row
      // current so the next full redraw still climbs back to the top.
      process.stdout.write(ch);
      this._lastVisRow = this._cursorVisualRow(displayWidth(this._pendingPrompt ?? ""));
    } else {
      this._dirty = true;
    }
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
    // Split mode: the caret always lives in the fixed footer — park it there
    // before any key is processed so appended characters land in the input.
    if (split.active) inputFocus();
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
        // Only bracketed paste makes Enter a literal newline. The sticky
        // paste window must NOT: fast typing (<40ms/char) would flag a lone
        // Enter as a paste newline and swallow the submit — the classic
        // "pressed Enter but nothing happened" bug. QuickEdit pastes still
        // work: their Enter is followed by more input, which the deferred
        // timer below catches within 150ms.
        if (this._inBracketPaste) {
          if (!(ch === "\n" && prevWasCR)) this._insert("\n");
          prevWasCR = ch === "\r";
        } else if (this._waiter === null) {
          // Enter while no question is pending (a turn is running): a
          // non-empty line queues for after the turn; an empty line is a no-op.
          if (this._line.trim() !== "") this._submit();
          else this._emit("");
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
        this._backspace();
      } else if (ch === "\x1b") {
        this._flushPendingEnter();
        this._esc = { kind: null, buf: "" };
      } else if (this._esc) {
        const e = this._esc;
        if (e.kind === null) {
          if (ch === "[") e.kind = "csi";
          else if (ch === "O") e.kind = "ss3";
          else if (ch === "M") e.kind = "x10"; // X10 mouse: ESC M + 3 raw bytes
          else this._esc = null; // lone ESC
        } else if (e.kind === "csi") {
          e.buf += ch;
          const code = ch.codePointAt(0);
          if (code >= 0x40 && code <= 0x7e) {
            this._esc = null;
            this._dispatchEscape(e.buf);
          }
        } else if (e.kind === "x10") {
          // X10 mouse events are not used (mouse tracking is off); swallow the
          // three payload bytes so they never leak into the input text.
          e.buf += ch;
          if (e.buf.length === 3) this._esc = null;
        } else {
          this._esc = null;
          if (ch === "A") this._dispatchEscape("A");
          else if (ch === "B") this._dispatchEscape("B");
        }
      } else if (ch >= " ") {
        this._flushPendingEnter();
        this._insert(ch);
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
    if (split.active) {
      this.drawInput();
    } else {
      process.stdout.write("\n");
    }
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
      if (split.active) {
        this._pendingPrompt = null; // question answered — back to the main prompt
        this._restoreDraft();
        this.drawInput();
      }
    } else if (this._piped) {
      this._lines.push(line);
    } else if (line !== null && line !== "") {
      // Raw mode, no question pending (a turn is running): queue the line —
      // the loop's next ask() delivers it, so typing during a run queues up.
      this._lines.push(line);
    } else if (split.active) {
      this.drawInput();
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
      if (split.active) {
        this._restoreDraft();
        this.drawInput();
      } else {
        process.stdout.write("\n");
      }
      w.resolve(null); // null = interrupted answer
    } else {
      // Nothing pending — treat as a request to exit the process.
      this._onExitRequest?.();
    }
  }

  _rowsFor(parts, promptW = 0) {
    const cols = process.stdout.columns || 80;
    let total = 0;
    for (let i = 0; i < parts.length; i++) {
      total += Math.max(1, Math.ceil((i === 0 ? promptW : 0) + displayWidth(parts[i])) / cols);
    }
    return total;
  }

  _cursorVisualRow(promptW = 0) {
    const cols = split.cols || 80;
    const parts = this._parts();
    let row = 0;
    for (let i = 0; i < this._cursorLine; i++) {
      row += Math.max(1, Math.ceil(((i === 0 ? promptW : 0) + displayWidth(parts[i])) / cols));
    }
    const line = parts[this._cursorLine] ?? "";
    const lead = this._cursorLine === 0 ? promptW : 0;
    row += caretRow(lead, displayWidth(line.slice(0, this._cursorCol)), cols);
    return row;
  }

  _cursorVisualCol(promptW = 0) {
    const cols = split.cols || 80;
    const line = this._parts()[this._cursorLine] ?? "";
    const lead = this._cursorLine === 0 ? promptW : 0;
    return caretCol(lead, displayWidth(line.slice(0, this._cursorCol)), cols);
  }

  // --- split-screen (fixed footer input) -----------------------------------
  /** Terminal rows the current input occupies in the footer (1..rows-2). */
  inputRows() {
    if (!split.active) return 1;
    const cols = Math.max(1, split.cols);
    const prompt = this._pendingPrompt ?? this._mainPrompt;
    const parts = this._line.split("\n");
    let rows = 0;
    for (let i = 0; i < parts.length; i++) {
      // The prompt shares row 0 with the first input line; long lines wrap
      // inside the box, so count the wrapped rows they actually consume.
      const w = displayWidth((i === 0 ? prompt : "") + parts[i]);
      rows += Math.max(1, Math.ceil(w / cols));
    }
    rows = Math.max(1, Math.min(rows, Math.max(1, split.rows - 2)));
    return rows;
  }
  /** Row (1-based) the input footer starts at. */
  footerTop() {
    return Math.max(1, split.rows - this.inputRows() + 1);
  }
  /**
   * Box-relative caret position (0-based row offset from the footer top and
   * 0-based column), accounting for long lines that wrap inside the box.
   */
  _caretBoxPos() {
    const cols = Math.max(1, split.cols);
    const parts = this._parts();
    const caretLine = Math.min(this._cursorLine, Math.max(0, parts.length - 1));
    const prompt = this._pendingPrompt ?? this._mainPrompt;
    let row = 0;
    for (let i = 0; i < caretLine; i++) {
      const w = displayWidth((i === 0 ? prompt : "") + parts[i]);
      row += Math.max(1, Math.ceil(w / cols));
    }
    const lead = caretLine === 0 ? displayWidth(prompt) : 0;
    const w = displayWidth(parts[caretLine].slice(0, this._cursorCol));
    return { row: row + caretRow(lead, w, cols), col: caretCol(lead, w, cols) };
  }
  /** Move the caret to the footer's caret position without redrawing. */
  focusInput() {
    if (!split.active) return;
    split.focusLost();
    const n = this.inputRows();
    const pos = this._caretBoxPos();
    process.stdout.write(`\x1b[${this.footerTop() + Math.min(pos.row, n - 1)};${pos.col + 1}H`);
  }
  /** Redraw the fixed input footer (split mode). */
  drawInput() {
    if (!split.active) return;
    split.focusLost();
    const prompt = this._pendingPrompt ?? this._mainPrompt;
    const parts = this._parts();
    const n = this.inputRows();
    const top = this.footerTop();
    const cols = Math.max(1, split.cols);
    // Clear from the PREVIOUS box top down to the bottom — a shrinking box
    // must never leave stale rows behind (the old "residue" bug).
    const clearFrom = Math.min(this._lastBoxTop ?? top, top);
    for (let r = clearFrom; r <= split.rows; r++) process.stdout.write(`\x1b[${r};1H\x1b[2K`);
    this._lastBoxTop = top;
    // Input segments, manually wrapped at the full width (never let the
    // terminal soft-wrap at a wider console-buffer width).
    let row = 0;
    for (let i = 0; i < parts.length && row < n; i++) {
      const segments = wrapCell((i === 0 ? prompt : "") + parts[i], cols);
      for (let k = 0; k < segments.length && row < n; k++, row++) {
        process.stdout.write(`\x1b[${top + row};1H`);
        process.stdout.write(segments[k]);
      }
    }
    // Place the caret on the row/col it belongs at (wrap-aware).
    const pos = this._caretBoxPos();
    process.stdout.write(`\x1b[${top + Math.min(pos.row, n - 1)};${pos.col + 1}H`);
  }

  _redraw() {
    if (split.active) {
      this.drawInput();
      return;
    }
    const prompt = this._pendingPrompt ?? "";
    const promptW = displayWidth(prompt);
    const parts = this._parts();
    const cursorLine = Math.min(this._cursorLine, parts.length - 1);
    const cursorCol = Math.min(this._cursorCol, parts[cursorLine].length);
    const visRow = this._cursorVisualRow(promptW);
    const visCol = this._cursorVisualCol(promptW);
    const totalRows = this._rowsFor(parts, promptW);
    // 1. Move up to the top of the input block. The cursor is still where the
    //    previous redraw left it, so climb by THAT row — using the new caret
    //    row would climb one line too far at every wrap boundary.
    if (this._lastVisRow > 0) process.stdout.write(`\x1b[${this._lastVisRow}A`);
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
    this._lastVisRow = visRow;
  }

  /** Ask one question; resolves the trimmed line, or null on Ctrl+C. */
  ask(prompt, remember = false) {
    this._pendingPrompt = prompt;
    this._rememberEnabled = remember;
    this._lastVisRow = 0; // the prompt is freshly written on row 0
    if (split.active) {
      // Split mode: the question lives in the footer; a half-typed main
      // message is parked while an approval question takes over.
      if (this._line !== "" && this._savedDraft === undefined) {
        this._savedDraft = this._line;
        this._line = "";
        this._cursorLine = 0;
        this._cursorCol = 0;
      }
      this.drawInput();
    } else {
      process.stdout.write(prompt);
    }
    if (this._lines.length > 0) {
      // Queued line (typed while a turn ran): deliver it now.
      if (this._piped) process.stdout.write("\n");
      const queued = this._lines.shift();
      this._restoreDraft();
      return Promise.resolve(queued);
    }
    return new Promise((resolve) => {
      this._waiter = { resolve };
    });
  }

  /** After a question is answered, bring a parked draft back into the footer. */
  _restoreDraft() {
    if (this._savedDraft !== undefined) {
      this._line = this._savedDraft;
      this._savedDraft = undefined;
      this._cursorLine = 0;
      this._cursorCol = this._line.length;
      if (split.active) this.drawInput();
    }
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
  out(`dcli ${VERSION} — DeepSeek Harness agent in your terminal.

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
  /plan [message]  plan mode: design first, review, then approve
  /plan off        leave plan mode without executing
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

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/**
 * Decode the last few zstd frames of a session log. Session logs are
 * append-only multi-frame zstd; the newest events live in the last frames, so
 * decoding only the tail is cheap even for long conversations. Returns the
 * turn-lifecycle events found there, or null when the log cannot be read.
 */
function readSessionTail(sessionDir) {
  try {
    const file = join(sessionDir, "session.jsonl.zstd");
    const buf = readFileSync(file);
    const positions = [];
    let at = 0;
    while ((at = buf.indexOf(ZSTD_MAGIC, at)) !== -1) {
      positions.push(at);
      at += 4;
    }
    const events = [];
    for (let i = Math.max(0, positions.length - 5); i < positions.length; i++) {
      const start = positions[i];
      const end = i + 1 < positions.length ? positions[i + 1] : buf.length;
      let text;
      try {
        text = zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (line === "") continue;
        try {
          const e = JSON.parse(line);
          if (e.type === "turn/start" || e.type === "turn/end" || e.type === "step/start" || e.type === "tool/call") {
            events.push({ type: e.type });
          }
        } catch {}
      }
    }
    return events;
  } catch {
    return null;
  }
}
/**
 * Whether a session's log ends inside a turn — i.e. it is actively running in
 * another process (the web GUI) right now, or was abandoned mid-turn. Resuming
 * such a session from dcli would attach a second agent to a live conversation
 * and mix two tasks into one terminal. `false` when the log cannot be read.
 */
function hasOpenTurn(sessionDir) {
  const evs = readSessionTail(sessionDir);
  if (evs === null || evs.length === 0) return false;
  let open = false;
  for (const e of evs) {
    if (e.type === "turn/end") open = false;
    else if (e.type === "turn/start" || e.type === "step/start" || e.type === "tool/call") open = true;
  }
  return open;
}
/** Newest session that is safe to auto-resume (no open turn elsewhere). */
function pickResumeCandidate(sessions) {
  for (const s of sessions) if (!s.openTurn) return s;
  return undefined;
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
    if (newest > 0) {
      sessions.push({ id: entry.name, mtime: newest, openTurn: hasOpenTurn(sessionDir) });
    }
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

/** One session list row; marks sessions with an open turn elsewhere (web GUI). */
function sessionRow(s, i) {
  const running = s.openTurn ? paint(ansi.yellow, "  ▶ running") : "";
  return `   ${paint(ansi.cyan, String(i + 1))}) ${paint(ansi.dim, s.id)}  (${paint(ansi.dim, timeAgo(s.mtime))})${running}\n`;
}

function printSessionList(sessions) {
  if (sessions.length === 0) {
    out(paint(ansi.dim, "  no sessions in this directory yet\n"));
    return;
  }
  out(`  Recent sessions in ${process.cwd()}:\n`);
  sessions.slice(0, 10).forEach((s, i) => out(sessionRow(s, i)));
}

/** Interactive picker for `dcli -r`; resolves to a session id, or undefined for a fresh start. */
async function pickSession(sessions, editor) {
  out(`  Recent sessions in ${process.cwd()}:\n`);
  sessions.slice(0, 10).forEach((s, i) => out(sessionRow(s, i)));
  out(paint(ansi.dim, "   n) start a new session\n"));
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

// NB: the astral ranges must use \u{...} with the `u` flag — a bare \u20000
// in a class is parsed as \u2000 + literal "0", which turns the class into a
// giant ASCII-inclusive range (every letter/digit counts as double-width).
const WIDE_RE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{2FFFD}\u{30000}-\u{3FFFD}]/u;
// Emoji that render double-width by default (Unicode Emoji_Presentation=Yes).
// Regional indicators (1F1E6-1F1FF) are deliberately excluded: Windows
// Terminal draws each flag half as 1 column, so a "🇨🇳" pair is 2 columns.
const EMOJI_PRES_RE = /[\u231A-\u231B\u23E9-\u23EC\u23F0\u23F3\u25FD-\u25FE\u2614-\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA-\u26AB\u26BD-\u26BE\u26C4-\u26C5\u26CE\u26D4\u26EA\u26F2-\u26F3\u26F5\u26FA\u26FD\u2705\u270A-\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B-\u2B1C\u2B50\u2B55\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F201}-\u{1F202}\u{1F21A}\u{1F22F}\u{1F232}-\u{1F23A}\u{1F250}-\u{1F251}\u{1F300}-\u{1F320}\u{1F32D}-\u{1F335}\u{1F337}-\u{1F37C}\u{1F37E}-\u{1F393}\u{1F3A0}-\u{1F3CA}\u{1F3CF}-\u{1F3D3}\u{1F3E0}-\u{1F3F0}\u{1F3F4}\u{1F3F8}-\u{1F43E}\u{1F440}\u{1F442}-\u{1F4FC}\u{1F4FF}-\u{1F53D}\u{1F54B}-\u{1F54E}\u{1F550}-\u{1F567}\u{1F57A}\u{1F595}-\u{1F596}\u{1F5A4}\u{1F5FB}-\u{1F64F}\u{1F680}-\u{1F6C5}\u{1F6CC}\u{1F6D0}-\u{1F6D2}\u{1F6D5}-\u{1F6D7}\u{1F6DC}-\u{1F6DF}\u{1F6EB}-\u{1F6EC}\u{1F6F4}-\u{1F6FC}\u{1F7E0}-\u{1F7EB}\u{1F7F0}\u{1F90C}-\u{1F93A}\u{1F93C}-\u{1F945}\u{1F947}-\u{1F9FF}\u{1FA70}-\u{1FA7C}\u{1FA80}-\u{1FA88}\u{1FA90}-\u{1FABD}\u{1FABF}-\u{1FAC5}\u{1FACE}-\u{1FADB}\u{1FAE0}-\u{1FAE8}\u{1FAF0}-\u{1FAF8}]/u;
// Emoji-capable chars that are text-presentation by default (⚠ ☀ ✔ …):
// double-width only when followed by VS16 (U+FE0F).
const EMOJI_TEXT_RE = /[\u00A9\u00AE\u203C\u2049\u2122\u2139\u2190-\u21FF\u2300-\u23FF\u24C2\u25AA-\u25AB\u25B6\u25C0\u25FB-\u25FC\u2600-\u27BF\u2934-\u2935\u2B00-\u2BFF]/u;
const ZERO_RE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFE0E\uFE0F\uFEFF\u0300-\u036F\u1AB0-\u1AFF\u20D0-\u20FF\uFE20-\uFE2F]/;
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
/**
 * Width contributed by the code point at cps[i], plus how many code points
 * form that visual unit. A text-presentation emoji (⚠ ✔ …) absorbs its VS16
 * (U+FE0F) so the pair counts as one double-width unit; a keycap absorbs
 * VS16 + U+20E3. Used by both visibleWidth and wrapCell so incremental wrap
 * decisions always agree with the final display width of the line.
 */
function charWidth(cps, i) {
  const ch = cps[i];
  if (ZERO_RE.test(ch)) return { w: 0, n: 1 };
  if (WIDE_RE.test(ch) || EMOJI_PRES_RE.test(ch)) return { w: 2, n: 1 };
  if (/[#*0-9]/.test(ch) && cps[i + 1] === "\uFE0F" && cps[i + 2] === "\u20E3") return { w: 2, n: 3 };
  if (EMOJI_TEXT_RE.test(ch)) {
    if (cps[i + 1] === "\uFE0F") return { w: 2, n: 2 };
    return { w: 1, n: 1 };
  }
  return { w: 1, n: 1 };
}
/** Width of one visible run: wide (CJK/emoji) chars count 2, zero-width count 0. */
function visibleWidth(s) {
  const cps = [...s];
  let w = 0;
  for (let i = 0; i < cps.length; i++) w += charWidth(cps, i).w;
  return w;
}
/** Display width of a string, skipping ANSI CSI sequences (they take 0 columns). */
function displayWidth(s) {
  let w = 0;
  let i = 0;
  for (const m of s.matchAll(CSI_RE)) {
    w += visibleWidth(s.slice(i, m.index));
    i = m.index + m[0].length;
  }
  return w + visibleWidth(s.slice(i));
}
/**
 * Visual row/col of a caret placed right AFTER content of width w that starts
 * at column lead. A terminal only wraps when the NEXT char is written, so a
 * line ending exactly on the right margin still has its caret on that row
 * (col = cols - 1), not at the start of the next row.
 */
function caretRow(lead, w, cols) {
  const p = lead + w;
  if (p === 0) return 0;
  return p % cols === 0 ? p / cols - 1 : Math.floor(p / cols);
}
function caretCol(lead, w, cols) {
  const p = lead + w;
  if (p === 0) return 0;
  return p % cols === 0 ? cols - 1 : p % cols;
}

const INLINE_TOKEN_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|~~[^~]+~~|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderToken(tok) {
  if (tok.startsWith("**") && tok.endsWith("**") && tok.length > 4) return paint(ansi.bold, tok.slice(2, -2));
  if (tok.startsWith("~~") && tok.endsWith("~~") && tok.length > 4) return paint(ansi.strike, tok.slice(2, -2));
  if (tok.startsWith("`") && tok.endsWith("`") && tok.length > 2) return paint(ansi.dim, tok.slice(1, -1));
  if (tok.startsWith("*") && tok.endsWith("*") && tok.length > 2) return paint(ansi.italic, tok.slice(1, -1));
  const link = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (link) return paint(ansi.underline, paint(ansi.blue, link[1])) + paint(ansi.dim, ` (${link[2]})`);
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
    // Result text is white + blue: every heading level renders blue bold.
    if (level <= 3) return paint(ansi.bold, paint(ansi.blue, text));
    return paint(ansi.bold, text);
  }
  if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    const width = Math.min(split.cols || 80, 60);
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
/**
 * Wrap text to a display-width column without breaking ANSI escape sequences
 * (a CSI sequence is a single zero-width unit) and counting CJK as two cells.
 * @param text - possibly ANSI-styled text.
 * @param width - max display columns per line.
 * @returns array of display lines.
 */
function wrapCell(text, width) {
  const lines = [];
  let cur = "";
  let curW = 0;
  const cps = [...text]; // iterate by code point so surrogate pairs never split
  let i = 0;
  while (i < cps.length) {
    const ch = cps[i];
    if (ch === "\x1b") {
      // Consume one escape sequence as a unit (zero display width).
      let j = i + 1;
      if (cps[j] === "[") {
        j += 1;
        while (j < cps.length && !(cps[j].charCodeAt(0) >= 0x40 && cps[j].charCodeAt(0) <= 0x7e)) j++;
        j += 1;
      } else {
        j += 1;
      }
      cur += cps.slice(i, j).join("");
      i = j;
      continue;
    }
    const { w, n } = charWidth(cps, i);
    if (curW + w > width && cur !== "") {
      lines.push(cur);
      cur = "";
      curW = 0;
    }
    cur += cps.slice(i, i + n).join("");
    curW += w;
    i += n;
  }
  if (cur !== "") lines.push(cur);
  else if (lines.length === 0) lines.push("");
  return lines;
}
/**
 * Water-filling width fit: shrink column widths so their sum fits `budget`.
 * The widest columns are cut first and narrow columns stay untouched, so a
 * "排名" column is never squeezed by a long neighboring cell.
 * @param natural - natural display widths per column.
 * @param budget - maximum total content width.
 * @returns fitted widths (each ≥ 3), with sum ≤ budget when possible.
 */
function fitWidths(natural, budget) {
  const w = [...natural];
  let sum = w.reduce((a, b) => a + b, 0);
  while (sum > budget) {
    let wi = -1;
    for (let i = 0; i < w.length; i++) {
      if (w[i] > 3 && (wi === -1 || w[i] > w[wi])) wi = i;
    }
    if (wi === -1) break; // everything is at the floor — cannot shrink further
    w[wi] -= 1;
    sum -= 1;
  }
  return w;
}
function makeRenderer() {
  let streamedAny = false;
  let activeType = null; // 'reasoning' | 'text' | null — the block streaming now
  let lastChar = "";
  let toolInFlight = 0; // tools currently executing (busy-indicator refcount)
  let toolStart = 0; // when the first in-flight tool started
  let activeToolName = null; // latest tool name for the busy indicator
  let toolDelayTimer = null; // 1s grace before the tool-busy indicator shows
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
      out(s); // into the split output region when active, else stdout
      lastChar = s[s.length - 1];
    }
  };
  const atLineStart = () => lastChar === "" || lastChar === "\n";

  /** Stop the elapsed-time indicator (hidden until the next busy period). */
  const stopThinking = () => {
    if (split.active) {
      split.setThinking(false);
      process.stdout.write("\x1b[?25h"); // reveal the cursor…
      activeEditor?.focusInput(); // …parked in the input box
    }
  };

  const renderTable = () => {
    if (!table) return;
    const { header, rows } = table;
    const cols = Math.max(header.length, ...rows.map((r) => r.length));
    const cells = [header, ...rows].map((r) => Array.from({ length: cols }, (_, c) => (r[c] ?? "").trim()));
    // Natural column widths from the RENDERED cells (renderInline can widen a
    // cell — a link becomes "text (url)").
    const natural = Array(cols).fill(0);
    for (const row of cells) {
      for (let c = 0; c < cols; c++) {
        natural[c] = Math.max(natural[c], displayWidth(renderInline(row[c])));
      }
    }
    // Water-filling fit: the WHOLE table (borders included) must stay inside
    // the terminal width; the widest columns give up space first, narrow ones
    // stay untouched. Short tables keep their natural widths untouched.
    const termW = Math.max(40, (split.cols || 80) - 2);
    const budget = Math.max(cols * 3, termW - 2 * cols - 3);
    const widths = fitWidths(natural, budget);
    // Wrap every cell at its column width (CJK/ANSI-aware); the header stays
    // bold on EVERY wrapped line.
    const wrapped = cells.map((row, ri) =>
      row.map((cell, c) => {
        const lines = wrapCell(renderInline(cell), widths[c]);
        return ri === 0 ? lines.map((l) => paint(ansi.bold, l)) : lines;
      })
    );
    const rowLines = wrapped.map((row) => Math.max(1, ...row.map((l) => l.length)));
    const border = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
    const writeRow = (row, lines) => {
      for (let i = 0; i < lines; i++) {
        let s = "│ ";
        for (let c = 0; c < cols; c++) {
          const seg = row[c][i] ?? "";
          s += seg + " ".repeat(widths[c] - displayWidth(seg)) + " │ ";
        }
        write(s + "\n");
      }
    };
    write(border("┌", "┬", "┐") + "\n");
    writeRow(wrapped[0], rowLines[0]);
    write(border("├", "┼", "┤") + "\n");
    for (let r = 0; r < rows.length; r++) writeRow(wrapped[r + 1], rowLines[r + 1]);
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
      if (activeType === "reasoning") stopThinking();
      if (activeType === "text") feedFlush();
      if (activeType !== null && !atLineStart()) write("\n");
      // A blank line between tool activity and the model's prose keeps the
      // process and the conclusion visually separate (split screen).
      if (type === "text" && activeType === "tool") write("\n");
      if (type === "reasoning") {
        // Start a new collapsed thinking block. In split mode a FIXED elapsed
        // counter shows above the input box while the model thinks; elsewhere
        // a static gray-italic marker line.
        reasoningBuf = "";
        reasoningChars = 0;
        if (split.active && tty && !streamReasoning) {
          split.setThinking(true);
        } else if (tty || streamReasoning) {
          write(paint(ansi.dim, paint(ansi.italic, "  ● thinking…")) + "\n");
        }
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
          stopThinking();
          if (!atLineStart()) write("\n");
          const icon = TOOL_ICONS[d.name] ?? "🔧";
          const preview = previewToolCall(d.name, d.arguments);
          // Process text: gray + italic (reads "smaller"), never loud.
          write(
            paint(ansi.dim, paint(ansi.italic, `  ${icon} ${d.name}${preview !== "" ? " " + preview : ""}`)) + "\n"
          );
          activeType = "tool";
          // Busy indicator: only after the tool keeps running ~1s (quick tools
          // never flicker); shows the tool name + elapsed seconds above the box.
          toolInFlight += 1;
          if (toolInFlight === 1) toolStart = Date.now();
          activeToolName = d.name;
          if (toolDelayTimer !== null) clearTimeout(toolDelayTimer);
          toolDelayTimer = setTimeout(() => {
            toolDelayTimer = null;
            if (toolInFlight > 0) split.setBusy(activeToolName ?? "tool", toolStart);
          }, 1000);
          break;
        }
        case "tool/result": {
          toolInFlight = Math.max(0, toolInFlight - 1);
          if (toolDelayTimer !== null) {
            clearTimeout(toolDelayTimer);
            toolDelayTimer = null;
          }
          if (toolInFlight === 0) {
            split.clearBusy();
            activeToolName = null;
          }
          if (d.error) {
            write(paint(ansi.dim, paint(ansi.italic, `  ✘ ${d.error.name}: ${d.error.code}`)) + "\n");
          } else {
            write(paint(ansi.dim, paint(ansi.italic, "  ✓ done")) + "\n");
          }
          activeType = "tool";
          break;
        }
        case "todo/write": {
          break;
        }
        case "turn/end": {
          stopThinking();
          // Safety: if the turn ended with tools still in flight (abort), reset
          // the busy-indicator state so the next turn starts clean.
          toolInFlight = 0;
          if (toolDelayTimer !== null) {
            clearTimeout(toolDelayTimer);
            toolDelayTimer = null;
          }
          activeToolName = null;
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
            write(paint(ansi.dim, paint(ansi.italic, `  · thinking ${reasoningChars} chars (use /thinking or DCLI_SHOW_REASONING=1 to view)`)) + "\n");
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
      stopThinking();
      toolInFlight = 0;
      if (toolDelayTimer !== null) {
        clearTimeout(toolDelayTimer);
        toolDelayTimer = null;
      }
      activeToolName = null;
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

/**
 * Make a tool-call target Ctrl+Click-openable in a terminal (e.g. VSCode):
 * resolve file-ish relative paths against the working directory so the link
 * detector sees an absolute path and opens the file regardless of the editor's
 * workspace root. URLs, globs, commands, and already-absolute paths stay as-is.
 */
function clickablePath(p) {
  if (/^(https?:|file:)/.test(p)) return p; // URL
  if (/^[a-zA-Z]:[\\/]/.test(p)) return p; // already absolute (C:\…)
  if (/^[\\/]/.test(p)) return p; // rooted / UNC path
  if (/[*?[\]]/.test(p)) return p; // glob pattern — not a concrete file
  const looksLikePath = p.includes("/") || p.includes("\\") || /\.\w+$/.test(p);
  if (!looksLikePath) return p; // command or free text
  try {
    return resolvePath(p);
  } catch {
    return p;
  }
}

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
  if (target !== undefined) {
    const shown = clickablePath(target);
    return shown.length > 120 ? shown.slice(0, 117) + "…" : shown;
  }
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
  out(`dcli config — API key / endpoint / model configuration.

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
      out(paint(ansi.bold, "Configuration") + "\n");
      out(`  provider:  ${sel.provider}\n`);
      out(`  model:     ${sel.model}\n`);
      if (sel.reasoningEffort) out(`  reasoning: ${sel.reasoningEffort}\n`);
      const keyState = info.configured
        ? `configured (source: ${info.source})` + (info.writable ? "" : ", not writable — env shadows the file")
        : "not configured";
      out(`  api key:   ${keyState}\n`);
      out(`  base url:  ${effectiveBaseUrl()}\n`);
      out(`  credentials file: ${join(resolveDshHome(), ".credentials.yaml")}\n`);
      out(`  settings file:    ${join(resolveDshHome(), "settings.yaml")}\n`);
      return 0;
    }
    case "set-base-url": {
      const url = positionals[0];
      if (!url) {
        out(paint(ansi.red, "  ✘ usage: dcli config set-base-url <url>\n"));
        return 1;
      }
      try {
        await settings.update(LLM_DEEPSEEK_NS, { baseURL: url });
        out(paint(ansi.green, `  ✓ base URL set: ${url}\n`));
        return 0;
      } catch (error) {
        out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "unset-base-url": {
      try {
        await settings.replace(LLM_DEEPSEEK_NS, {});
        out(
          paint(ansi.green, `  ✓ base URL reset to ${process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL}\n`)
        );
        return 0;
      } catch (error) {
        out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "set-api-key": {
      const key = positionals[0];
      if (!key) {
        out(paint(ansi.red, "  ✘ usage: dcli config set-api-key <key>\n"));
        return 1;
      }
      try {
        await credentials.set(credentialRef(API_KEY_REF), key);
        out(paint(ansi.green, "  ✓ API key saved\n"));
        return 0;
      } catch (error) {
        out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "unset-api-key": {
      try {
        await credentials.unset(credentialRef(API_KEY_REF));
        out(paint(ansi.green, "  ✓ API key removed\n"));
        return 0;
      } catch (error) {
        out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "list-models": {
      try {
        const models = await llm.listModels(provider);
        if (models.length === 0) {
          out(paint(ansi.dim, `  no models advertised by ${provider}\n`));
          return 0;
        }
        out(`Available models (${provider}):\n`);
        for (const m of models) {
          const name = m.name && m.name !== m.id ? ` — ${m.name}` : "";
          out(`  ${paint(ansi.cyan, m.id)}${paint(ansi.dim, name)}\n`);
        }
        return 0;
      } catch (error) {
        out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    case "set-model": {
      const model = positionals[0];
      if (!model) {
        out(paint(ansi.red, "  ✘ usage: dcli config set-model <id> [--provider <p>] [--reasoning off|high|max]\n"));
        return 1;
      }
      if (opts.reasoning !== undefined && !REASONING_EFFORTS.includes(opts.reasoning)) {
        out(paint(ansi.red, `  ✘ reasoning must be one of: ${REASONING_EFFORTS.join(", ")}\n`));
        return 1;
      }
      let known = false;
      try {
        const models = await llm.listModels(provider);
        known = models.some((m) => m.id === model);
      } catch {}
      if (!known) {
        out(
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
        out(paint(ansi.green, `  ✓ model set: ${provider}/${model}${effort}\n`));
        return 0;
      } catch (error) {
        out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
        return 1;
      }
    }
    default:
      out(paint(ansi.yellow, `  ✘ unknown config command: ${cmd}\n`));
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
  out(
    paint(ansi.bold, "Balance") + "  " + (available ? paint(ansi.green, "✓ available") : paint(ansi.red, "✗ unavailable")) + "\n"
  );
  if (infos.length === 0) {
    out(paint(ansi.dim, "  no balance info\n"));
    return;
  }
  for (const b of infos) {
    const total = b.total_balance ?? "?";
    const topped = b.topped_up_balance ?? "0.00";
    const granted = b.granted_balance ?? "0.00";
    out(
      `  ${paint(ansi.cyan, b.currency ?? "?")}  总余额 ${paint(ansi.bold, total)}  (充值 ${topped} / 赠送 ${granted})\n`
    );
  }
}

async function fetchBalance(credentials, settings) {
  const cred = await credentials.resolve(credentialRef(API_KEY_REF)).catch(() => undefined);
  const key = cred?.value ?? process.env.DEEPSEEK_API_KEY;
  if (!key) {
    out(paint(ansi.yellow, "  no API key configured — run: dcli config set-api-key <key>\n"));
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
    out(paint(ansi.red, `  ✘ cannot reach ${url}: ${error?.message ?? error}\n`));
    return 1;
  }
  if (res.status === 404) {
    out(paint(ansi.yellow, `  ✘ this endpoint does not expose /user/balance (custom base url?)\n`));
    return 1;
  }
  if (!res.ok) {
    out(paint(ansi.red, `  ✘ HTTP ${res.status}\n`));
    return 1;
  }
  let data;
  try {
    data = await res.json();
  } catch {
    out(paint(ansi.red, "  ✘ invalid response\n"));
    return 1;
  }
  renderBalance(data);
  return 0;
}

/**
 * Render one `ctx.userQuestions` request in the terminal and return the
 * provider answer shape. This backs plan review (`exit_plan_mode` → the
 * "Plan review" question) and the `ask_user_question` tool, exactly like the
 * web GUI's question cards. Input grammar: `1` picks option 1, `1,3` picks
 * multiple (multi-select), `2: <feedback>` picks option 2 but replies with
 * custom feedback instead of the label, and any other text is a custom answer.
 */
async function askInTerminal(editor, request) {
  const answers = [];
  for (const q of request.questions ?? []) {
    if (q.header !== undefined && q.header !== "") {
      out(paint(ansi.bold, `\n  ${q.header}\n`));
    }
    if (q.question !== undefined && q.question !== "") {
      out(`  ${q.question}\n`);
    }
    if (q.detail !== undefined && q.detail !== "") {
      for (const line of String(q.detail).split("\n")) out(`  ${line}\n`);
    }
    const options = q.options ?? [];
    if (options.length > 0) {
      out("\n");
      options.forEach((o, i) => {
        out(
          `  ${paint(ansi.cyan, String(i + 1))}) ${o.label}` +
            (o.description !== undefined && o.description !== "" ? paint(ansi.dim, ` — ${o.description}`) : "") +
            "\n"
        );
      });
      const line = await editor.ask(paint(ansi.green, "  choice: "), false);
      if (line === null) throw new Error("ask_user_question was aborted before the user answered");
      const input = line.trim();
      if (/^\d+$/.test(input)) {
        const idx = Number(input) - 1;
        if (idx >= 0 && idx < options.length) answers.push({ id: q.id, selected: [options[idx].label] });
        else answers.push({ id: q.id, selected: [], custom: input });
      } else if (q.multiSelect === true && input.includes(",")) {
        const selected = [];
        let ok = true;
        for (const part of input.split(",")) {
          const t = part.trim();
          const idx = Number(t) - 1;
          if (!/^\d+$/.test(t) || idx < 0 || idx >= options.length) { ok = false; break; }
          selected.push(options[idx].label);
        }
        answers.push(ok ? { id: q.id, selected } : { id: q.id, selected: [], custom: input });
      } else {
        const numbered = /^(\d+)\s*:?\s*(.*)$/.exec(input);
        if (numbered !== null) {
          const idx = Number(numbered[1]) - 1;
          if (idx >= 0 && idx < options.length) {
            answers.push(
              numbered[2].trim() === ""
                ? { id: q.id, selected: [options[idx].label] }
                : { id: q.id, selected: [], custom: numbered[2].trim() }
            );
          } else {
            answers.push({ id: q.id, selected: [], custom: input });
          }
        } else {
          answers.push({ id: q.id, selected: [], custom: input });
        }
      }
    } else {
      const text = await editor.ask(paint(ansi.green, "  answer: "), false);
      if (text === null) throw new Error("ask_user_question was aborted before the user answered");
      answers.push({ id: q.id, selected: [], custom: text });
    }
  }
  return { answers };
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
  // Real terminal width: on Windows `process.stdout.columns` is the console
  // BUFFER width, which is often wider than the window (cmd: 120 vs 80) —
  // every wrap/table/box computation must use the visible window width.
  const detectedCols = await detectTerminalCols();
  if (detectedCols !== undefined) {
    split._detectedCols = detectedCols;
    split.cols = detectedCols;
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
  // Split screen (fixed input footer + scrollable output) is the interactive
  // default on TTYs; set DCLI_SPLIT=0 for the classic streaming layout.
  const splitEnabled = process.stdin.isTTY && process.env.DCLI_SPLIT !== "0";
  if (splitEnabled) split.enter();
  let handle = null; // { agent, dispose }
  let liveSelection = null; // mutable {current, assembled} ref for the live agent
  let busy = false;
  let quitting = false;
  let cancelSent = false;

  // Terminal answers for `ctx.userQuestions` (plan review via exit_plan_mode,
  // the ask_user_question tool, …). Without a provider those questions fail
  // with NO_PROVIDER and plan mode could never be exited. One provider per
  // context — registered here, once, not per agent.
  const userQuestions = ctx.get("userQuestions");
  if (userQuestions !== undefined) {
    try {
      userQuestions.registerProvider({ ask: (request) => askInTerminal(editor, request) });
    } catch {}
  }

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
      // Keep the footer prompt SHORT. A long prompt (the escalation reason is
      // easily wider than the terminal) wraps in the single-row input box and
      // leaks a copy into the output after every written line in split mode.
      // The full reason flows into the output region as a process line instead.
      if (req.reason) {
        out(paint(ansi.dim, paint(ansi.italic, `  ⚠ ${toolName} needs approval: ${req.reason}`)) + "\n");
      }
      const answer = await editor.ask(
        paint(ansi.yellow, `  ⚠ Allow ${paint(ansi.cyan, toolName)}? `) + paint(ansi.dim, "[y/N] ")
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
      split.leave();
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
      out(paint(ansi.yellow, "\n  ⏹ force exit\n"));
      finish(130);
      return;
    }
    if (busy) {
      if (!cancelSent) {
        // First Ctrl+C during a turn: cancel the live turn.
        cancelSent = true;
        out(paint(ansi.yellow, "\n  ⏹ cancelling…\n"));
        try {
          handle?.agent.cancel({ kind: "user" });
        } catch {}
        return;
      }
      // Second Ctrl+C during a turn: force quit.
      out(paint(ansi.yellow, "\n  ⏹ force exit\n"));
      finish(130);
      return;
    }
    quitting = true;
    // At the idle prompt there is nothing pending to flush (each turn already
    // flushed), so exit IMMEDIATELY — a lingering process would keep writing
    // into the terminal and make the next dcli run look like it reuses content.
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
    const live = sessions.filter((s) => s.openTurn);
    if (live.length > 0) {
      out(
        paint(ansi.yellow, `  ⚠ ${live.length} session(s) still have an open turn (running in the web GUI?); not auto-resuming them\n`)
      );
    }
    const candidate = pickResumeCandidate(sessions);
    if (candidate === undefined) {
      out(paint(ansi.yellow, "  no resumable sessions in this directory; starting fresh\n"));
    } else if (opts.continue || !process.stdin.isTTY) {
      resumeTarget = candidate.id;
    } else {
      resumeTarget = (await pickSession(sessions, editor)) ?? undefined;
    }
  }
  if (resumeTarget === undefined && !skipResumePrompt && process.stdin.isTTY) {
    // Fresh start, but there is a previous conversation here — offer to resume
    // the newest session that is NOT live elsewhere (a session with an open
    // turn is the web GUI's live conversation; attaching to it mixes two tasks).
    const sessions = listSessions();
    const live = sessions.filter((s) => s.openTurn);
    if (live.length > 0) {
      out(
        paint(ansi.yellow, `  ⚠ ${live.length} recent session(s) still running (web GUI?); not offered for resume\n`)
      );
    }
    const candidate = pickResumeCandidate(sessions);
    if (candidate !== undefined) {
      const answer = await editor.ask(
        paint(ansi.yellow, `  Resume previous session (${candidate.id}, ${timeAgo(candidate.mtime)})? `) +
          paint(ansi.dim, "[y/N] ")
      );
      if (answer !== null && /^y(es)?$/i.test(answer.trim())) resumeTarget = candidate.id;
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
      out("\n");
      printBanner();
      out(
        `\n${paint(ansi.green, "▶ resumed")} ${paint(ansi.dim, resumeTarget)} (${paint(ansi.dim, modelDesc)})\n\n`
      );
      await interactiveLoop(agent);
      await shutdown();
      finish(0);
      return;
    } catch (error) {
      out(paint(ansi.red, `\n  ✘ cannot resume ${resumeTarget}: ${error?.message ?? error}\n`));
      await shutdown();
      finish(1);
      return;
    }
  }

  // ---- fresh interactive --------------------------------------------------
  const agent = await startAgent(SessionId(`session-${randomUUID()}`), undefined);
  out("\n");
  printBanner();
  out(
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
      // Echo the submitted message into the output region (split mode), so the
      // conversation reads top-to-bottom like Claude Code / Codex.
      if (split.active && !text.startsWith("/")) out("\n" + paint(ansi.green, "❯ ") + text + "\n");

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
            out(paint(ansi.dim, "  ↻ new session\n"));
            current = await startAgent(SessionId(`session-${randomUUID()}`), undefined);
            continue;
          }
          case "/sessions": {
            printSessionList(listSessions());
            continue;
          }
          case "/resume": {
            if (arg === "") {
              out(paint(ansi.yellow, "  usage: /resume <session-id> (see /sessions)\n"));
              continue;
            }
            try {
              out(paint(ansi.dim, `  ↻ resuming ${arg}\n`));
              current = await startAgent(undefined, arg);
            } catch (error) {
              out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
            }
            continue;
          }
          case "/session":
            out(paint(ansi.dim, `  ${current.session.id}\n`));
            continue;
          case "/apikey": {
            if (arg === "") {
              out(paint(ansi.yellow, "  usage: /apikey <key>  (also: dcli config set-api-key <key>)\n"));
              continue;
            }
            try {
              await credentials.set(credentialRef(API_KEY_REF), arg);
              out(paint(ansi.green, "  ✓ API key saved\n"));
            } catch (error) {
              out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
            }
            continue;
          }
          case "/base-url": {
            if (arg === "") {
              let resolved;
              try {
                resolved = settings?.get(LLM_DEEPSEEK_NS);
              } catch {}
              out(
                `  base url: ${paint(ansi.cyan, resolved?.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL)}\n`
              );
              out(paint(ansi.dim, "  usage: /base-url <url>  (also: dcli config set-base-url <url>)\n"));
              continue;
            }
            try {
              await settings.update(LLM_DEEPSEEK_NS, { baseURL: arg });
              out(paint(ansi.green, `  ✓ base URL set: ${arg} (next message)\n`));
            } catch (error) {
              out(paint(ansi.red, `  ✘ ${error?.message ?? error}\n`));
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
              out(
                `  current: ${paint(ansi.cyan, sel.provider + "/" + sel.model)}` +
                  (sel.reasoningEffort ? paint(ansi.dim, ` (reasoning: ${sel.reasoningEffort})`) : "") +
                  "\n"
              );
              let models = [];
              try {
                models = await llm.listModels(sel.provider);
              } catch {}
              if (models.length > 0) {
                out(`  available (${sel.provider}):\n`);
                models.forEach((m, i) => {
                  out(`   ${paint(ansi.cyan, String(i + 1))}) ${paint(ansi.dim, m.id)}\n`);
                });
              }
              out(paint(ansi.dim, "  usage: /model <id>   /reasoning <off|high|max>\n"));
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
                out(
                  paint(ansi.yellow, `  ✘ "${arg}" matches ${partial.map((m) => m.id).join(", ")} — use the full id\n`)
                );
                continue;
              }
            } catch {}
            if (!known) {
              out(
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
            out(paint(ansi.green, `  ✓ model → ${target} (next message)\n`));
            continue;
          }
          case "/reasoning": {
            if (!REASONING_EFFORTS.includes(arg)) {
              out(paint(ansi.yellow, `  usage: /reasoning <${REASONING_EFFORTS.join("|")}>\n`));
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
            out(paint(ansi.green, `  ✓ reasoning → ${arg} (next message)\n`));
            continue;
          }
          case "/thinking": {
            const reasoning = renderer.lastReasoning();
            if (reasoning) {
              out(paint(ansi.dim, "  ── thinking ──\n"));
              out(paint(ansi.dim, reasoning));
              if (!reasoning.endsWith("\n")) out("\n");
              out(paint(ansi.dim, "  ──────────────\n"));
            } else {
              out(paint(ansi.dim, "  no reasoning recorded for the last turn\n"));
            }
            continue;
          }
          case "/clear":
            if (tty) out(ansi.clearScreen);
            continue;
          default: {
            // Plugin-owned commands (e.g. `/plan` from dsh-plan-mode) register
            // in the harness command registry — delegate before giving up, so
            // the CLI speaks the same command plane as the web GUI.
            const commands = ctx.get("commands");
            if (commands !== undefined) {
              const controller = new AbortController();
              let execution;
              try {
                execution = await commands.execute(current, text, controller.signal);
              } catch (error) {
                controller.abort();
                out(paint(ansi.red, `  ✘ ${error instanceof Error ? error.message : String(error)}\n`));
                continue;
              }
              if (execution !== undefined) {
                controller.abort();
                const resultText = execution.result?.text ?? "";
                if (resultText !== "") {
                  out(resultText.endsWith("\n") ? resultText : resultText + "\n");
                }
                // A delegated command may have started a turn (`/plan <message>`
                // steers the agent) — wait it out like a normal submit so the
                // prompt returns only once the turn has settled.
                busy = true;
                cancelSent = false;
                renderer.resetStep();
                try {
                  await current.whenIdle();
                } finally {
                  busy = false;
                }
                await sessions.flush(current.session);
                continue;
              }
            }
            out(paint(ansi.yellow, `  unknown command: ${cmd} (try /help)\n`));
            continue;
          }
        }
        if (quitting) break;
        continue;
      }

      await submit(current, text);
      out("\n");
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
    out(VERSION + "\n");
    exit(0);
    return;
  }
  run(ctx, opts, exit).catch((error) => {
    process.stderr.write(`dcli: ${error instanceof Error ? error.message : String(error)}\n`);
    exit(1);
  });
}
