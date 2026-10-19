import { Icon } from '@iconify/react';
import { SectionBox, SimpleTable } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import {
  Alert,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  IconButton,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
} from '@mui/material';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { usePluginConfig } from './Dashboard';
import { type AccountAgent, type AccountKind, DEFAULT_ACCOUNT } from './exec';
import {
  AGENT_LABELS,
  createAccount,
  deleteAccount,
  listAccounts,
  type StoredAccount,
} from './sandbox';

const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

const CREDENTIAL_HELP: Record<AccountAgent, Record<AccountKind, string>> = {
  claude: {
    subscription: 'The token printed by `claude setup-token`.',
    api: 'An Anthropic API key. Claude Code asks once to approve a new key.',
  },
  codex: {
    subscription: '',
    api: 'An OpenAI API key.',
  },
};

function AddAccountDialog({
  open,
  onClose,
  namespace,
}: {
  open: boolean;
  onClose: (added: boolean) => void;
  namespace: string;
}): ReactNode {
  const [id, setId] = useState('');
  const [agent, setAgent] = useState<AccountAgent>('claude');
  const [kind, setKind] = useState<AccountKind>('subscription');
  const [credential, setCredential] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const needsCredential = !(agent === 'codex' && kind === 'subscription');
  // Under 50 so the Secret name stays a DNS label too; "default" is the pod's own credentials.
  const idIsValid = DNS_LABEL.test(id) && id.length <= 49 && id !== DEFAULT_ACCOUNT;

  async function submit(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await createAccount(namespace, {
        id,
        agent,
        kind,
        credential: needsCredential ? credential.trim() : '',
      });
      setId('');
      setCredential('');
      onClose(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => onClose(false)} fullWidth maxWidth="sm">
      <DialogTitle>Add account</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField
            label="Name"
            value={id}
            onChange={event => setId(event.target.value)}
            error={id !== '' && !idIsValid}
            helperText="Lowercase letters, digits and dashes, at most 49 characters, not “default”."
            fullWidth
          />
          <TextField
            select
            label="Agent"
            value={agent}
            onChange={event => setAgent(event.target.value as AccountAgent)}
            fullWidth
          >
            <MenuItem value="claude">{AGENT_LABELS.claude}</MenuItem>
            <MenuItem value="codex">{AGENT_LABELS.codex}</MenuItem>
          </TextField>
          <TextField
            select
            label="Type"
            value={kind}
            onChange={event => setKind(event.target.value as AccountKind)}
            fullWidth
          >
            <MenuItem value="subscription">Subscription</MenuItem>
            <MenuItem value="api">API key</MenuItem>
          </TextField>
          {needsCredential ? (
            <TextField
              label={kind === 'api' ? 'API key' : 'Token'}
              type="password"
              autoComplete="off"
              value={credential}
              onChange={event => setCredential(event.target.value)}
              helperText={CREDENTIAL_HELP[agent][kind]}
              fullWidth
            />
          ) : (
            <DialogContentText variant="body2">
              Nothing to paste. The first Codex session in each sandbox runs `codex login
              --device-auth`, and the login stays in that sandbox&apos;s workspace. Device code
              login has to be turned on in your ChatGPT security settings.
            </DialogContentText>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button
          disabled={!idIsValid || (needsCredential && !credential.trim()) || busy}
          onClick={() => void submit()}
        >
          Add
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function AccountList(): ReactNode {
  const { namespace } = usePluginConfig();
  const [accounts, setAccounts] = useState<StoredAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<StoredAccount | null>(null);

  const reload = useCallback(() => {
    listAccounts(namespace)
      .then(list => {
        setAccounts(list);
        setError(null);
      })
      .catch(err => setError((err as Error).message));
  }, [namespace]);

  useEffect(reload, [reload]);

  async function remove(account: StoredAccount): Promise<void> {
    setDeleting(null);
    try {
      await deleteAccount(namespace, account.id);
      reload();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <SectionBox
      title="Accounts"
      headerProps={{
        actions: [
          <Button key="add" variant="contained" onClick={() => setAdding(true)}>
            Add account
          </Button>,
        ],
      }}
    >
      {error && <Alert severity="error">{error}</Alert>}
      <SimpleTable
        data={accounts ?? []}
        emptyMessage={accounts ? 'No accounts yet.' : 'Loading accounts.'}
        columns={[
          { label: 'Name', getter: (account: StoredAccount) => account.id },
          { label: 'Agent', getter: (account: StoredAccount) => AGENT_LABELS[account.agent] },
          {
            label: 'Type',
            getter: (account: StoredAccount) =>
              account.kind === 'api' ? 'API key' : 'Subscription',
          },
          {
            label: '',
            getter: (account: StoredAccount) => (
              <Tooltip title="Delete">
                <IconButton
                  aria-label={`Delete the ${account.id} account`}
                  onClick={() => setDeleting(account)}
                >
                  <Icon icon="mdi:delete" width={20} />
                </IconButton>
              </Tooltip>
            ),
          },
        ]}
      />
      <AddAccountDialog
        open={adding}
        namespace={namespace}
        onClose={added => {
          setAdding(false);
          if (added) {
            reload();
          }
        }}
      />
      <Dialog open={!!deleting} onClose={() => setDeleting(null)}>
        <DialogTitle>Delete account {deleting?.id}?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Sandboxes already switched to it keep their copy until they switch to another account.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>Cancel</Button>
          <Button color="error" onClick={() => void remove(deleting as StoredAccount)}>
            Delete
          </Button>
        </DialogActions>
      </Dialog>
    </SectionBox>
  );
}
