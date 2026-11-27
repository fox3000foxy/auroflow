# AuroFlow

> Ephemeral compute. Persistent state.
>
> Workflow-powered cloud virtualization.

Static web application for [AuroFlow](https://github.com/fox3000foxy/auroflow-engine): on-demand Windows 10 IoT Enterprise LTSC 2021 virtual machines running under QEMU/KVM on GitHub Actions, reachable over RDP through ngrok, with persistent storage as compressed QCOW2 layers in a private Hugging Face dataset.

The panel has no backend of its own. It talks to the GitHub REST API and the Hugging Face API directly from the browser. A small Cloudflare Worker (`worker/`) relays GitHub Device Flow, because GitHub's OAuth endpoints do not accept browser CORS requests.

## Pages

| Path | Purpose |
|---|---|
| `/` | Project overview: what runs, architecture diagram, session lifecycle, persistence, getting started, security notes. |
| `/panel/` | VM dashboard: status, RDP endpoint, start, graceful shutdown, force stop, lifecycle, activity, compute and storage. |
| `/settings/` | Sign-in, workspace repository and visibility, ngrok and Hugging Face credentials, network restriction, validation, danger zone. |

## How the panel reads VM state

The VM status is derived from the steps of the active workflow run (`GET /actions/runs/{id}/jobs`), not from the run status alone:

| Status | Condition |
|---|---|
| OFF (red) | No queued or running run. |
| Booting... (yellow) | Start requested, run queued, or any step before *Wait for shutdown*. The detail line names the current step. |
| ON (green) | *Wait for shutdown* is running and `session.json` on `golden-control` belongs to this run. |
| Shutting down... (orange) | A `Golden shutdown <run_id>` issue exists for this run, or the run is finishing. |
| Saving... (blue) | *Save persistent layers* is running. |
| Stopping... (orange) | Force stop was requested from this browser. |

The endpoint is displayed only when `session.json` has the current `run_id` and a valid `host:port`. Endpoints of completed or cancelled runs are never shown. The panel distinguishes a missing control branch, a stale session from another run, a malformed file and an API error, and shows each differently. GitHub Actions status is kept as secondary information in its own panel.

### Connecting

When the endpoint is available, the panel offers three ways to connect:

- **Copy**: the `host:port` address, for any RDP client.
- **Download .rdp**: a connection file generated in the browser (`full address:s:host:port`, no credentials). Remote Desktop Connection opens it on Windows, Windows App on macOS and Remmina on Linux.
- **Open in Remote Desktop**: a legacy `rdp://full%20address=s:host:port` link, shown only on macOS, iOS and Android, the only platforms whose Microsoft clients handle this URI scheme. Windows clients do not support it.

Polling runs every 5 to 6 seconds during transitions and every 15 seconds while ON. It stops while the instance is off and while the tab is hidden, backs off on errors, and stops on authentication errors. Requests use `cache: 'no-cache'` so GitHub's 60-second `Cache-Control` never shows a stale state; unchanged resources answer 304, which does not count against the rate limit.

Duplicate launches are prevented by checking for active runs before dispatching and by a cross-tab dispatch lock held until the new run appears (or for two minutes).

## Credential handling

- **GitHub token**: kept in `sessionStorage`, scoped to the browser tab, expires after 8 hours of inactivity. Users can opt in to "Stay signed in on this browser", which keeps it in `localStorage` for up to 7 days. Sign-out clears both.
- **ngrok token**: sealed in the browser with the repository public key (libsodium `crypto_box_seal`) and stored as the `NGROK_AUTHTOKEN` Actions secret. Never stored in the browser.
- **Hugging Face token**: sealed into the `HF_TOKEN` secret. Optionally kept in `sessionStorage` (on by default, clearable) so the panel can show layer details and delete the dataset without asking again.
- Storage keys are namespaced (`golden-panel.v2.*`), because every GitHub Pages project of an account shares the `<user>.github.io` origin. Unnamespaced keys from the first prototype are removed on load.
- Credentials never appear in URLs, logs or rendered HTML. API error messages strip query strings and never include headers.
- Production builds set a Content-Security-Policy that forbids inline scripts and limits network access to GitHub, Hugging Face and the configured relay. `'wasm-unsafe-eval'` is allowed for libsodium.

The OAuth scopes requested by the worker (`repo workflow`) reach all of the user's repositories. A dedicated GitHub account, or a GitHub App with repository-scoped permissions, limits the impact.

## Public workspaces

Public repositories are supported. `session.json` and the workflow annotations are then readable by anyone, and the reference image has a passwordless account. The panel warns on the settings page, asks for confirmation before creating a public workspace or changing visibility, shows a persistent warning on the dashboard and confirms before starting a public instance.

## Development

Requirements: Node.js 22.

```bash
npm install
cp .env.example .env    # set PUBLIC_AUTH_URL to your deployed worker
npm run dev             # http://localhost:4321/auroflow-panel/
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
  pages/        index, panel, settings, 404
  scripts/      Client entry points per page
  styles/       tokens.css, global.css, app.css, home.css, panel.css, settings.css
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

`astro.config.mjs` sets `site` and `base`. Every internal link goes through `href()` in `src/lib/paths.ts`, so changing `base` there is enough when deploying under another repository name. Pages are emitted as `panel/index.html` and `settings/index.html` with trailing-slash links, which GitHub Pages serves without redirects.

## Engine compatibility

The panel works with the current engine without modification. Compatibility notes and recommended engine changes are in [docs/backend-changes.md](docs/backend-changes.md).

## Limitations

- The panel can only observe what GitHub exposes: vCPU and memory allocation are logged inside the VM step and are not available until the run completes, so the panel describes the allocation rule rather than live figures.
- Graceful shutdown depends on the engine polling issues every 15 seconds; requests are acknowledged within that window.
- The "Stopping..." state after a force stop is tracked per tab; other tabs show the run's step until GitHub reports it cancelled.
- Hugging Face CORS behaviour for dataset deletion and tree listing was verified against mocks only. If the Hub refuses a browser request, the panel shows the error and the dataset can be deleted from the Hugging Face website.
- Workspace creation uses GitHub's template generation endpoint, which requires the engine repository to be marked as a template.
