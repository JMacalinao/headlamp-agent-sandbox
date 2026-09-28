import { K8s, Router } from '@kinvolk/headlamp-plugin/lib';
import {
  ActionButton,
  DetailsGrid,
  EditButton,
  Link,
  ResourceListView,
  SectionBox,
  StatusLabel,
} from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import type { KubeObject } from '@kinvolk/headlamp-plugin/lib/lib/k8s/KubeObject';
import type Pod from '@kinvolk/headlamp-plugin/lib/lib/k8s/pod';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useHistory, useParams } from 'react-router-dom';
import {
  createSandbox,
  DEFAULT_CONFIG,
  deleteSandbox,
  expiry,
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

function ReadyLabel({ sandbox }: { sandbox: KubeObject }): ReactNode {
  const { ready, reason, message } = readiness(sandbox);
  return (
    <Tooltip title={message || reason}>
      <StatusLabel status={ready ? 'success' : 'warning'}>
        {ready ? 'Ready' : 'Not ready'} ({reason})
      </StatusLabel>
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
    <>
      <CreateSandboxDialog
        open={creating}
        onClose={() => setCreating(false)}
        namespace={namespace}
        templateName={templateName}
      />
      <ResourceListView
        title="Sandboxes"
        id="headlamp-agent-sandbox-sandboxes"
        headerProps={{
          noNamespaceFilter: true,
          actions: [
            <Button key="create" variant="contained" onClick={() => setCreating(true)}>
              Create sandbox
            </Button>,
          ],
        }}
        data={sandboxes}
        errors={error ? [error] : null}
        columns={[
          {
            id: 'name',
            label: 'Name',
            getValue: sandbox => sandbox.getName(),
            // The class's own details route is the generic custom resource page, not this plugin's.
            render: sandbox => (
              <Link routeName="sandbox" params={{ name: sandbox.getName() }}>
                {sandbox.getName()}
              </Link>
            ),
          },
          {
            id: 'ready',
            label: 'Ready',
            getValue: sandbox => readiness(sandbox).reason,
            render: sandbox => <ReadyLabel sandbox={sandbox} />,
          },
          {
            id: 'mode',
            label: 'Operating mode',
            getValue: sandbox => (isSuspended(sandbox) ? 'Suspended' : 'Running'),
          },
          {
            id: 'expiry',
            label: 'Expires',
            getValue: sandbox => expiry(sandbox)?.getTime() ?? Number.MAX_SAFE_INTEGER,
            render: sandbox => {
              const expires = expiry(sandbox);
              return expires ? countdown(expires, now) : 'never';
            },
          },
          {
            id: 'node',
            label: 'Node',
            getValue: sandbox => nodeName(sandbox) || '-',
          },
          'age',
        ]}
      />
    </>
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

/**
 * Watches the sandbox's pod, so a replacement pod shows up without a reload. `pod` only changes
 * when the pod itself does: every watch event hands over a new object, and the terminal
 * reconnects whenever its pod prop changes. `livePod` carries the current status.
 */
function useSandboxPod(
  sandbox: KubeObject | null,
  namespace: string
): { pod: Pod | null; livePod: Pod | null } {
  const selector: string | undefined = sandbox?.jsonData?.status?.selector;
  const [pods] = K8s.ResourceClasses.Pod.useList({ namespace, labelSelector: selector });
  const livePod = selector
    ? pods?.find(item => item.status?.phase === 'Running') ?? pods?.[0] ?? null
    : null;
  const uid = livePod?.metadata.uid;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by uid on purpose, see above
  const pod = useMemo(() => livePod, [uid]);
  return { pod, livePod };
}

function TerminalSection({
  sandbox,
  namespace,
  actionError,
}: {
  sandbox: KubeObject;
  namespace: string;
  actionError: string | null;
}): ReactNode {
  const { pod, livePod } = useSandboxPod(sandbox, namespace);
  const suspended = isSuspended(sandbox);
  const container = pod?.spec?.containers?.[0]?.name;
  const podIsRunning = livePod?.status?.phase === 'Running';

  return (
    <SectionBox title="Terminal">
      {actionError && <Alert severity="error">{actionError}</Alert>}
      {suspended && (
        <Alert severity="info">This sandbox is suspended. Resume it to open a terminal.</Alert>
      )}
      {!suspended && (!pod || !container) && (
        <Alert severity="info">Waiting for the sandbox pod to be created.</Alert>
      )}
      {!suspended && pod && container && !podIsRunning && (
        <Alert severity="info">
          The sandbox pod is {livePod?.status?.phase ?? 'not running'}. The terminal opens once it
          is running.
        </Alert>
      )}
      {!suspended && pod && container && podIsRunning && (
        // A replacement pod (after an eviction, say) has none of the old tmux sessions.
        <SandboxTerminal
          key={pod.metadata.uid}
          pod={pod}
          container={container}
          namespace={namespace}
        />
      )}
    </SectionBox>
  );
}

export function SandboxDetail(): ReactNode {
  const { name } = useParams<{ name: string }>();
  const history = useHistory();
  const { namespace } = usePluginConfig();
  const [deleting, setDeleting] = useState<KubeObject | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function switchMode(sandbox: KubeObject, mode: 'Running' | 'Suspended'): Promise<void> {
    setActionError(null);
    try {
      await setOperatingMode(sandbox, mode);
    } catch (err) {
      setActionError((err as Error).message);
    }
  }

  return (
    <>
      <DetailsGrid
        resourceType={Sandbox}
        name={name}
        namespace={namespace}
        backLink={Router.createRouteURL('sandboxes')}
        // The stock delete button skips the warning that the workspace volume goes with it.
        noDefaultActions
        actions={sandbox => {
          if (!sandbox) {
            return null;
          }
          const suspended = isSuspended(sandbox);
          return [
            <ActionButton
              key="mode"
              description={suspended ? 'Resume' : 'Suspend'}
              icon={suspended ? 'mdi:play' : 'mdi:pause'}
              onClick={() => void switchMode(sandbox, suspended ? 'Running' : 'Suspended')}
            />,
            <EditButton key="edit" item={sandbox} />,
            <ActionButton
              key="delete"
              description="Delete"
              icon="mdi:delete"
              onClick={() => setDeleting(sandbox)}
            />,
          ];
        }}
        extraInfo={sandbox => {
          if (!sandbox) {
            return null;
          }
          const expires = expiry(sandbox);
          return [
            { name: 'Ready', value: <ReadyLabel sandbox={sandbox} /> },
            { name: 'Operating mode', value: isSuspended(sandbox) ? 'Suspended' : 'Running' },
            { name: 'Image', value: sandboxImage(sandbox) || '-' },
            { name: 'Node', value: nodeName(sandbox) || '-' },
            {
              name: 'Expires',
              value: expires
                ? `${expires.toLocaleString()} (${countdown(expires, new Date())})`
                : 'never',
            },
          ];
        }}
        // DetailsGrid keys sections by position. Nothing before this one comes and goes, so the
        // terminal is not remounted, which would drop its exec.
        extraSections={sandbox =>
          sandbox
            ? [
                {
                  id: 'headlamp-agent-sandbox.terminal',
                  section: (
                    <TerminalSection
                      sandbox={sandbox}
                      namespace={namespace}
                      actionError={actionError}
                    />
                  ),
                },
              ]
            : []
        }
      />
      <DeleteSandboxDialog
        sandbox={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={() => {
          setDeleting(null);
          history.push(Router.createRouteURL('sandboxes'));
        }}
      />
    </>
  );
}
