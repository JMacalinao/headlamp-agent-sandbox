export const CH_STDIN = 0;
export const CH_STDOUT = 1;
export const CH_STDERR = 2;
export const CH_ERROR = 3;
export const CH_RESIZE = 4;

export function frame(channel: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + 1);
  out[0] = channel;
  out.set(bytes, 1);
  return out;
}

export function frameText(channel: number, text: string): Uint8Array {
  return frame(channel, new TextEncoder().encode(text));
}

export function frameResize(cols: number, rows: number): Uint8Array {
  return frameText(CH_RESIZE, JSON.stringify({ Width: cols, Height: rows }));
}

export function unframe(data: ArrayBuffer): { channel: number; payload: Uint8Array } {
  const bytes = new Uint8Array(data);
  if (bytes.length === 0) {
    return { channel: -1, payload: bytes };
  }
  return { channel: bytes[0], payload: bytes.subarray(1) };
}

export function parseStatus(payload: Uint8Array): { success: boolean; message: string } | null {
  let text: string;
  try {
    text = new TextDecoder().decode(payload);
  } catch {
    return null;
  }
  let status: any;
  try {
    status = JSON.parse(text);
  } catch {
    return null;
  }
  return { success: status.status === 'Success', message: status.message ?? '' };
}

export function chunkBase64(b64: string, size = 32768): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < b64.length; i += size) {
    chunks.push(b64.slice(i, i + size));
  }
  return chunks;
}

export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export function attachmentName(original: string, now: Date = new Date()): string {
  const base = original.split(/[/\\]/).pop() || '';
  let safe = base.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-');
  safe = safe.replace(/^[.-]+/, '');
  if (!safe) {
    safe = 'file';
  }
  if (safe.length > 100) {
    const dot = safe.lastIndexOf('.');
    // A long trailing dot-run is not an extension; slicing by its length would grow the name.
    const ext = dot > 0 && safe.length - dot <= 16 ? safe.slice(dot) : '';
    safe = safe.slice(0, 100 - ext.length) + ext;
  }
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
  return `${ts}-${safe}`;
}

// head -c both terminates the exec on the exact byte count (the protocol gives us no EOF)
// and exits 0 on a short read, and base64 -d accepts any multiple of 4 — so the wc -c check
// is the only thing that catches a transfer cut at a chunk boundary. The intermediates are
// removed on every path and the failing status preserved.
export function uploadCommand(dir: string, file: string, b64len: number): string[] {
  const q = shQuote(dir);
  const qf = shQuote(file);
  return [
    'sh',
    '-c',
    `mkdir -p ${q} && head -c ${b64len} > ${qf}.b64 && ` +
      `[ "$(wc -c < ${qf}.b64)" -eq ${b64len} ] && ` +
      `base64 -d < ${qf}.b64 > ${qf}.part && mv ${qf}.part ${qf}; ` +
      `status=$?; rm -f ${qf}.b64 ${qf}.part; exit $status`,
  ];
}

export const LIST_SESSIONS_COMMAND: string[] = [
  'sh',
  '-c',
  // An untitled pane reports the hostname; blank it so the tab falls back to the session name.
  'tmux list-sessions -F "#{session_name}\t#{?#{==:#{pane_title},#{host}},,#{pane_title}}" 2>/dev/null || true',
];

// -u: a client whose LC_CTYPE is not UTF-8 makes tmux draw every wide glyph as `_`.
// -D: runsc never hangs up an exec whose websocket dropped, so each attach detaches the orphans.
// The client's pid goes out first as an OSC CLIENT_PID_OSC, so a pane can hang up its own client.
// The trailing commands run once attached: with them tmux forwards the active pane's title
// (what Claude Code sets) to the client as OSC 2, which is what names the tab.
export function attachCommand(session: string): string[] {
  return [
    'sh',
    '-c',
    `printf '\\033]${CLIENT_PID_OSC};%s\\007' $$; exec "$@"`,
    'sh',
    'tmux',
    '-u',
    'new',
    '-A',
    '-D',
    '-s',
    session,
    ';',
    'set',
    '-g',
    'set-titles',
    'on',
    ';',
    'set',
    '-g',
    'set-titles-string',
    '#T',
  ];
}

export const CLIENT_PID_OSC = 7777;

export function hangUpCommand(pid: string): string[] {
  return ['kill', '-HUP', pid];
}

export function killSessionCommand(session: string): string[] {
  return ['tmux', 'kill-session', '-t', session];
}

// SGR wheel reports (CSI < 64|65 ; col ; row M), byte-identical to what xterm emits for a desktop
// wheel. Tracking mode and encoding are separate modes and tmux's `mouse on` turns on both.
// Cell 1;1 means tmux scrolls its top-left pane, not whichever one is under the finger.
export const WHEEL_UP = '\x1b[<64;1;1M';
export const WHEEL_DOWN = '\x1b[<65;1;1M';

export const MAX_RECONNECTS = 6;

/** Milliseconds to wait before reconnect attempt `attempt` (1-based): 1s doubling, capped at 10s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 10000);
}

// ESC CR is what Claude Code's own terminal bindings send for Shift+Enter; xterm sends a bare CR
// for the chord and has no kitty encoding to say otherwise.
export const SHIFT_ENTER = '\x1b\r';

const SHIFTED = new Map<string, string>([
  ['\t', '\x1b[Z'],
  ['\r', SHIFT_ENTER],
  ['\x1b[A', '\x1b[1;2A'],
  ['\x1b[B', '\x1b[1;2B'],
  ['\x1b[C', '\x1b[1;2C'],
  ['\x1b[D', '\x1b[1;2D'],
  ['\x1b[H', '\x1b[1;2H'],
  ['\x1b[F', '\x1b[1;2F'],
]);

/** What `data` sends with Shift held, or undefined where Shift has no meaning (pastes, reports). */
export function shifted(data: string): string | undefined {
  const sequence = SHIFTED.get(data);
  if (sequence !== undefined) {
    return sequence;
  }
  if ([...data].length !== 1) {
    return undefined;
  }
  // ß upper-cases to SS; a key that grows is not one key.
  const upper = data.toUpperCase();
  return [...upper].length === 1 ? upper : data;
}

/** Whole scroll steps from an accumulated touch drag, truncated toward zero so the rest carries. */
export function scrollSteps(pixels: number, rowHeight: number): number {
  return rowHeight > 0 ? Math.trunc(pixels / rowHeight) : 0;
}

// A desktop horizontal scrollbar also leaves innerHeight above visualViewport.height, hence the
// floor. Android configurations that resize the layout viewport instead report ~0 here, which is
// correct: the toolbar is already above the keyboard and needs no pinning.
const KEYBOARD_MIN_PX = 140;

/** How much of the layout viewport the on-screen keyboard covers, or 0 when no keyboard is up. */
export function keyboardInset(
  innerHeight: number,
  visualHeight: number,
  visualTop: number
): number {
  const inset = innerHeight - (visualTop + visualHeight);
  return inset >= KEYBOARD_MIN_PX ? inset : 0;
}
