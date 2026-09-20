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
    const ext = dot > 0 ? safe.slice(dot) : '';
    safe = safe.slice(0, 100 - ext.length) + ext;
  }
  const ts = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-');
  return `${ts}-${safe}`;
}

// head -c makes the exec terminate itself on the exact byte count; we can't rely on
// closing the socket to signal EOF over the exec protocol. .part+mv keeps a truncated
// transfer from landing at the final path.
export function uploadCommand(dir: string, file: string, b64len: number): string[] {
  const q = shQuote(dir);
  const qf = shQuote(file);
  return [
    'sh',
    '-c',
    `mkdir -p ${q} && head -c ${b64len} | base64 -d > ${qf}.part && mv ${qf}.part ${qf}`,
  ];
}

export const LIST_SESSIONS_COMMAND: string[] = [
  'sh',
  '-c',
  'tmux list-sessions -F "#{session_name}" 2>/dev/null || true',
];

// -u: a client whose LC_CTYPE is not UTF-8 makes tmux draw every wide glyph as `_`.
export function attachCommand(session: string, run?: string): string[] {
  return run
    ? ['tmux', '-u', 'new', '-A', '-s', session, run]
    : ['tmux', '-u', 'new', '-A', '-s', session];
}

export function killSessionCommand(session: string): string[] {
  return ['tmux', 'kill-session', '-t', session];
}
