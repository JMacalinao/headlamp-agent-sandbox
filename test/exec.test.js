import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CH_STDIN,
  CH_STDOUT,
  CH_RESIZE,
  CH_ERROR,
  frame,
  frameText,
  frameResize,
  unframe,
  parseStatus,
  chunkBase64,
  shQuote,
  attachmentName,
  uploadCommand,
  LIST_SESSIONS_COMMAND,
  attachCommand,
  killSessionCommand,
} from '../src/exec.ts';

test('frame/unframe round-trip with a 0 byte and multi-byte UTF-8', () => {
  const payload = new TextEncoder().encode('a\u0000b\u00e9\u4e2d');
  const framed = frame(CH_STDOUT, payload);
  const { channel, payload: out } = unframe(
    framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength)
  );
  assert.equal(channel, CH_STDOUT);
  assert.deepEqual(out, payload);
});

test('unframe on an empty buffer yields channel -1', () => {
  const { channel, payload } = unframe(new ArrayBuffer(0));
  assert.equal(channel, -1);
  assert.equal(payload.length, 0);
});

test('frameResize produces channel 4 and valid JSON', () => {
  const framed = frameResize(80, 24);
  assert.equal(framed[0], CH_RESIZE);
  const text = new TextDecoder().decode(framed.subarray(1));
  assert.deepEqual(JSON.parse(text), { Width: 80, Height: 24 });
});

test('parseStatus: Success', () => {
  const payload = new TextEncoder().encode(JSON.stringify({ status: 'Success' }));
  assert.deepEqual(parseStatus(payload), { success: true, message: '' });
});

test('parseStatus: Failure with ExitCode cause', () => {
  const status = {
    status: 'Failure',
    message: 'command terminated with non-zero exit code',
    details: { causes: [{ reason: 'ExitCode', message: '1' }] },
  };
  const payload = new TextEncoder().encode(JSON.stringify(status));
  const result = parseStatus(payload);
  assert.equal(result.success, false);
  assert.equal(result.message, 'command terminated with non-zero exit code');
});

test('parseStatus: non-JSON input returns null', () => {
  assert.equal(parseStatus(new TextEncoder().encode('not json')), null);
});

test('chunkBase64: exact multiple', () => {
  const b64 = 'a'.repeat(10);
  const chunks = chunkBase64(b64, 5);
  assert.deepEqual(chunks, ['aaaaa', 'aaaaa']);
  assert.equal(chunks.join(''), b64);
});

test('chunkBase64: remainder', () => {
  const b64 = 'a'.repeat(12);
  const chunks = chunkBase64(b64, 5);
  assert.deepEqual(chunks, ['aaaaa', 'aaaaa', 'aa']);
  assert.equal(chunks.join(''), b64);
});

test('chunkBase64: empty string', () => {
  assert.deepEqual(chunkBase64(''), []);
});

test('chunkBase64: default size rejoins a large input', () => {
  const b64 = 'b'.repeat(70000);
  const chunks = chunkBase64(b64);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(''), b64);
});

test('shQuote handles an embedded single quote', () => {
  const quoted = shQuote(`it's a test`);
  assert.equal(quoted, `'it'\\''s a test'`);
});

// Undo shQuote so the script can be read back as the operands it will actually pass.
function unquote(token) {
  return token.replaceAll(`'\\''`, '\u0000').replaceAll(`'`, '').replaceAll('\u0000', `'`);
}

function words(stage) {
  return stage.trim().split(/\s+/).map(unquote);
}

test('uploadCommand creates the directory, reads the exact byte count and moves into place', () => {
  const dir = '/workspace/.attachments';
  const path = `${dir}/20260920-134501-a.png`;
  const argv = uploadCommand(dir, path, 0);
  assert.equal(argv[0], 'sh');
  assert.equal(argv[1], '-c');

  const [transfer, ...cleanup] = argv[2].split(';');
  const stages = transfer.split('&&');
  assert.equal(stages.length, 5);
  assert.deepEqual(words(stages[0]), ['mkdir', '-p', dir]);
  assert.deepEqual(words(stages[1]), ['head', '-c', '0', '>', `${path}.b64`]);
  // head -c exits 0 on a short read, so this is the check that rejects a truncated transfer.
  assert.deepEqual(words(stages[2]), ['[', `"$(wc`, '-c', '<', `${path}.b64)"`, '-eq', '0', ']']);
  assert.deepEqual(words(stages[3]), ['base64', '-d', '<', `${path}.b64`, '>', `${path}.part`]);
  assert.deepEqual(words(stages[4]), ['mv', `${path}.part`, path]);

  assert.deepEqual(words(cleanup[0]), ['status=$?']);
  assert.deepEqual(words(cleanup[1]), ['rm', '-f', `${path}.b64`, `${path}.part`]);
  assert.deepEqual(words(cleanup[2]), ['exit', '$status']);
});

test('uploadCommand derives the temporary paths from the quoted file', () => {
  const dir = `/tmp/up loads`;
  const file = `${dir}/it's.txt`;
  const script = uploadCommand(dir, file, 42)[2];
  for (const suffix of ['.b64', '.part']) {
    // The suffix must sit outside the quotes, or the shell would read it as part of the name.
    assert.ok(script.includes(`${shQuote(file)}${suffix}`));
    assert.ok(!script.includes(shQuote(`${file}${suffix}`)));
  }
});

test('base64 is one byte per character, which is what makes head -c <b64len> exact', () => {
  const b64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  assert.equal(new TextEncoder().encode(b64).length, b64.length);
});

test('attachmentName strips directory parts', () => {
  const now = new Date('2026-09-20T13:45:01.000Z');
  assert.equal(attachmentName('../../etc/passwd', now), '20260920-134501-passwd');
});

test('attachmentName replaces unsafe characters', () => {
  const now = new Date('2026-09-20T13:45:01.000Z');
  assert.equal(attachmentName('my file (1).txt', now), '20260920-134501-my-file-1-.txt');
});

test('attachmentName keeps the extension when truncating a long name', () => {
  const now = new Date('2026-09-20T13:45:01.000Z');
  const long = 'x'.repeat(300) + '.txt';
  const result = attachmentName(long, now);
  assert.ok(result.endsWith('.txt'));
  assert.ok(result.length <= 'YYYYMMDD-HHMMSS-'.length + 100);
});

test('attachmentName does not grow a name whose extension is absurdly long', () => {
  const now = new Date('2026-09-20T13:45:01.000Z');
  const result = attachmentName('a.' + 'b'.repeat(150), now);
  assert.ok(result.length <= 116, `got ${result.length} characters`);
});

test('attachmentName is deterministic for a fixed now and never empty', () => {
  const now = new Date('2026-09-20T13:45:01.000Z');
  const a = attachmentName('$$$.sh', now);
  const b = attachmentName('$$$.sh', now);
  assert.equal(a, b);
  assert.notEqual(a, '');
});

test('LIST_SESSIONS_COMMAND swallows the no-server-running failure', () => {
  assert.deepEqual(LIST_SESSIONS_COMMAND, [
    'sh',
    '-c',
    'tmux list-sessions -F "#{session_name}" 2>/dev/null || true',
  ]);
});

// The agent is typed into the session's shell, never passed here: tmux would exec the binary and
// skip the image's rc, where `claude` is a shell function that gives it a unique socket path.
test('attachCommand always opens a bare session', () => {
  assert.deepEqual(attachCommand('mysession'), ['tmux', '-u', 'new', '-A', '-s', 'mysession']);
  assert.equal(attachCommand('mysession').length, 6);
});

test('killSessionCommand', () => {
  assert.deepEqual(killSessionCommand('mysession'), ['tmux', 'kill-session', '-t', 'mysession']);
});
