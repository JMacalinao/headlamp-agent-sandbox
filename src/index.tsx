/*
 * Copyright 2025 The Kubernetes Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  DefaultDetailsViewSection,
  type PluginSettingsDetailsProps,
  registerDetailsViewSectionsProcessor,
  registerPluginSettings,
  registerRoute,
  registerSidebarEntry,
} from '@kinvolk/headlamp-plugin/lib';
import { Stack, TextField } from '@mui/material';
import { type ReactNode } from 'react';
import { SandboxDetail, SandboxList } from './Dashboard';
import { DEFAULT_CONFIG, PLUGIN_NAME } from './sandbox';

registerSidebarEntry({
  parent: null,
  name: 'sandboxes',
  label: 'Sandboxes',
  url: '/agent-sandbox',
  icon: 'mdi:robot-outline',
});

registerSidebarEntry({
  parent: 'sandboxes',
  name: 'sandbox-list',
  label: 'Sandboxes',
  url: '/agent-sandbox',
});

registerRoute({
  path: '/agent-sandbox',
  name: 'sandboxes',
  exact: true,
  sidebar: 'sandbox-list',
  component: SandboxList,
});

registerRoute({
  path: '/agent-sandbox/:name',
  name: 'sandbox',
  sidebar: 'sandbox-list',
  component: SandboxDetail,
});

// Sandboxes open in the activity bar and the sidebar leads back to the list, so Back is noise.
registerDetailsViewSectionsProcessor(function dropSandboxBackLink(resource, sections) {
  return resource?.kind === 'Sandbox'
    ? sections.filter(
        section =>
          !(
            section &&
            typeof section === 'object' &&
            'id' in section &&
            section.id === DefaultDetailsViewSection.BACK_LINK
          )
      )
    : sections;
});

function Settings({ data, onDataChange }: PluginSettingsDetailsProps): ReactNode {
  const config = { ...DEFAULT_CONFIG, ...data };

  return (
    <Stack spacing={2} sx={{ maxWidth: 420 }}>
      <TextField
        label="Namespace"
        value={config.namespace}
        onChange={event => onDataChange?.({ ...config, namespace: event.target.value })}
        helperText="Namespace holding the Sandbox objects and the SandboxTemplate."
        fullWidth
      />
      <TextField
        label="Template name"
        value={config.templateName}
        onChange={event => onDataChange?.({ ...config, templateName: event.target.value })}
        helperText="SandboxTemplate new sandboxes are created from."
        fullWidth
      />
    </Stack>
  );
}

registerPluginSettings(PLUGIN_NAME, Settings, true);
