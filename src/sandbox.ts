import { ApiProxy, ConfigStore, K8s } from '@kinvolk/headlamp-plugin/lib';
import { makeCustomResourceClass } from '@kinvolk/headlamp-plugin/lib/Crd';
import type { KubeObject, KubeObjectClass } from '@kinvolk/headlamp-plugin/lib/lib/k8s/KubeObject';
import type Pod from '@kinvolk/headlamp-plugin/lib/lib/k8s/pod';

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

/** The controller names the pod independently of the sandbox, so status.selector is the only link. */
export async function findPod(sandbox: KubeObject, namespace: string): Promise<Pod | null> {
  const selector: string | undefined = sandbox.jsonData?.status?.selector;
  if (!selector) {
    return null;
  }
  const list = await ApiProxy.request(`/api/v1/namespaces/${namespace}/pods`, {}, true, true, {
    labelSelector: selector,
  });
  const items: any[] = list?.items ?? [];
  if (items.length === 0) {
    return null;
  }
  const running = items.find(item => item.status?.phase === 'Running');
  return new K8s.ResourceClasses.Pod(running ?? items[0]);
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
