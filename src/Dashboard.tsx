import { Router } from '@kinvolk/headlamp-plugin/lib';
import {
  Link,
  Loader,
  SectionBox,
  SectionFilterHeader,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import type { KubeObject } from '@kinvolk/headlamp-plugin/lib/lib/k8s/KubeObject';
import type Pod from '@kinvolk/headlamp-plugin/lib/lib/k8s/pod';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { type ReactNode, useEffect, useState } from 'react';
import { useHistory, useParams } from 'react-router-dom';
import {
  createSandbox,
  DEFAULT_CONFIG,
  deleteSandbox,
  expiry,
  findPod,
  getConfigStore,
  isSuspended,
  nodeName,
  PluginConfig,
  readiness,
  Sandbox,
  sandboxImage,
  setOperatingMode,
} from './sandbox';
import { SandboxTerminal } from './Terminal';

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
const NAME_HELP =
  'Lowercase letters, digits and dashes, starting and ending with a letter or digit, at most 63 characters.';

const TTL_CHOICES: { label: string; hours: number | null }[] = [
  { label: '1 hour', hours: 1 },
  { label: '4 hours', hours: 4 },
  { label: '8 hours', hours: 8 },
  { label: '24 hours', hours: 24 },
  { label: '7 days', hours: 24 * 7 },
  { label: 'No expiry', hours: null },
];

const useStoreConfig = getConfigStore().useConfig();

export function usePluginConfig(): PluginConfig {
  const stored = useStoreConfig();
  return { ...DEFAULT_CONFIG, ...stored };
}

function countdown(target: Date, now: Date): string {
  const minutes = Math.floor((target.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) {
    return 'expired';
  }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) {
    return `in ${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `in ${hours}h ${minutes % 60}m`;
  }
  return `in ${minutes}m`;
}

function ReadyChip({ sandbox }: { sandbox: KubeObject }): ReactNode {
  const { ready, reason, message } = readiness(sandbox);
  return (
    <Tooltip title={message || reason}>
      <Box>
        <Chip
          size="small"
          color={ready ? 'success' : 'default'}
          label={ready ? 'Ready' : 'Not ready'}
        />
        <Typography variant="caption" display="block" color="text.secondary">
          {reason}
        </Typography>
      </Box>
    </Tooltip>
  );
}

function CreateSandboxDialog({
  open,
  onClose,
  namespace,
  templateName,
}: {
  open: boolean;
  onClose: () => void;
  namespace: string;
  templateName: string;
}): ReactNode {
  const [name, setName] = useState('');
  const [ttl, setTtl] = useState('8 hours');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nameIsValid = DNS_LABEL.test(name) && name.length <= 63;

  async function submit(): Promise<void> {
    const hours = TTL_CHOICES.find(choice => choice.label === ttl)?.hours ?? null;
    setBusy(true);
    setError(null);
    try {
      await createSandbox({
        name,
        namespace,
        templateName,
        shutdownTime: hours === null ? null : new Date(Date.now() + hours * 3600_000).toISOString(),
      });
      setName('');
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>Create sandbox</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name"
            value={name}
            onChange={event => setName(event.target.value)}
            error={name !== '' && !nameIsValid}
            helperText={name !== '' && !nameIsValid ? NAME_HELP : ' '}
            fullWidth
          />
          <TextField
            select
            label="Expires"
            value={ttl}
            onChange={event => setTtl(event.target.value)}
            fullWidth
          >
            {TTL_CHOICES.map(choice => (
              <MenuItem key={choice.label} value={choice.label}>
                {choice.label}
              </MenuItem>
            ))}
          </TextField>
          <Typography variant="caption" color="text.secondary">
            Created in namespace {namespace} from SandboxTemplate {templateName}.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button disabled={!nameIsValid || busy} onClick={() => void submit()}>
          Create
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function SandboxList(): ReactNode {
  const { namespace, templateName } = usePluginConfig();
  const [sandboxes, error] = Sandbox.useList({ namespace });
  const [creating, setCreating] = useState(false);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <SectionBox
      title={
        <SectionFilterHeader
          title="Sandboxes"
          noNamespaceFilter
          actions={[
            <Button key="create" variant="contained" onClick={() => setCreating(true)}>
              Create sandbox
            </Button>,
          ]}
        />
      }
    >
      <CreateSandboxDialog
        open={creating}
        onClose={() => setCreating(false)}
        namespace={namespace}
        templateName={templateName}
      />
      {error && <Alert severity="error">{error.message}</Alert>}
      {!sandboxes && !error && <Loader title="Loading sandboxes" />}
      {sandboxes && (
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Name</TableCell>
              <TableCell>Ready</TableCell>
              <TableCell>Suspended</TableCell>
              <TableCell>Age</TableCell>
              <TableCell>Expiry</TableCell>
              <TableCell>Node</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {sandboxes.map(sandbox => {
              const expires = expiry(sandbox);
              return (
                <TableRow key={sandbox.metadata.uid}>
                  <TableCell>
                    <Link routeName="sandbox" params={{ name: sandbox.getName() }}>
                      {sandbox.getName()}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <ReadyChip sandbox={sandbox} />
                  </TableCell>
                  <TableCell>{isSuspended(sandbox) ? 'Yes' : 'No'}</TableCell>
                  <TableCell>{sandbox.getAge()}</TableCell>
                  <TableCell>{expires ? countdown(expires, now) : 'never'}</TableCell>
                  <TableCell>{nodeName(sandbox) || '-'}</TableCell>
                </TableRow>
              );
            })}
            {sandboxes.length === 0 && (
              <TableRow>
                <TableCell colSpan={6}>No sandboxes in namespace {namespace}.</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      )}
    </SectionBox>
  );
}

function DeleteSandboxDialog({
  sandbox,
  onClose,
  onDeleted,
}: {
  sandbox: KubeObject | null;
  onClose: () => void;
  onDeleted: () => void;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    if (!sandbox) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteSandbox(sandbox);
      onDeleted();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!sandbox} onClose={onClose}>
      <DialogTitle>Delete sandbox {sandbox?.getName()}?</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error">{error}</Alert>}
        <DialogContentText>
          The controller owns the workspace PersistentVolumeClaim, so deleting the sandbox deletes
          the volume too, whatever the shutdown policy says. Everything stored in the workspace is
          lost and cannot be recovered.
        </DialogContentText>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button color="error" disabled={busy} onClick={() => void submit()}>
          Delete
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function SandboxDetail(): ReactNode {
  const { name } = useParams<{ name: string }>();
  const history = useHistory();
  const { namespace } = usePluginConfig();
  const [sandbox, error] = Sandbox.useGet(name, namespace);
  const [pod, setPod] = useState<Pod | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const selector: string | undefined = sandbox?.jsonData?.status?.selector;

  useEffect(() => {
    if (!sandbox) {
      setPod(null);
      return undefined;
    }
    let cancelled = false;
    findPod(sandbox, namespace)
      .then(found => {
        // Watch updates hand us a new Sandbox object every time; keeping the previous Pod
        // instance when it is the same pod is what stops the terminal from reconnecting.
        if (!cancelled) {
          setPod(current => (current?.metadata.uid === found?.metadata.uid ? current : found));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setPod(null);
        }
      });
    return () => {
      cancelled = true;
    };
    // Deliberately not [sandbox]: a watch event replaces that object on every status heartbeat.
  }, [selector, namespace]);

  if (error) {
    return (
      <SectionBox title={name}>
        <Alert severity="error">{error.message}</Alert>
      </SectionBox>
    );
  }
  if (!sandbox) {
    return <Loader title={`Loading sandbox ${name}`} />;
  }

  const suspended = isSuspended(sandbox);
  const status = readiness(sandbox);
  const expires = expiry(sandbox);
  const container = pod?.spec?.containers?.[0]?.name;
  const podIsRunning = pod?.status?.phase === 'Running';

  async function switchMode(mode: 'Running' | 'Suspended'): Promise<void> {
    setActionError(null);
    try {
      await setOperatingMode(sandbox, mode);
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <SectionBox title={sandbox.getName()} backLink={Router.createRouteURL('sandboxes')}>
      {actionError && <Alert severity="error">{actionError}</Alert>}
      <Stack spacing={1} sx={{ mb: 2, overflowWrap: 'anywhere' }}>
        <Typography>
          Ready: {status.ready ? 'yes' : 'no'} ({status.reason})
          {status.message ? ` - ${status.message}` : ''}
        </Typography>
        <Typography>Operating mode: {suspended ? 'Suspended' : 'Running'}</Typography>
        <Typography>Image: {sandboxImage(sandbox) || '-'}</Typography>
        <Typography>Node: {pod?.spec?.nodeName || nodeName(sandbox) || '-'}</Typography>
        <Typography>
          Expires:{' '}
          {expires ? `${expires.toLocaleString()} (${countdown(expires, new Date())})` : 'never'}
        </Typography>
      </Stack>

      <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
        <Button
          variant="outlined"
          onClick={() => void switchMode(suspended ? 'Running' : 'Suspended')}
        >
          {suspended ? 'Resume' : 'Suspend'}
        </Button>
        <Button variant="outlined" color="error" onClick={() => setDeleting(true)}>
          Delete
        </Button>
      </Stack>

      <DeleteSandboxDialog
        sandbox={deleting ? sandbox : null}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          history.push(Router.createRouteURL('sandboxes'));
        }}
      />

      {suspended && (
        <Alert severity="info">This sandbox is suspended. Resume it to open a terminal.</Alert>
      )}
      {!suspended && (!pod || !container) && (
        <Alert severity="info">Waiting for the sandbox pod to be created.</Alert>
      )}
      {!suspended && pod && container && !podIsRunning && (
        <Alert severity="info">
          The sandbox pod is {pod.status?.phase ?? 'not running'}. The terminal opens once it is
          running.
        </Alert>
      )}
      {!suspended && pod && container && podIsRunning && (
        <SandboxTerminal pod={pod} container={container} namespace={namespace} />
      )}
    </SectionBox>
  );
}
