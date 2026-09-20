# headlamp-agent-sandbox

A [Headlamp](https://headlamp.dev/) plugin for
[kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox).

## What it does

The plugin adds a dashboard for `Sandbox` custom resources
(`agents.x-k8s.io/v1beta1`): a list view with readiness and expiry, and
actions to create, suspend, resume and delete sandboxes.

Each sandbox also gets a set of terminal tabs, which is the part stock
Headlamp cannot do on its own. Headlamp's built-in terminal opens a single
`pods/exec` connection per pod, and a sandbox's shell rc typically
auto-attaches every terminal into the same `tmux` session — so every tab you
open lands on the same screen instead of giving you a second, independent
one. This plugin opens each tab against a distinct named `tmux` session, so
you can run more than one thing in a sandbox at once.

The terminal also accepts dropped files and pasted screenshots, which get
uploaded into the sandbox and typed into the agent's prompt as a path.

Because a phone is a first-class way to drive this, each terminal carries a row
of keys a touch keyboard does not have — `Esc`, `Tab`, `Ctrl-C`, the arrows,
`Home`/`End`, tmux's `Ctrl-B` prefix — plus a sticky `Ctrl` that applies to the
next key you press, a button that expands the terminal to fill the viewport, and
an upload button for the case where pasting a file is not practical. Tapping any
of them leaves the terminal focused, so the on-screen keyboard stays up.

Launching an agent types its name into the session's shell rather than handing it
to `tmux` as the session's command. That means the shell's own startup files
apply — several agents are wrapped in shell functions that pass per-instance
flags — and when the agent exits you are left at a prompt instead of watching the
session disappear.

## How the upload works

When you drop a file or paste a screenshot onto a terminal, the plugin does
not send the bytes through the interactive terminal stream. Instead it opens
a second, non-interactive `pods/exec` connection that runs `head -c <n> |
base64 -d` inside the sandbox pod, streaming the file's base64 straight into
`/workspace/.attachments/`, and then types the resulting path into the
terminal's input without submitting it. Because that upload path is just
another Kubernetes exec call, the sandbox needs no web server, no extra
network path and no credential of its own — everything runs in your browser
under your own signed-in Headlamp session, using your own Kubernetes token,
so RBAC is unchanged from what you already have.

## Requirements

- Headlamp v0.45 or newer.
- The [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
  controller installed, providing the `Sandbox` CRD.
- RBAC in the target namespace for `sandboxes` (list/get/create/update/delete)
  and for `pods` and `pods/exec` (get/list/create).
- `tmux`, `base64`, `head` and `mv` available in the sandbox container image.

## Settings

The plugin adds a page to Headlamp's plugin settings with two options:

- `namespace` — the namespace sandboxes live in. Defaults to `agents`.
- `templateName` — the name of a `SandboxTemplate` used as the source for new
  sandboxes. Defaults to `agent-session`.

When you create a sandbox from the plugin, it copies `spec.podTemplate` and
`spec.volumeClaimTemplates` from the named `SandboxTemplate` rather than
letting you define a pod spec by hand. This keeps the pod spec itself owned
by whatever GitOps repository manages the `SandboxTemplate`, instead of
duplicating it inside the plugin's create dialog.

## Installing

Releases are published as a container image holding the built plugin at
`/plugin/headlamp-agent-sandbox/`. Headlamp itself doesn't load plugin images
directly — instead, use the image as an `initContainer` that copies the
plugin into an `emptyDir` volume Headlamp reads its plugins from, and point
Headlamp at that directory with `-plugins-dir`.

```yaml
spec:
  initContainers:
    - name: headlamp-agent-sandbox
      image: <registry>/<owner>/headlamp-agent-sandbox:<tag>
      command: ["cp", "-a", "/plugin/.", "/headlamp/plugins/"]
      volumeMounts:
        - name: headlamp-plugins
          mountPath: /headlamp/plugins
  containers:
    - name: headlamp
      args:
        - -plugins-dir=/headlamp/plugins
      volumeMounts:
        - name: headlamp-plugins
          mountPath: /headlamp/plugins
  volumes:
    - name: headlamp-plugins
      emptyDir: {}
```

## Development

```sh
npm install
npm start          # watches and rebuilds against a local Headlamp
npm run build       # production build
npm run test:unit   # runs test/*.test.js with node --test
npm run lint
```

The `Dockerfile` has no build stage — it copies `dist/` into a `busybox` image, so
run `npm run build` before `docker build`.

## License

Apache-2.0, see [LICENSE](./LICENSE).
