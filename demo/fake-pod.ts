import { CH_ERROR, CH_RESIZE, CH_STDOUT, frameText, LIST_SESSIONS_COMMAND } from '../src/exec';

type OnData = (data: ArrayBuffer) => void;

const SESSIONS: Record<string, { title: string; lines: string[] }> = {
  main: {
    title: 'Refactor the upload path',
    lines: [
      '\x1b[32magent@demo\x1b[0m:\x1b[34m/workspace/webapp\x1b[0m$ git log --oneline -4',
      '\x1b[33m4f1c2ab\x1b[0m fix: retry uploads after a dropped connection',
      '\x1b[33m9e07d31\x1b[0m feat: stream attachments in 32 KiB chunks',
      '\x1b[33m1b5a8c0\x1b[0m test: cover the reconnect backoff',
      '\x1b[33m77d2e94\x1b[0m docs: describe the upload flow',
      '\x1b[32magent@demo\x1b[0m:\x1b[34m/workspace/webapp\x1b[0m$ npm test',
      '',
      '\x1b[32m ✓\x1b[0m upload.test.ts \x1b[2m(12 tests)\x1b[0m',
      '\x1b[32m ✓\x1b[0m reconnect.test.ts \x1b[2m(6 tests)\x1b[0m',
      '\x1b[32m ✓\x1b[0m session.test.ts \x1b[2m(9 tests)\x1b[0m',
      '',
      ' \x1b[1mTest Files\x1b[0m  \x1b[32m3 passed\x1b[0m (3)',
      '      \x1b[1mTests\x1b[0m  \x1b[32m27 passed\x1b[0m (27)',
      '',
      '\x1b[32magent@demo\x1b[0m:\x1b[34m/workspace/webapp\x1b[0m$ ',
    ],
  },
  review: {
    title: 'Review the API changes',
    lines: ['\x1b[32magent@demo\x1b[0m:\x1b[34m/workspace/api\x1b[0m$ '],
  },
};

const encode = (channel: number, text: string): ArrayBuffer =>
  frameText(channel, text).slice().buffer;

function screen(session: string, cols: number, rows: number): string {
  const { title, lines } = SESSIONS[session] ?? SESSIONS.review;
  const status = ` [${session}] 0:bash*`;
  const clock = `"${title}" 10:42 24-Sep-26 `;
  const bar = status + ' '.repeat(Math.max(1, cols - status.length - clock.length)) + clock;
  return (
    `\x1b]2;${title}\x07\x1b[2J\x1b[H` +
    lines.join('\r\n') +
    `\x1b7\x1b[${rows};1H\x1b[30;42m${bar.slice(0, cols)}\x1b[0m\x1b8`
  );
}

/** Stands in for a Headlamp Pod: lists two tmux sessions and paints a static screen per tab. */
export const fakePod = {
  exec(_container: string, onData: OnData, options: { command: string[]; tty: boolean }) {
    const session = options.command[options.command.indexOf('-s') + 1];
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      addEventListener() {},
      send(bytes: Uint8Array) {
        if (bytes[0] !== CH_RESIZE) {
          return;
        }
        const { Width, Height } = JSON.parse(new TextDecoder().decode(bytes.subarray(1)));
        onData(encode(CH_STDOUT, screen(session, Width, Height)));
      },
    };
    if (options.command.join(' ') === LIST_SESSIONS_COMMAND.join(' ')) {
      setTimeout(() => {
        onData(encode(CH_STDOUT, Object.keys(SESSIONS).join('\n')));
        onData(encode(CH_ERROR, '{"status":"Success"}'));
      });
    }
    return { cancel() {}, getSocket: () => (options.tty ? socket : null) };
  },
};
