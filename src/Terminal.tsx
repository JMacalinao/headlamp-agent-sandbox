import '@xterm/xterm/css/xterm.css';
import { Icon } from '@iconify/react';
import { Loader } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import type Pod from '@kinvolk/headlamp-plugin/lib/lib/k8s/pod';
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  LinearProgress,
  Menu,
  MenuItem,
  Tab,
  Tabs,
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
  frameResize,
  frameText,
  killSessionCommand,
  LIST_SESSIONS_COMMAND,
  parseStatus,
  scrollSteps,
  unframe,
  uploadCommand,
  WHEEL_DOWN,
  WHEEL_UP,
} from './exec';
import { AgentLauncher, AGENTS } from './sandbox';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

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

function parseSessions(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
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
  workspace: string;
  visible: boolean;
  fullscreen: boolean;
  /** Only a refit trigger: the pane is sized by its parent, not by this number. */
  viewportHeight: number | null;
}

function TerminalPane({
  pod,
  container,
  session,
  run,
  workspace,
  visible,
  fullscreen,
  viewportHeight,
}: TerminalPaneProps): React.ReactNode {
  const holderRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const streamRef = useRef<ExecStream | null>(null);
  const uploadStreamRef = useRef<ExecStream | null>(null);
  const disposedRef = useRef(false);
  const pendingRef = useRef<Uint8Array[]>([]);
  const ctrlArmedRef = useRef(false);
  const sizeRef = useRef({ cols: 0, rows: 0 });
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [upload, setUpload] = useState<{ name: string; sent: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback((bytes: Uint8Array): void => {
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
    send(frameResize(term.cols, term.rows));
  }, [send]);

  const armCtrl = useCallback((armed: boolean): void => {
    ctrlArmedRef.current = armed;
    setCtrlArmed(armed);
  }, []);

  // onData is registered once at mount, so the armed flag has to be read from the ref.
  const sendKey = useCallback(
    (data: string): void => {
      if (ctrlArmedRef.current && data.length === 1 && data >= ' ' && data <= '~') {
        armCtrl(false);
        send(frameText(CH_STDIN, String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f)));
        return;
      }
      send(frameText(CH_STDIN, data));
    },
    [send, armCtrl]
  );

  useEffect(() => {
    const holder = holderRef.current;
    if (!holder) {
      return undefined;
    }

    disposedRef.current = false;
    let cancelled = false;

    const term = new XTerm({ fontSize: 13, cursorBlink: true, scrollback: 10000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(holder);
    termRef.current = term;
    fitRef.current = fit;

    // Exec'ing tmux directly means the process is tmux, not a login shell, so the image's rc
    // never runs its own `exec tmux new -A -s main` and each tab gets its own named session.
    const stream: ExecStream = pod.exec(
      container,
      (data: any) => {
        const { channel, payload } = unframe(data as ArrayBuffer);
        if (channel === CH_STDOUT || channel === CH_STDERR) {
          term.write(payload);
        } else if (channel === CH_ERROR) {
          const status = parseStatus(payload);
          if (status && !status.success) {
            term.write(`\r\n\x1b[31m${status.message || 'The session ended.'}\x1b[0m\r\n`);
          }
        }
      },
      {
        command: attachCommand(session),
        tty: true,
        stdin: true,
        stdout: true,
        stderr: true,
        reconnectOnFailure: false,
        failCb: () => {
          cancelled = true;
          term.write('\r\n\x1b[31mConnection closed.\x1b[0m\r\n');
        },
      }
    );
    streamRef.current = stream;

    void (async () => {
      const socket = await waitForOpenSocket(stream, () => cancelled);
      if (!socket) {
        return;
      }
      if (holder.offsetParent) {
        fit.fit();
      }
      socket.send(frameResize(term.cols, term.rows));
      // Typed into the shell rather than passed to tmux: tmux would exec the binary and skip the
      // image's rc, where `claude` is a function supplying the unique socket path it needs.
      if (run !== undefined) {
        socket.send(frameText(CH_STDIN, `${run}\n`));
      }
      pendingRef.current.splice(0).forEach(bytes => socket.send(bytes));
    })();

    const typing = term.onData(sendKey);
    const observer = new ResizeObserver(refit);
    observer.observe(holder);

    // xterm has no touch scrolling, and under tmux there is no xterm scrollback to scroll anyway:
    // tmux holds the history and listens for wheel reports. Turn a drag into both.
    let dragY: number | null = null;
    let dragPixels = 0;

    const onTouchStart = (event: TouchEvent): void => {
      dragY = event.touches.length === 1 ? event.touches[0].clientY : null;
      dragPixels = 0;
    };

    const onTouchMove = (event: TouchEvent): void => {
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
      // Only now, once this is a scroll and not a tap: canceling earlier would eat the tap that
      // focuses the terminal and opens the keyboard.
      event.preventDefault();
      // Dragging the content down reveals older output, so a positive delta scrolls back.
      if (term.modes.mouseTrackingMode === 'none') {
        term.scrollLines(-steps);
      } else {
        send(frameText(CH_STDIN, (steps > 0 ? WHEEL_UP : WHEEL_DOWN).repeat(Math.abs(steps))));
      }
    };

    holder.addEventListener('touchstart', onTouchStart, { passive: true });
    holder.addEventListener('touchmove', onTouchMove, { passive: false });

    return () => {
      disposedRef.current = true;
      cancelled = true;
      observer.disconnect();
      holder.removeEventListener('touchstart', onTouchStart);
      holder.removeEventListener('touchmove', onTouchMove);
      typing.dispose();
      stream.cancel();
      uploadStreamRef.current?.cancel();
      uploadStreamRef.current = null;
      term.dispose();
      streamRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, [pod, container, session, run, send, sendKey, refit]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    refit();
    termRef.current?.focus();
    // fullscreen and the phone keyboard both resize the pane; without a refit the remote pty
    // keeps the old dimensions and the display corrupts.
  }, [visible, fullscreen, viewportHeight, refit]);

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

  return (
    <Box
      sx={{
        display: visible ? 'flex' : 'none',
        flexDirection: 'column',
        height: '100%',
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
      onPaste={event => {
        const files = Array.from(event.clipboardData.files);
        if (files.length === 0) {
          return;
        }
        event.preventDefault();
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
      <Box ref={holderRef} sx={{ flexGrow: 1, minHeight: 0, overflow: 'hidden' }} />
      <Box
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 0.5,
          p: 0.5,
          overflowX: 'auto',
          borderTop: 1,
          borderColor: 'divider',
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
  const [addAnchor, setAddAnchor] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ anchor: HTMLElement; session: string } | null>(null);
  const [killing, setKilling] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [viewport, setViewport] = useState<{ height: number; top: number } | null>(null);

  // `position: fixed` sizes to the layout viewport, which the phone keyboard does not shrink, so
  // the key toolbar and the prompt slide underneath it. The visual viewport is the real one.
  useEffect(() => {
    const visual = window.visualViewport;
    if (!fullscreen || !visual) {
      setViewport(null);
      return undefined;
    }
    let frame = 0;
    const update = (): void => {
      // The keyboard animation fires a resize per frame; one update per frame is plenty.
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() =>
        setViewport({ height: visual.height, top: visual.offsetTop })
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
  }, [fullscreen]);

  useEffect(() => {
    let cancelled = false;
    void runExec(pod, container, LIST_SESSIONS_COMMAND).then(result => {
      if (cancelled) {
        return;
      }
      const names = parseSessions(result.stdout);
      setSessions(names);
      setActive(names[0] ?? '');
      setListError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [pod, container]);

  function closeTab(session: string): void {
    const remaining = (sessions ?? []).filter(name => name !== session);
    setSessions(remaining);
    if (active === session) {
      setActive(remaining[0] ?? '');
    }
  }

  // `tmux new -A` silently attaches and drops the command argument if the name is taken, so the
  // name has to be chosen against what the pod has right now, not against the mount-time list.
  async function openSession(agent: AgentLauncher): Promise<void> {
    setAddAnchor(null);
    const local = sessions ?? [];
    const result = await runExec(pod, container, LIST_SESSIONS_COMMAND);
    setListError(result.error);
    const taken = new Set([...local, ...(result.error ? [] : parseSessions(result.stdout))]);
    let name = agent.id;
    for (let suffix = 2; taken.has(name); suffix++) {
      name = `${agent.id}-${suffix}`;
    }
    setSessions([...local, name]);
    setCommands(current => ({ ...current, [name]: agent.command }));
    setActive(name);
  }

  async function killSession(session: string): Promise<void> {
    setKilling(null);
    const result = await runExec(pod, container, killSessionCommand(session));
    setListError(result.error);
    closeTab(session);
  }

  if (sessions === null) {
    return <Loader title="Looking for terminal sessions" />;
  }

  return (
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
              ...(viewport
                ? { left: 0, right: 0, top: viewport.top, height: viewport.height }
                : { inset: 0 }),
            }
          : { height: 560 }),
      }}
    >
      {listError && <Alert severity="warning">{listError}</Alert>}
      <Box sx={{ display: 'flex', alignItems: 'center', borderBottom: 1, borderColor: 'divider' }}>
        <Tabs
          value={active || false}
          onChange={(_event, value: string) => setActive(value)}
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
                  {session}
                  <Tooltip title="Close this tab; the session keeps running">
                    <IconButton
                      size="small"
                      aria-label={`Close the ${session} tab`}
                      onClick={event => {
                        event.stopPropagation();
                        closeTab(session);
                      }}
                    >
                      <Icon icon="mdi:close" width={14} />
                    </IconButton>
                  </Tooltip>
                  <IconButton
                    size="small"
                    aria-label={`Actions for the ${session} session`}
                    onClick={event => {
                      event.stopPropagation();
                      setMenu({ anchor: event.currentTarget, session });
                    }}
                  >
                    <Icon icon="mdi:dots-vertical" width={14} />
                  </IconButton>
                </Box>
              }
            />
          ))}
        </Tabs>
        <Button
          size="small"
          startIcon={<Icon icon="mdi:plus" />}
          onClick={event => setAddAnchor(event.currentTarget)}
        >
          New session
        </Button>
        <Button
          size="small"
          startIcon={<Icon icon={fullscreen ? 'mdi:fullscreen-exit' : 'mdi:fullscreen'} />}
          onClick={() => setFullscreen(current => !current)}
        >
          {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        </Button>
      </Box>

      <Menu anchorEl={addAnchor} open={!!addAnchor} onClose={() => setAddAnchor(null)}>
        {AGENTS.map(agent => (
          <MenuItem key={agent.id} onClick={() => void openSession(agent)}>
            {agent.label}
          </MenuItem>
        ))}
      </Menu>

      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            setKilling(menu?.session ?? null);
            setMenu(null);
          }}
        >
          Kill session
        </MenuItem>
      </Menu>

      <Dialog open={!!killing} onClose={() => setKilling(null)}>
        <DialogTitle>Kill session {killing}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            This terminates the agent running in the session and every process it started. Anything
            it has not written to the workspace is lost.
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
        // Every pane stays mounted and hidden so switching tabs keeps the socket and scrollback.
        sessions.map(session => (
          <TerminalPane
            key={session}
            pod={pod}
            container={container}
            session={session}
            run={commands[session]}
            workspace={workspace}
            visible={session === active}
            fullscreen={fullscreen}
            viewportHeight={viewport?.height ?? null}
          />
        ))
      )}
    </Box>
  );
}
