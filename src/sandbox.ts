import { ApiProxy, ConfigStore } from '@kinvolk/headlamp-plugin/lib';
import { makeCustomResourceClass } from '@kinvolk/headlamp-plugin/lib/Crd';
import type { KubeObject, KubeObjectClass } from '@kinvolk/headlamp-plugin/lib/lib/k8s/KubeObject';
import { type Account, type AccountAgent, type AccountKind } from './exec';

const SANDBOX_API = '/apis/agents.x-k8s.io/v1beta1';
const TEMPLATE_API = '/apis/extensions.agents.x-k8s.io/v1beta1';

export const PLUGIN_NAME = 'headlamp-agent-sandbox';

export interface PluginConfig {
  namespace: string;
  templateName: string;
}

export const DEFAULT_CONFIG: PluginConfig = {
  namespace: 'agents',
  templateName: 'agent-session',
};

export function getConfigStore(): ConfigStore<PluginConfig> {
  return new ConfigStore<PluginConfig>(PLUGIN_NAME);
}

export const Sandbox: KubeObjectClass = makeCustomResourceClass({
  apiInfo: [{ group: 'agents.x-k8s.io', version: 'v1beta1' }],
  kind: 'Sandbox',
  pluralName: 'sandboxes',
  singularName: 'sandbox',
  isNamespaced: true,
});

export const SandboxTemplate: KubeObjectClass = makeCustomResourceClass({
  apiInfo: [{ group: 'extensions.agents.x-k8s.io', version: 'v1beta1' }],
  kind: 'SandboxTemplate',
  pluralName: 'sandboxtemplates',
  singularName: 'sandboxtemplate',
  isNamespaced: true,
});

export interface Readiness {
  ready: boolean;
  reason: string;
  message: string;
}

export function readiness(sandbox: KubeObject): Readiness {
  const conditions: any[] = sandbox.jsonData?.status?.conditions ?? [];
  const ready = conditions.find(condition => condition.type === 'Ready');
  if (!ready) {
    return { ready: false, reason: 'Unknown', message: '' };
  }
  return {
    ready: ready.status === 'True',
    reason: ready.reason || 'Unknown',
    message: ready.message || '',
  };
}

export function isSuspended(sandbox: KubeObject): boolean {
  return sandbox.jsonData?.spec?.operatingMode === 'Suspended';
}

export function expiry(sandbox: KubeObject): Date | null {
  const shutdownTime: string | undefined = sandbox.jsonData?.spec?.shutdownTime;
  if (!shutdownTime) {
    return null;
  }
  const date = new Date(shutdownTime);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function sandboxImage(sandbox: KubeObject): string {
  return sandbox.jsonData?.spec?.podTemplate?.spec?.containers?.[0]?.image ?? '';
}

export function nodeName(sandbox: KubeObject): string {
  return sandbox.jsonData?.status?.nodeName ?? '';
}

export interface CreateSandboxArgs {
  name: string;
  namespace: string;
  templateName: string;
  /** RFC3339 timestamp, or null for a sandbox that never expires. */
  shutdownTime: string | null;
}

export async function createSandbox({
  name,
  namespace,
  templateName,
  shutdownTime,
}: CreateSandboxArgs): Promise<void> {
  let template: { spec?: Record<string, any> };
  try {
    template = await ApiProxy.request(
      `${TEMPLATE_API}/namespaces/${namespace}/sandboxtemplates/${templateName}`
    );
  } catch (err) {
    throw new Error(
      `Could not read SandboxTemplate "${templateName}" in namespace "${namespace}": ` +
        `${(err as Error).message}. Check the plugin settings.`
    );
  }

  const spec: Record<string, any> = {
    operatingMode: 'Running',
    podTemplate: template.spec?.podTemplate,
    volumeClaimTemplates: template.spec?.volumeClaimTemplates,
  };
  // Omitting both keys is how "no expiry" is expressed; a null shutdownTime is not valid.
  if (shutdownTime !== null) {
    spec.shutdownPolicy = 'Delete';
    spec.shutdownTime = shutdownTime;
  }

  await ApiProxy.post(`${SANDBOX_API}/namespaces/${namespace}/sandboxes`, {
    apiVersion: 'agents.x-k8s.io/v1beta1',
    kind: 'Sandbox',
    metadata: { name, namespace },
    spec,
  });
}

function sandboxUrl(sandbox: KubeObject): string {
  return `${SANDBOX_API}/namespaces/${sandbox.getNamespace()}/sandboxes/${sandbox.getName()}`;
}

export async function setOperatingMode(
  sandbox: KubeObject,
  mode: 'Running' | 'Suspended'
): Promise<void> {
  await ApiProxy.patch(sandboxUrl(sandbox), { spec: { operatingMode: mode } });
}

export async function deleteSandbox(sandbox: KubeObject): Promise<void> {
  await ApiProxy.remove(sandboxUrl(sandbox));
}

export interface AgentLauncher {
  id: string;
  label: string;
  /** Passed to tmux as the session's command; undefined opens a bare shell session. */
  command: string | undefined;
}

export const AGENTS: AgentLauncher[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'opencode', command: 'opencode' },
  { id: 'hermes', label: 'Hermes', command: 'hermes' },
  { id: 'shell', label: 'Shell', command: undefined },
];

export const AGENT_LABELS: Record<AccountAgent, string> = { claude: 'Claude Code', codex: 'Codex' };

export interface StoredAccount extends Account {
  /** Empty for a Codex subscription, which logs in inside each pod instead. */
  credential: string;
}

const ACCOUNT_LABEL = 'headlamp-agent-sandbox/account';
const ACCOUNT_PREFIX = 'agent-account-';

function secretsUrl(namespace: string): string {
  return `/api/v1/namespaces/${namespace}/secrets`;
}

export async function listAccounts(namespace: string): Promise<StoredAccount[]> {
  const list: { items: { metadata: { name: string }; data?: Record<string, string> }[] } =
    await ApiProxy.request(
      `${secretsUrl(namespace)}?labelSelector=${encodeURIComponent(`${ACCOUNT_LABEL}=true`)}`
    );
  return list.items
    .map(secret => ({
      id: secret.metadata.name.slice(ACCOUNT_PREFIX.length),
      agent: atob(secret.data?.agent ?? '') as AccountAgent,
      kind: atob(secret.data?.kind ?? '') as AccountKind,
      credential: atob(secret.data?.credential ?? ''),
    }))
    .filter(account => account.agent === 'claude' || account.agent === 'codex')
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function createAccount(namespace: string, account: StoredAccount): Promise<void> {
  await ApiProxy.post(secretsUrl(namespace), {
    apiVersion: 'v1',
    kind: 'Secret',
    metadata: {
      name: `${ACCOUNT_PREFIX}${account.id}`,
      namespace,
      labels: { [ACCOUNT_LABEL]: 'true' },
    },
    type: 'Opaque',
    stringData: { agent: account.agent, kind: account.kind, credential: account.credential },
  });
}

export async function deleteAccount(namespace: string, id: string): Promise<void> {
  await ApiProxy.remove(`${secretsUrl(namespace)}/${ACCOUNT_PREFIX}${id}`);
}
