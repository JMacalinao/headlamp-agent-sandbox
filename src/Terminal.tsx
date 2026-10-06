import '@xterm/xterm/css/xterm.css';
import { Icon } from '@iconify/react';
import { Loader } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import type Pod from '@kinvolk/headlamp-plugin/lib/lib/k8s/pod';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  Menu,
  MenuItem,
  Portal,
  Tab,
  Tabs,
  type Theme,
  Tooltip,
  Typography,
} from '@mui/material';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  attachCommand,
  attachmentName,
  CH_ERROR,
  CH_STDERR,
  CH_STDIN,
  CH_STDOUT,
  chunkBase64,
  CLIENT_PID_OSC,
  ctrled,
  frameResize,
  frameText,
  keyboardInset,
  killClientCommand,
  killSessionCommand,
  LIST_SESSIONS_COMMAND,
  MAX_RECONNECTS,
  mergeSessions,
  mergeTitles,
  mouseReport,
  parseSessions,
  parseStatus,
  reconnectDelay,
  retype,
  scrollSteps,
  SHIFT_ENTER,
  shifted,
  unframe,
  unwrapRows,
  uploadCommand,
  WHEEL_DOWN,
  WHEEL_UP,
} from './exec';
import { ensureTerminalFont, TERMINAL_FONT, TERMINAL_FONT_LOADING } from './font';
import { AgentLauncher, AGENTS } from './sandbox';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SESSION_POLL_MS = 5000;
// Android's own long press is 400-500ms; under that a still finger is still a tap.
const LONG_PRESS_MS = 400;
// Pixels a finger may wander and still count as held, under the row a scroll step takes.
const LONG_PRESS_SLOP = 8;

const KEYS: { label: string; bytes: string }[] = [
  { label: 'Esc', bytes: '\x1b' },
  { label: 'Tab', bytes: '\t' },
  { label: 'Ctrl-C', bytes: '\x03' },
  { label: 'Ctrl-D', bytes: '\x04' },
  { label: 'Ctrl-Z', bytes: '\x1a' },
  { label: 'Ctrl-B', bytes: '\x02' },
  { label: '↑', bytes: '\x1b[A' },
  { label: '↓', bytes: '\x1b[B' },
  { label: '←', bytes: '\x1b[D' },
  { label: '→', bytes: '\x1b[C' },
  { label: 'Home', bytes: '\x1b[H' },
  { label: 'End', bytes: '\x1b[F' },
];

// Canceling pointerdown keeps the terminal focused, so a tap does not close the phone keyboard.
// touchstart is the wrong event for this: canceling it also suppresses the click.
function keepFocus(event: React.SyntheticEvent): void {
  event.preventDefault();
}

type ExecStream = { cancel: () => void; getSocket: () => WebSocket | null };

interface ExecResult {
  stdout: string;
  error: string | null;
}

interface RunExecOptions {
  input?: { chunks: string[]; onProgress: (sent: number) => void };
  /** Checked at every await, so a disposed caller stops the transfer. */
  isCancelled?: () => boolean;
  onStream?: (stream: ExecStream) => void;
}

// Keyed by pod name, which the controller reuses for the sandbox's replacement pod.
function activeTabKey(pod: Pod): string {
  return `headlamp-agent-sandbox.active-tab.${pod.metadata?.namespace}/${pod.metadata?.name}`;
}

// Storage can be missing or throw (private windows, blocked site data); the tab is a convenience.
function readActiveTab(pod: Pod): string | null {
  try {
    return localStorage.getItem(activeTabKey(pod));
  } catch {
    return null;
  }
}

function writeActiveTab(pod: Pod, session: string): void {
  try {
    localStorage.setItem(activeTabKey(pod), session);
  } catch {
    // Not remembering the tab is harmless.
  }
}

// connectCb means "about to connect": it runs before pod.exec() has even returned, and the
// socket only exists once the connection promise resolves. Waiting for it is the only way in.
async function waitForOpenSocket(
  stream: ExecStream,
  isCancelled: () => boolean
): Promise<WebSocket | null> {
  let socket = stream.getSocket();
  while (!socket) {
    if (isCancelled()) {
      return null;
    }
    await new Promise(wake => setTimeout(wake, 20));
    socket = stream.getSocket();
  }
  if (socket.readyState === WebSocket.CONNECTING) {
    const connecting = socket;
    await new Promise<void>(resolve => {
      connecting.addEventListener('open', () => resolve(), { once: true });
      connecting.addEventListener('close', () => resolve(), { once: true });
    });
  }
  return !isCancelled() && socket.readyState === WebSocket.OPEN ? socket : null;
}

/** Runs one non-interactive command to completion, optionally streaming base64 chunks to its stdin. */
function runExec(
  pod: Pod,
  container: string,
  command: string[],
  options: RunExecOptions = {}
): Promise<ExecResult> {
  return new Promise<ExecResult>(resolve => {
    const output: Uint8Array[] = [];
    let settled = false;

    const cancelled = (): boolean => settled || options.isCancelled?.() === true;

    const finish = (error: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      stream.cancel();
      // Channels 1 and 2 interleave, so one streaming decoder would splice a held multi-byte
      // prefix from stdout onto a stderr payload; decode the whole thing once instead.
      const joined = new Uint8Array(output.reduce((total, part) => total + part.length, 0));
      let offset = 0;
      for (const part of output) {
        joined.set(part, offset);
        offset += part.length;
      }
      resolve({ stdout: new TextDecoder().decode(joined), error });
    };

    const stream: ExecStream = pod.exec(
      container,
      (data: any) => {
        const { channel, payload } = unframe(data as ArrayBuffer);
        if (channel === CH_STDOUT || channel === CH_STDERR) {
          output.push(payload);
        } else if (channel === CH_ERROR) {
          const status = parseStatus(payload);
          finish(status && !status.success ? status.message || 'the command failed' : null);
        }
      },
      {
        command,
        tty: false,
        stdin: !!options.input,
        stdout: true,
        stderr: true,
        reconnectOnFailure: false,
        failCb: () => finish('the connection closed before the command finished'),
      }
    );
    options.onStream?.(stream);

    const input = options.input;
    if (input) {
      void (async () => {
        const socket = await waitForOpenSocket(stream, cancelled);
        if (!socket) {
          return;
        }
        for (const [index, chunk] of input.chunks.entries()) {
          if (cancelled() || socket.readyState !== WebSocket.OPEN) {
            return;
          }
          socket.send(frameText(CH_STDIN, chunk));
          input.onProgress(index + 1);
          // send() on a closing socket grows bufferedAmount and it never drains again.
          while (socket.bufferedAmount > 1024 * 1024) {
            if (cancelled() || socket.readyState !== WebSocket.OPEN) {
              return;
            }
            await new Promise(wake => setTimeout(wake, 20));
          }
        }
      })();
    }
  });
}

function readBase64(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsDataURL(file);
  });
}

interface TerminalPaneProps {
  pod: Pod;
  container: string;
  session: string;
  run: string | undefined;
  /** Clears `run`, so remounting the pane on a later tab switch does not type it again. */
  onLaunched: (session: string) => void;
  workspace: string;
  fullscreen: boolean;
  /** Only a refit trigger: the pane is sized by its parent, not by this number. */
  viewportHeight: number | null;
  /** Pixels above the layout viewport's bottom to pin the key toolbar; 0 leaves it in flow. */
  pinBottom: number;
  /** Must be referentially stable: it is a dependency of the effect that owns the socket. */
  onTitle: (session: string, title: string) => void;
}

function TerminalPane({
  pod,
  container,
  session,
  run,
  onLaunched,
  workspace,
  fullscreen,
  viewportHeight,
  pinBottom,
  onTitle,
}: TerminalPaneProps): React.ReactNode {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const runRef = useRef(run);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const streamRef = useRef<ExecStream | null>(null);
  const uploadStreamRef = useRef<ExecStream | null>(null);
  const disposedRef = useRef(false);
  const pendingRef = useRef<Uint8Array[]>([]);
  const ctrlArmedRef = useRef(false);
  const shiftArmedRef = useRef(false);
  const fontAppliedRef = useRef(false);
  const sizeRef = useRef({ cols: 0, rows: 0 });
  // The IME's text since the last other input, kept in the textarea for next-word predictions.
  const imeTextRef = useRef('');
  const imeSendingRef = useRef(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [shiftArmed, setShiftArmed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{ name: string; sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Hides the fallback monospace, so the pane never visibly swaps fonts once the face loads.
  const [fontApplied, setFontApplied] = useState(false);
  // xterm has no touch selection, so the screen is shown as page text for the phone's own.
  const [screenText, setScreenText] = useState<string | null>(null);

  const showScreen = useCallback((): void => {
    const term = termRef.current;
    if (!term) {
      return;
    }
    const buffer = term.buffer.active;
    const rows: { text: string; wrapped: boolean }[] = [];
    for (let row = 0; row < term.rows; row += 1) {
      const line = buffer.getLine(buffer.viewportY + row);
      rows.push({ text: line?.translateToString(true) ?? '', wrapped: line?.isWrapped ?? false });
    }
    setScreenText(unwrapRows(rows));
  }, []);

  const send = useCallback((bytes: Uint8Array): void => {
    // Any other input can change the remote line under the IME's text, so the IME starts over.
    const textarea = termRef.current?.textarea;
    if (!imeSendingRef.current && imeTextRef.current && textarea) {
      textarea.value = '';
      imeTextRef.current = '';
    }
    const socket = streamRef.current?.getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(bytes);
    } else {
      pendingRef.current.push(bytes);
    }
  }, []);

  // Every geometry change funnels here. The phone keyboard animation alone fires a resize per
  // frame and each frameResize is a socket message, so unchanged dimensions are dropped.
  const refit = useCallback((): void => {
    const term = termRef.current;
    const holder = holderRef.current;
    if (!term || !holder?.offsetParent) {
      return;
    }
    fitRef.current?.fit();
    if (term.cols === sizeRef.current.cols && term.rows === sizeRef.current.rows) {
      return;
    }
    sizeRef.current = { cols: term.cols, rows: term.rows };
    // Never queued: a resize sent at socket open carries whatever the size is by then.
    const socket = streamRef.current?.getSocket();
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(frameResize(term.cols, term.rows));
    }
  }, []);

  const armCtrl = useCallback((armed: boolean): void => {
    ctrlArmedRef.current = armed;
    setCtrlArmed(armed);
  }, []);

  const armShift = useCallback((armed: boolean): void => {
    shiftArmedRef.current = armed;
    setShiftArmed(armed);
  }, []);

  // onData is registered once at mount, so the armed flags have to be read from the refs.
  const sendKey = useCallback(
    (data: string): void => {
      let key = data;
      if (shiftArmedRef.current) {
        const chord = shifted(key);
        if (chord !== undefined) {
          armShift(false);
          key = chord;
        }
      }
      if (ctrlArmedRef.current) {
        const chord = ctrled(key);
        if (chord !== undefined) {
          armCtrl(false);
          key = chord;
        }
      }
      send(frameText(CH_STDIN, key));
    },
    [send, armCtrl, armShift]
  );

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) {
      return undefined;
    }

    disposedRef.current = false;
    let cancelled = false;
    // A status frame means the process exited on its own; only a close without one is a drop.
    let ended = false;
    let attempts = 0;
    let clientPid: string | null = null;

    // Closing the exec leaves its tmux client running under runsc, so kill it explicitly.
    const killClient = (): void => {
      if (clientPid !== null) {
        void runExec(pod, container, killClientCommand(clientPid));
        clientPid = null;
      }
    };
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let retryOnForeground = false;

    let hoveredUri: string | null = null;
    const withCtrl = (event: MouseEvent): boolean =>
      event.ctrlKey || event.metaKey || ctrlArmedRef.current;
    const touch = window.matchMedia?.('(pointer: coarse)').matches ?? false;

    const term = new XTerm({
      // 13 fits a phone's columns but reads small on a desktop monitor.
      fontSize: touch ? 13 : 15,
      fontFamily: TERMINAL_FONT_LOADING,
      cursorBlink: true,
      scrollback: 10000,
      // Replaces xterm's native confirm(), which Brave silently dismisses after the first open.
      // A tap opens the link on a phone. On a desktop a plain click stays a tmux click, and
      // Ctrl/Cmd or the sticky Ctrl key opens the link.
      linkHandler: {
        activate: (event, uri) => {
          if (event.button !== 0 || !(touch || withCtrl(event))) {
            return;
          }
          armCtrl(false);
          window.open(uri, '_blank', 'noopener');
        },
        hover: (_event, uri) => {
          hoveredUri = uri;
        },
        leave: () => {
          hoveredUri = null;
        },
      },
    });

    // Ctrl/Cmd + right-click copies the hovered link. Plain right-click is left to tmux's menu.
    const onContextMenu = (event: MouseEvent): void => {
      // A native held finger fires this too, and xterm's right-click handler would focus its
      // textarea and open the keyboard, so it is stopped before reaching xterm.
      if (touchSelecting || pressTimer !== null) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (hoveredUri === null || !withCtrl(event)) {
        return;
      }
      event.preventDefault();
      armCtrl(false);
      void navigator.clipboard.writeText(hoveredUri);
    };
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holder);
    termRef.current = term;
    fitRef.current = fit;

    // Returning false skips xterm's own preventDefault and composition handling as well as the
    // keypress it would otherwise turn into a bare CR, so both are covered here.
    term.attachCustomKeyEventHandler(event => {
      // Left to the browser, so Ctrl+V pastes (an image uploads) instead of sending ^V.
      if (
        event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === 'v'
      ) {
        return false;
      }
      if (
        event.key !== 'Enter' ||
        !event.shiftKey ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.isComposing ||
        event.keyCode === 229
      ) {
        return true;
      }
      if (event.type === 'keydown') {
        event.preventDefault();
        armShift(false);
        armCtrl(false);
        send(frameText(CH_STDIN, SHIFT_ENTER));
      }
      return false;
    });

    // xterm's own IME handling duplicates text around Gboard and Samsung predictions, so its
    // textarea listeners are cut off here and each textarea change is sent as a retype instead.
    const textarea = term.textarea;
    imeTextRef.current = '';
    let realKey = false;
    const onImeEvent = (event: Event): void => {
      if (event.target !== textarea || !textarea) {
        return;
      }
      if (event instanceof KeyboardEvent) {
        realKey = event.type === 'keydown' && event.keyCode !== 229;
        if (realKey || event.type === 'keyup') {
          return;
        }
      }
      event.stopPropagation();
      if (event.type !== 'input' && event.type !== 'compositionend') {
        return;
      }
      // xterm already sent a real key from its keypress, which Chrome still follows with input.
      if (realKey && !(event as InputEvent).isComposing) {
        imeTextRef.current = textarea.value;
        return;
      }
      const keys = retype(imeTextRef.current, textarea.value);
      imeTextRef.current = textarea.value;
      if (keys) {
        imeSendingRef.current = true;
        sendKey(keys);
        imeSendingRef.current = false;
      }
    };
    const IME_EVENTS = [
      'keydown',
      'keyup',
      'compositionstart',
      'compositionupdate',
      'compositionend',
      'input',
    ];
    IME_EVENTS.forEach(type => holder.addEventListener(type, onImeEvent, true));

    const onFrame = (data: any): void => {
      const { channel, payload } = unframe(data as ArrayBuffer);
      if (channel === CH_STDOUT || channel === CH_STDERR) {
        term.write(payload);
      } else if (channel === CH_ERROR) {
        ended = true;
        const status = parseStatus(payload);
        if (status && !status.success) {
          term.write(`\r\n\x1b[31m${status.message || 'The session ended.'}\x1b[0m\r\n`);
        }
      }
    };

    term.parser.registerOscHandler(CLIENT_PID_OSC, data => {
      if (/^\d+$/.test(data)) {
        clientPid = data;
      }
      return true;
    });
    // OSC 52 is how tmux copy-mode (and apps inside it) set the clipboard. xterm ignores it.
    // A `?` read query is never answered, so the pod cannot read the local clipboard.
    term.parser.registerOscHandler(52, data => {
      const encoded = data.slice(data.indexOf(';') + 1);
      if (encoded && encoded !== '?') {
        try {
          const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
          void navigator.clipboard.writeText(new TextDecoder().decode(bytes));
        } catch {
          // Malformed base64 from the pod; nothing to copy.
        }
      }
      return true;
    });

    // Exec'ing tmux directly means the process is tmux, not a login shell, so the image's rc
    // never runs its own `exec tmux new -A -s main` and each tab gets its own named session.
    // The same `new -A` is what makes a reconnect a plain reattach.
    const connect = (first: boolean): void => {
      killClient();
      const stream: ExecStream = pod.exec(container, onFrame, {
        command: attachCommand(session),
        tty: true,
        stdin: true,
        stdout: true,
        stderr: true,
        reconnectOnFailure: false,
        failCb: onFail,
      });
      streamRef.current = stream;

      void (async () => {
        const socket = await waitForOpenSocket(
          stream,
          () => cancelled || streamRef.current !== stream
        );
        if (!socket) {
          return;
        }
        attempts = 0;
        if (holder.offsetParent) {
          fit.fit();
        }
        sizeRef.current = { cols: term.cols, rows: term.rows };
        socket.send(frameResize(term.cols, term.rows));
        // Typed into the shell rather than passed to tmux: tmux would exec the binary and skip the
        // image's rc, where `claude` is a function supplying the unique socket path it needs.
        if (first && runRef.current !== undefined) {
          socket.send(frameText(CH_STDIN, `${runRef.current}\n`));
          runRef.current = undefined;
          onLaunched(session);
        }
        pendingRef.current.splice(0).forEach(bytes => socket.send(bytes));
      })();
    };

    function onFail(): void {
      if (cancelled) {
        return;
      }
      // Keys typed into the dead socket are gone; replaying them into a fresh attach is worse.
      pendingRef.current.length = 0;
      if (ended || attempts >= MAX_RECONNECTS) {
        cancelled = true;
        term.write('\r\n\x1b[31mConnection closed.\x1b[0m\r\n');
        return;
      }
      attempts += 1;
      term.write(
        `\r\n\x1b[33mConnection lost, reconnecting (${attempts}/${MAX_RECONNECTS})...\x1b[0m\r\n`
      );
      // A sleeping phone has no network; retrying now would only burn the attempts.
      if (document.visibilityState === 'hidden') {
        retryOnForeground = true;
        return;
      }
      retryTimer = setTimeout(() => {
        retryTimer = null;
        connect(false);
      }, reconnectDelay(attempts));
    }

    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible' || cancelled) {
        return;
      }
      if (retryOnForeground || retryTimer !== null) {
        retryOnForeground = false;
        if (retryTimer !== null) {
          clearTimeout(retryTimer);
          retryTimer = null;
        }
        connect(false);
        return;
      }
      // A socket the browser still reports open may be dead after a suspend; the resize is a
      // probe, since the first send on a dead socket is what surfaces its close.
      const socket = streamRef.current?.getSocket();
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(frameResize(term.cols, term.rows));
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    connect(true);

    const typing = term.onData(sendKey);
    const titling = term.onTitleChange(title => onTitle(session, title));
    // Copy on select, as terminals do: Ctrl+Shift+C is DevTools in Brave, and the Shift-forced
    // selection under tmux mouse mode does not survive the mouseup.
    const selecting = term.onSelectionChange(() => {
      const text = term.getSelection();
      if (text) {
        void navigator.clipboard.writeText(text);
      }
    });
    const observer = new ResizeObserver(refit);
    observer.observe(holder);

    // xterm has no touch scrolling, and under tmux there is no xterm scrollback to scroll anyway:
    // tmux holds the history and listens for wheel reports. Turn a drag into both.
    let dragY: number | null = null;
    let dragPixels = 0;
    // A drag already scrolls, so a held finger is what starts a tmux selection. It goes out as SGR
    // mouse reports, as a desktop mouse drag would; tmux copies on release and OSC 52 lands above.
    let pressTimer: ReturnType<typeof setTimeout> | null = null;
    let pressStart = { x: 0, y: 0 };
    let touchSelecting = false;
    let selectedCell = '';
    // With the keyboard up, touchstart is canceled so the browser makes no gestures of its own: no
    // long press racing ours, no focus shuffle that flashes the keyboard. Taps are rebuilt below.
    // With it down the touch stays native, since only a real tap makes Android open the keyboard.
    let tapping = false;

    const cellAt = (x: number, y: number): [number, number] => {
      const screen = term.element?.querySelector('.xterm-screen') ?? holder;
      const rect = screen.getBoundingClientRect();
      const col = Math.floor(((x - rect.left) / rect.width) * term.cols) + 1;
      const row = Math.floor(((y - rect.top) / rect.height) * term.rows) + 1;
      return [Math.min(Math.max(col, 1), term.cols), Math.min(Math.max(row, 1), term.rows)];
    };
    const report = (kind: 'press' | 'drag' | 'release', x: number, y: number): void => {
      const [col, row] = cellAt(x, y);
      selectedCell = `${col};${row}`;
      send(frameText(CH_STDIN, mouseReport(kind, col, row)));
    };
    const startTouchSelection = (): void => {
      cancelPress();
      tapping = false;
      touchSelecting = true;
      navigator.vibrate?.(10);
      report('press', pressStart.x, pressStart.y);
    };
    const cancelPress = (): void => {
      if (pressTimer !== null) {
        clearTimeout(pressTimer);
        pressTimer = null;
      }
    };

    const onTouchStart = (event: TouchEvent): void => {
      if (document.activeElement === term.textarea) {
        event.preventDefault();
      }
      dragY = event.touches.length === 1 ? event.touches[0].clientY : null;
      dragPixels = 0;
      cancelPress();
      tapping = event.touches.length === 1 && event.defaultPrevented;
      if (event.touches.length !== 1) {
        return;
      }
      pressStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
      if (term.modes.mouseTrackingMode !== 'none') {
        pressTimer = setTimeout(startTouchSelection, LONG_PRESS_MS);
      }
    };

    // The mouse events a browser makes from a tap. xterm focuses (opening the keyboard, as this
    // runs inside the touchend), reports the click to tmux, and opens a link under the finger.
    const tap = (x: number, y: number): void => {
      const target = document.elementFromPoint(x, y) ?? holder;
      (['mousemove', 'mousedown', 'mouseup', 'click'] as const).forEach(type =>
        target.dispatchEvent(
          new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === 'mousedown' ? 1 : 0,
          })
        )
      );
    };

    const onTouchMove = (event: TouchEvent): void => {
      if (touchSelecting) {
        event.preventDefault();
        const { clientX, clientY } = event.touches[0];
        const [col, row] = cellAt(clientX, clientY);
        if (`${col};${row}` !== selectedCell) {
          report('drag', clientX, clientY);
        }
        return;
      }
      if (
        Math.hypot(
          event.touches[0].clientX - pressStart.x,
          event.touches[0].clientY - pressStart.y
        ) > LONG_PRESS_SLOP
      ) {
        cancelPress();
        tapping = false;
      }
      if (dragY === null || event.touches.length !== 1) {
        return;
      }
      const y = event.touches[0].clientY;
      dragPixels += y - dragY;
      dragY = y;
      // Measured, not tuned: one drag pixel stays one row whatever the font size and zoom are.
      const rowHeight = (term.element?.clientHeight ?? 0) / term.rows;
      const steps = scrollSteps(dragPixels, rowHeight);
      if (steps === 0) {
        return;
      }
      dragPixels -= steps * rowHeight;
      // Only now, once this is a scroll and not a tap: canceling a native touch earlier would eat
      // the tap that focuses the terminal and opens the keyboard.
      event.preventDefault();
      // Dragging the content down reveals older output, so a positive delta scrolls back.
      if (term.modes.mouseTrackingMode === 'none') {
        term.scrollLines(-steps);
      } else {
        send(frameText(CH_STDIN, (steps > 0 ? WHEEL_UP : WHEEL_DOWN).repeat(Math.abs(steps))));
      }
    };

    const onTouchEnd = (event: TouchEvent): void => {
      cancelPress();
      if (tapping && event.type === 'touchend') {
        tap(pressStart.x, pressStart.y);
      }
      tapping = false;
      if (!touchSelecting) {
        return;
      }
      touchSelecting = false;
      // Not a tap: no click, so the keyboard stays as it was.
      event.preventDefault();
      const [col, row] = selectedCell.split(';').map(Number);
      send(frameText(CH_STDIN, mouseReport('release', col, row)));
    };

    holder.addEventListener('contextmenu', onContextMenu, { capture: true });
    holder.addEventListener('touchstart', onTouchStart, { passive: false });
    holder.addEventListener('touchmove', onTouchMove, { passive: false });
    holder.addEventListener('touchend', onTouchEnd, { passive: false });
    holder.addEventListener('touchcancel', onTouchEnd, { passive: false });

    return () => {
      disposedRef.current = true;
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
      }
      document.removeEventListener('visibilitychange', onVisibility);
      observer.disconnect();
      holder.removeEventListener('contextmenu', onContextMenu, { capture: true });
      holder.removeEventListener('touchstart', onTouchStart);
      holder.removeEventListener('touchmove', onTouchMove);
      holder.removeEventListener('touchend', onTouchEnd);
      holder.removeEventListener('touchcancel', onTouchEnd);
      cancelPress();
      IME_EVENTS.forEach(type => holder.removeEventListener(type, onImeEvent, true));
      typing.dispose();
      titling.dispose();
      selecting.dispose();
      killClient();
      streamRef.current?.cancel();
      uploadStreamRef.current?.cancel();
      uploadStreamRef.current = null;
      term.dispose();
      streamRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      fontAppliedRef.current = false;
      setFontApplied(false);
    };
  }, [pod, container, session, send, sendKey, refit, armShift, armCtrl, onTitle, onLaunched]);

  useEffect(() => {
    refit();
    termRef.current?.focus();
    // fullscreen and the phone keyboard both resize the pane; without a refit the remote pty
    // keeps the old dimensions and the display corrupts.
  }, [fullscreen, viewportHeight, refit]);

  // Applied once the pane has a layout box: xterm re-measures the cell on the option change.
  useEffect(() => {
    if (fontAppliedRef.current) {
      return;
    }
    ensureTerminalFont()
      .then(() => {
        const term = termRef.current;
        if (!term || fontAppliedRef.current || !holderRef.current?.offsetParent) {
          return;
        }
        fontAppliedRef.current = true;
        term.options.fontFamily = TERMINAL_FONT;
        refit();
        setFontApplied(true);
      })
      .catch((error: unknown) => {
        console.warn('Terminal font could not be applied.', error);
      });
    // The term is recreated with the mount effect's inputs; the font has to follow it.
  }, [refit, pod, container, session]);

  const handleFiles = useCallback(
    async (files: File[]): Promise<void> => {
      for (const file of files) {
        if (disposedRef.current) {
          return;
        }
        if (file.size > MAX_UPLOAD_BYTES) {
          setError(
            `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MiB; the limit is 10 MiB.`
          );
          continue;
        }

        let encoded: string;
        try {
          encoded = await readBase64(file);
        } catch (err) {
          if (!disposedRef.current) {
            setError(`Could not read ${file.name}: ${(err as Error).message}`);
          }
          continue;
        }
        if (disposedRef.current) {
          return;
        }

        const directory = `${workspace}/.attachments`;
        const path = `${directory}/${attachmentName(file.name)}`;
        const chunks = chunkBase64(encoded);
        setError(null);
        setUpload({ name: file.name, sent: 0, total: chunks.length });
        // A second, non-interactive exec keeps the file bytes out of the agent's terminal.
        const result = await runExec(
          pod,
          container,
          uploadCommand(directory, path, encoded.length),
          {
            input: {
              chunks,
              onProgress: sent => setUpload(current => (current ? { ...current, sent } : current)),
            },
            isCancelled: () => disposedRef.current,
            onStream: stream => {
              uploadStreamRef.current = stream;
            },
          }
        );
        uploadStreamRef.current = null;
        if (disposedRef.current) {
          return;
        }
        setUpload(null);

        if (result.error) {
          setError(`Upload of ${file.name} failed: ${result.error}`);
          continue;
        }
        send(frameText(CH_STDIN, `${path} `));
      }
    },
    [pod, container, workspace, send]
  );

  const pinned = pinBottom > 0 && !fullscreen;

  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        // flex, not height 100%: that resolves against the whole container, so the tab bar above
        // pushed the pane's bottom — the key toolbar — past the fullscreen overflow and clipped it.
        flex: 1,
        minHeight: 0,
        position: 'relative',
      }}
      onDragOver={event => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={event => {
        event.preventDefault();
        setDragging(false);
        void handleFiles(Array.from(event.dataTransfer.files));
      }}
      // Capture, so xterm's own paste handler on the textarea never sees an image paste.
      onPasteCapture={event => {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void handleFiles(files);
      }}
    >
      {error && (
        <Alert severity="error" onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {upload && (
        <Box sx={{ px: 1, py: 0.5 }}>
          <Typography variant="caption">Uploading {upload.name}</Typography>
          <LinearProgress
            variant="determinate"
            value={upload.total > 0 ? (upload.sent / upload.total) * 100 : 100}
          />
        </Box>
      )}
      {/* minHeight 0 overrides the flex default of auto, so the open keyboard shrinks the
          terminal instead of pushing the key toolbar off the bottom. */}
      <Box
        ref={holderRef}
        // touchAction none is what makes the drag ours: without it the browser starts its own
        // pan first and then ignores preventDefault for the rest of the gesture, so the page
        // scrolls and Android's pull-to-refresh fires. overscrollBehavior stops what is left
        // from chaining to the page.
        sx={{
          flexGrow: 1,
          minHeight: 0,
          overflow: 'hidden',
          touchAction: 'none',
          overscrollBehavior: 'contain',
          // The phone's own long-press text selection and callout would fight the tmux one.
          userSelect: 'none',
          WebkitTouchCallout: 'none',
          // opacity, not visibility: a hidden textarea refuses the focus the pane takes on show.
          opacity: fontApplied ? 1 : 0,
        }}
      />
      {!fontApplied && (
        <CircularProgress
          size={32}
          sx={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            mt: -2,
            ml: -2,
            pointerEvents: 'none',
          }}
        />
      )}
      {/* Pinned, it floats over the page instead of reserving a spacer: the pane's height is
          fixed, so nothing below it moves, and the holder regrowing refits via the observer. */}
      <Box
        sx={{
          display: 'flex',
          gap: 0.5,
          p: 0.5,
          overflowX: 'auto',
          '& > *': { flexShrink: 0 },
          borderTop: 1,
          borderColor: 'divider',
          ...(pinned && {
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: `${pinBottom}px`,
            // Clears Headlamp's app bar; stays under the fullscreen overlay's modal layer.
            zIndex: (theme: Theme) => theme.zIndex.drawer,
            bgcolor: 'background.paper',
          }),
        }}
      >
        <Button
          size="small"
          variant={ctrlArmed ? 'contained' : 'outlined'}
          aria-pressed={ctrlArmed}
          sx={{ minWidth: 40, px: 1 }}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => armCtrl(!ctrlArmed)}
        >
          Ctrl
        </Button>
        <Button
          size="small"
          variant={shiftArmed ? 'contained' : 'outlined'}
          aria-pressed={shiftArmed}
          sx={{ minWidth: 40, px: 1 }}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => armShift(!shiftArmed)}
        >
          Shift
        </Button>
        {KEYS.map(key => (
          <Button
            key={key.label}
            size="small"
            variant="outlined"
            sx={{ minWidth: 40, px: 1 }}
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
            onClick={() => sendKey(key.bytes)}
          >
            {key.label}
          </Button>
        ))}
        <Button
          size="small"
          variant="outlined"
          sx={{ minWidth: 40, px: 1 }}
          startIcon={<Icon icon="mdi:paperclip" />}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={() => fileRef.current?.click()}
        >
          Upload
        </Button>
        <Button
          size="small"
          variant="outlined"
          sx={{ minWidth: 40, px: 1 }}
          startIcon={<Icon icon="mdi:cursor-text" />}
          onPointerDown={keepFocus}
          onMouseDown={keepFocus}
          onClick={showScreen}
        >
          Select
        </Button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          aria-label="Choose files to upload"
          onChange={event => {
            const files = Array.from(event.target.files ?? []);
            // Clearing it is what lets the same file be picked twice in a row.
            event.target.value = '';
            if (files.length > 0) {
              void handleFiles(files);
            }
          }}
        />
      </Box>
      <Dialog open={screenText !== null} onClose={() => setScreenText(null)} maxWidth={false}>
        <DialogContent>
          <Box
            component="pre"
            sx={{
              m: 0,
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              userSelect: 'text',
              fontFamily: TERMINAL_FONT,
              fontSize: 13,
            }}
          >
            {screenText}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => void navigator.clipboard.writeText(screenText ?? '')}>
            Copy all
          </Button>
          <Button onClick={() => setScreenText(null)}>Close</Button>
        </DialogActions>
      </Dialog>
      {dragging && (
        <Box
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: '2px dashed',
            borderColor: 'primary.main',
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
            pointerEvents: 'none',
          }}
        >
          <Typography variant="h6">Drop files to upload to {workspace}/.attachments</Typography>
        </Box>
      )}
    </Box>
  );
}

export interface SandboxTerminalProps {
  pod: Pod;
  container: string;
  namespace: string;
  workspace?: string;
}

export function SandboxTerminal({
  pod,
  container,
  workspace = '/workspace',
}: SandboxTerminalProps): React.ReactNode {
  const [sessions, setSessions] = useState<string[] | null>(null);
  const [commands, setCommands] = useState<Record<string, string | undefined>>({});
  const [active, setActive] = useState('');
  const [titles, setTitles] = useState<Record<string, string | undefined>>({});
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const activeRef = useRef(active);
  const killedRef = useRef(new Set<string>());
  // The tab to reopen once it is listed, until the user picks one; nothing is saved meanwhile.
  const savedTabRef = useRef(readActiveTab(pod));
  // On a phone the in-page box sits below the fold; the viewport-sized overlay is the usable one.
  const [fullscreen, setFullscreen] = useState(
    () => window.matchMedia?.('(pointer: coarse)').matches ?? false
  );
  const [viewport, setViewport] = useState<{
    height: number;
    top: number;
    keyboard: number;
  } | null>(null);

  // `position: fixed` sizes to the layout viewport, which the phone keyboard does not shrink, so
  // the key toolbar and the prompt slide underneath it. The visual viewport is the real one, and
  // the keyboard opens in either mode, so this tracks it whether or not we are fullscreen.
  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) {
      return undefined;
    }
    let frame = 0;
    const update = (): void => {
      // The keyboard animation fires a resize per frame; one update per frame is plenty.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setViewport({
          height: visual.height,
          top: visual.offsetTop,
          keyboard: keyboardInset(window.innerHeight, visual.height, visual.offsetTop),
        })
      );
    };
    update();
    visual.addEventListener('resize', update);
    visual.addEventListener('scroll', update);
    return () => {
      cancelAnimationFrame(frame);
      visual.removeEventListener('resize', update);
      visual.removeEventListener('scroll', update);
    };
  }, []);

  const onTitle = useCallback((session: string, title: string) => {
    setTitles(current => ({ ...current, [session]: title }));
  }, []);

  const onLaunched = useCallback((session: string) => {
    setCommands(current => ({ ...current, [session]: undefined }));
  }, []);

  // tmux-resurrect restores a replacement pod's sessions well after this mounts, so keep listing.
  useEffect(() => {
    let cancelled = false;
    let listing = false;
    let first = true;
    const refresh = (): void => {
      if (listing) {
        return;
      }
      listing = true;
      void runExec(pod, container, LIST_SESSIONS_COMMAND).then(result => {
        listing = false;
        if (cancelled) {
          return;
        }
        // A later failure is left out so it cannot hide the error of a user action.
        if (first) {
          first = false;
          setListError(result.error);
        } else if (result.error) {
          return;
        }
        const { names, titles: listed } = parseSessions(result.stdout);
        setSessions(current => mergeSessions(current ?? [], names, killedRef.current));
        setTitles(current => mergeTitles(current, listed, activeRef.current));
      });
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };
    refresh();
    const timer = setInterval(onVisibility, SESSION_POLL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [pod, container]);

  // Falls back to the first tab while the saved one is not restored yet, then moves to it once.
  useEffect(() => {
    if (!sessions?.length) {
      return;
    }
    const saved = savedTabRef.current;
    if (saved !== null && sessions.includes(saved)) {
      savedTabRef.current = null;
      setActive(saved);
    } else if (!sessions.includes(active)) {
      setActive(sessions[0]);
    }
  }, [sessions, active]);

  useEffect(() => {
    activeRef.current = active;
    if (active && savedTabRef.current === null) {
      writeActiveTab(pod, active);
    }
  }, [pod, active]);

  function selectTab(session: string): void {
    savedTabRef.current = null;
    setActive(session);
  }

  // `tmux new -A` silently attaches and drops the command argument if the name is taken, so the
  // name has to be chosen against what the pod has right now, not against the last list.
  async function openSession(agent: AgentLauncher): Promise<void> {
    setAddAnchor(null);
    const local = sessions ?? [];
    const result = await runExec(pod, container, LIST_SESSIONS_COMMAND);
    setListError(result.error);
    const taken = new Set([...local, ...(result.error ? [] : parseSessions(result.stdout).names)]);
    let name = agent.id;
    for (let suffix = 2; taken.has(name); suffix++) {
      name = `${agent.id}-${suffix}`;
    }
    killedRef.current.delete(name);
    setSessions(current => mergeSessions(current ?? [], [name], killedRef.current));
    setCommands(current => ({ ...current, [name]: agent.command }));
    selectTab(name);
  }

  async function killSession(session: string): Promise<void> {
    setKilling(null);
    // Before the kill, so a list already in flight cannot bring the tab back. Kept on failure: a
    // dropped connection may still have killed it, and a tab is never dropped once merged back.
    killedRef.current.add(session);
    const result = await runExec(pod, container, killSessionCommand(session));
    setListError(result.error);
    const all = sessions ?? [];
    const neighbor = all.filter(name => name !== session)[Math.max(0, all.indexOf(session) - 1)];
    setSessions(current => (current ?? []).filter(name => name !== session));
    setActive(current => (current === session ? neighbor ?? '' : current));
  }

  if (sessions === null) {
    return <Loader title="Looking for terminal sessions" />;
  }

  // Headlamp's activity panels are their own stacking context, so a fixed overlay rendered in
  // place still sits under the app bar and the activity bar; on the body it covers them.
  // Toggling remounts the pane, which reattaches to tmux like a tab switch.
  return (
    <Portal disablePortal={!fullscreen}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          ...(fullscreen
            ? {
                position: 'fixed',
                zIndex: theme => theme.zIndex.modal,
                bgcolor: 'background.paper',
                overflow: 'hidden',
                // A fixed overlay still chains its overscroll to the page behind it.
                overscrollBehavior: 'contain',
                ...(viewport
                  ? { left: 0, right: 0, top: viewport.top, height: viewport.height }
                  : { inset: 0 }),
              }
            : { height: 560 }),
        }}
      >
        {listError && <Alert severity="warning">{listError}</Alert>}
        <Box
          sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}
        >
          <Tabs
            value={active || false}
            onChange={(_event, value: string) => selectTab(value)}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ flexGrow: 1, minHeight: 40 }}
          >
            {sessions.map(session => (
              <Tab
                key={session}
                value={session}
                component="div"
                sx={{ textTransform: 'none', minHeight: 40 }}
                label={
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {titles[session] || session}
                    <Tooltip title="Kill session">
                      <IconButton
                        size="small"
                        aria-label={`Kill the ${session} session`}
                        onClick={event => {
                          event.stopPropagation();
                          setKilling(session);
                        }}
                      >
                        <Icon icon="mdi:close" width={14} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                }
              />
            ))}
          </Tabs>
          <Tooltip title="New session">
            <IconButton
              aria-label="New session"
              onClick={event => setAddAnchor(event.currentTarget)}
            >
              <Icon icon="mdi:plus" />
            </IconButton>
          </Tooltip>
          <Tooltip title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
            <IconButton
              aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              onClick={() => setFullscreen(current => !current)}
            >
              <Icon icon={fullscreen ? 'mdi:fullscreen-exit' : 'mdi:fullscreen'} />
            </IconButton>
          </Tooltip>
        </Box>

        <Menu anchorEl={addAnchor} open={!!addAnchor} onClose={() => setAddAnchor(null)}>
          {AGENTS.map(agent => (
            <MenuItem key={agent.id} onClick={() => void openSession(agent)}>
              {agent.label}
            </MenuItem>
          ))}
        </Menu>

        <Dialog open={!!killing} onClose={() => setKilling(null)}>
          <DialogTitle>Kill session {killing}?</DialogTitle>
          <DialogContent>
            <DialogContentText>
              This terminates the agent running in the session and every process it started.
              Anything it has not written to the workspace is lost.
            </DialogContentText>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setKilling(null)}>Cancel</Button>
            <Button color="error" onClick={() => void killSession(killing as string)}>
              Kill session
            </Button>
          </DialogActions>
        </Dialog>

        {sessions.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <Typography>
              No terminal sessions yet. Use &ldquo;New session&rdquo; to start one.
            </Typography>
          </Box>
        ) : (
          // Only the active tab holds an exec: tmux keeps the scrollback, and every idle attach is
          // a client tmux has to render to.
          sessions.includes(active) && (
            <TerminalPane
              key={active}
              pod={pod}
              container={container}
              session={active}
              run={commands[active]}
              onLaunched={onLaunched}
              workspace={workspace}
              fullscreen={fullscreen}
              // Only fullscreen sizes the pane to the viewport; in the in-page box a viewport
              // change moves nothing, and refitting there would steal focus back on every scroll.
              viewportHeight={fullscreen ? viewport?.height ?? null : null}
              pinBottom={viewport?.keyboard ?? 0}
              onTitle={onTitle}
            />
          )
        )}
      </Box>
    </Portal>
  );
}
