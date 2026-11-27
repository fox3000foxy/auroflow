# AuroFlow

> Ephemeral compute. Persistent state.
>
> Workflow-powered cloud virtualization.

Static web application for [AuroFlow](https://github.com/fox3000foxy/auroflow-engine): on-demand Windows 10 IoT Enterprise LTSC 2021 virtual machines running under QEMU/KVM on GitHub Actions, reachable over RDP through ngrok, with persistent storage as compressed QCOW2 layers in a private Hugging Face dataset.

The Dashboard has no application backend of its own. It talks to the GitHub REST API and the Hugging Face API directly from the browser. A small Cloudflare Worker (`worker/`) relays GitHub Device Flow, because GitHub's OAuth endpoints do not accept browser CORS requests.

## Pages

| Path | Purpose |
|---|---|
| `/` | Project overview: what runs, architecture diagram, session lifecycle, persistence, getting started, security notes. |
| `/dashboard/` | VM dashboard: status, RDP endpoint, start, graceful shutdown, force stop, lifecycle, activity, compute and storage. |
| `/panel/` | Legacy URL redirecting to `/dashboard/`. |
| `/settings/` | Sign-in, workspace repository and visibility, ngrok and Hugging Face credentials, network restriction, validation, danger zone. |

## How the Dashboard reads VM state

The VM status is derived from the steps of the active workflow run (`GET /actions/runs/{id}/jobs`), not from the run status alone:

| Status | Condition |
|---|---|
| OFF (red) | No queued or running run. |
| Booting... (yellow) | Start requested, run queued, or any step before *Wait for shutdown*. The detail line names the current step. |
| ON (green) | *Wait for shutdown* is running and `session.json` on `golden-control` belongs to this run. |
| Shutting down... (orange) | A `Golden shutdown <run_id>` issue exists for this run, or the run is finishing. |
| Saving... (blue) | *Save persistent layers* is running. |
| Stopping... (orange) | Force stop was requested from this browser. |

The endpoint is displayed only when `session.json` belongs to the active `run_id`, uses schema version 3 and its `encrypted_endpoint` can be decrypted with the browser's workspace-specific private key. The engine never publishes a plaintext RDP endpoint in the current session file. Endpoints of completed or cancelled runs are never shown. The Dashboard distinguishes a missing control branch, a stale session from another run, a malformed file and an API error, and shows each differently. GitHub Actions status is kept as secondary information in its own panel.

### Connecting

When the decrypted endpoint is available, the Dashboard offers three ways to connect:

- **Copy**: the `host:port` address, for any RDP client.
- **Download .rdp**: a connection file generated in the browser (`full address:s:host:port`, no credentials). Remote Desktop Connection opens it on Windows, Windows App on macOS and Remmina on Linux.
- **Open in Remote Desktop**: a legacy `rdp://full%20address=s:host:port` link, shown only on macOS, iOS and Android, the only platforms whose Microsoft clients handle this URI scheme. Windows clients do not support it.

Polling runs every 5 to 6 seconds during transitions and every 15 seconds while ON. It stops while the instance is off and while the tab is hidden, backs off on errors, and stops on authentication errors. Requests use `cache: 'no-cache'` so GitHub's 60-second `Cache-Control` never shows a stale state; unchanged resources answer 304, which does not count against the rate limit.

Duplicate launches are prevented by checking for active runs before dispatching and by a cross-tab dispatch lock held until the new run appears (or for two minutes).

## Credential handling

- **GitHub token**: kept in `sessionStorage`, scoped to the browser tab, expires after 8 hours of inactivity. Users can opt in to "Stay signed in on this browser", which keeps it in `localStorage` for up to 7 days. Sign-out clears both.
- **ngrok token**: sealed in the browser with the repository public key (libsodium `crypto_box_seal`) and stored as the `NGROK_AUTHTOKEN` Actions secret. Never stored in the browser.
- **Hugging Face token**: sealed into the `HF_TOKEN` secret. Optionally kept in `sessionStorage` (on by default, clearable) so the panel can show layer details and delete the dataset without asking again.
- **Session encryption key**: the Dashboard generates a per-workspace Curve25519 key pair in the browser. Only the public key is uploaded as the `AUROFLOW_PUBLIC_KEY` Actions variable; the private key remains in origin-specific `localStorage` under `auroflow.session-key.v1.*`. A different browser, lost site data or a different domain cannot decrypt an already published session. Start a new session to rotate the key.
- Storage keys are namespaced because GitHub Pages projects on the same domain share an origin. Older prototype storage keys are cleared on load.
- Credentials never appear in URLs, logs or rendered HTML. API error messages strip query strings and never include headers.
- Production builds set a Content-Security-Policy that forbids inline scripts and limits network access to GitHub, Hugging Face and the configured relay. `'wasm-unsafe-eval'` is allowed for libsodium.

The OAuth scopes requested by the worker (`repo workflow`) reach all of the user's repositories. A dedicated GitHub account, or a GitHub App with repository-scoped permissions, limits the impact.

## Public workspaces

Public repositories are supported. Their control branch and workflow logs may be readable by anyone. Current `session.json` files contain encrypted RDP endpoints, but a previously exposed address, log disclosure or network discovery can still reveal a tunnel. The reference image uses the `Cloud` account with no password. Set a strong Windows password before exposing RDP; ngrok's agent token does not authenticate RDP clients. The panel warns on the settings page, asks for confirmation before creating a public workspace or changing visibility, shows a persistent warning on the dashboard and confirms before starting a public instance.

## Development

Requirements: Node.js 22.

```bash
npm install
cp .env.example .env    # set PUBLIC_AUTH_URL to your deployed worker
npm run dev             # http://localhost:4321/auroflow/
```

| Command | Action |
|---|---|
| `npm run dev` | Development server. The CSP is not applied in development. |
| `npm run check` | Astro and TypeScript diagnostics. |
| `npm test` | Unit tests (Vitest) for state derivation, session parsing and helpers. |
| `npm run build` | Production build to `dist/`. |
| `npm run preview` | Serve the production build on port 4321. |

The worker accepts requests from `PANEL_ORIGINS` and from `http://localhost:4321` / `http://127.0.0.1:4321`, so both `dev` and `preview` can sign in against the deployed relay.

### Project structure

```
src/
  components/   Topbar, Icon set, DeviceLogin, ConfirmDialog, ArchitectureDiagram
  layouts/      BaseLayout (head, CSP, fonts, toasts, dialog)
  lib/          config, paths, storage, errors, github, huggingface, relay,
                session, vm-state (pure), vm-controller, poller, workspace, ui, format
  pages/        index, dashboard, panel (legacy redirect), settings, 404
  scripts/      Client entry points per page
  styles/       tokens.css, global.css, app.css, home.css, home-v2.css, panel.css, settings.css
tests/          Vitest unit tests
worker/         Cloudflare Worker for Device Flow
```

Integration constants (workflow file name, step names, branch, issue title, secret and variable names) live in `src/lib/config.ts` and `src/lib/vm-state.ts`. Update them there if the engine changes.

## Deployment

1. Create a GitHub OAuth App, enable Device Flow, and set its client ID in `worker/wrangler.toml`.
2. List every origin the panel is served from in `PANEL_ORIGINS` in `worker/wrangler.toml` (comma-separated, for example `https://fox3000foxy.com,https://fox3000foxy.github.io`), then deploy: `cd worker && npx wrangler deploy`. With a custom Pages domain, the browser sends the custom domain as its origin.
3. The deploy workflow uses `https://auroflow-auth.fox3000foxy.workers.dev` by default. To use another relay, add an Actions variable (not a secret) named `PUBLIC_AUTH_URL` with its URL.
4. Under Settings, Pages, select GitHub Actions as the source.
5. Push to `main`. `.github/workflows/pages.yml` runs the type check, unit tests and build, then deploys.

`astro.config.mjs` sets `site` and `base`. Every internal link goes through `href()` in `src/lib/paths.ts`, so changing `base` there is enough when deploying under another repository name. Pages are emitted as `dashboard/index.html` and `settings/index.html` with trailing-slash links. The legacy `panel/index.html` performs a client-side HTML redirect, not an HTTP 301.

## Engine compatibility

The Dashboard requires an Engine that publishes schema-v3 encrypted sessions using `AUROFLOW_PUBLIC_KEY`; older plaintext session metadata is not supported by this flow. The Dashboard sets this variable before dispatching a session. For engine internals, see [AuroFlow Engine](https://github.com/fox3000foxy/auroflow-engine).

## Golden Images and storage optimization

The reference Windows 10 IoT Enterprise LTSC 2021 image is a read-only, compressed QCOW2 base. Compatible custom QCOW2 images can be loaded from Hugging Face by configuring the image URL and SHA-256 in Settings. Custom disks must support the engine's x86-64, UEFI, VirtIO and RDP configuration.

A persistent session writes to an incremental QCOW2 overlay. On a clean shutdown, the overlay, UEFI variables and emulated TPM state are verified and committed to a private Hugging Face dataset. Scheduled compaction can merge multiple layers without modifying the Golden Image, verify the resulting disk with `qemu-img`, publish the consolidated layer and re-download it for validation. Optional history rewriting and orphaned LFS cleanup permanently remove older revisions and unreferenced blobs. These destructive operations require extra care and a separate backup.

A test consolidated three layers from approximately 1090.3 MiB to 998.1 MiB (8.5% smaller). The consolidated state was restored, booted in Windows and saved again successfully. Automatic scheduled compaction and LFS cleanup should be monitored separately; a successful manual test does not prove the entire scheduled lifecycle.

## Limitations

- The panel can only observe what GitHub exposes: vCPU and memory allocation are logged inside the VM step and are not available until the run completes, so the panel describes the allocation rule rather than live figures.
- Graceful shutdown depends on the engine polling issues every 15 seconds; requests are acknowledged within that window.
- The "Stopping..." state after a force stop is tracked per tab; other tabs show the run's step until GitHub reports it cancelled.
- Hugging Face CORS behaviour for dataset deletion and tree listing was verified against mocks only. If the Hub refuses a browser request, the panel shows the error and the dataset can be deleted from the Hugging Face website.
- Workspace creation uses GitHub's template generation endpoint, which requires the engine repository to be marked as a template.
