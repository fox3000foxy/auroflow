# Backend compatibility notes

No change to the VM engine (`fox3000foxy/auroflow-engine`) or to the authentication worker is required for this version of the panel. The items below are inconsistencies found while integrating, with the panel's workaround and a recommended engine change. None of them have been applied.

## 1. `RDP_ALLOWED_CIDR` is required but not enforced

Commit `3254527` removed `--cidr-allow` from the `ngrok tcp` command, but the *Start ngrok RDP tunnel* step still runs:

```bash
test -n "$RDP_ALLOWED_CIDR"
python3 -c '... assert n.version==4 and n.prefixlen==32 ...'
```

The workflow therefore fails without the variable, while ngrok accepts connections from any address.

**Panel behaviour.** The panel reads the workspace's own workflow file and detects three cases: `--cidr-allow` present (enforced), `RDP_ALLOWED_CIDR` referenced without it (validated only), or not referenced. In the current case it still asks for the value, validates it like the workflow does, and states plainly that connections are not filtered. Validation reports this as a warning.

**Recommended engine change.** Either remove the two checks, or restore enforcement (for example with an ngrok traffic policy, which needs a plan that supports IP restrictions). The panel adapts automatically in both cases.

## 2. Shutdown issues are never closed

`panel-control.py shutdown` only reads open issues titled `Golden shutdown <run_id>`. Nothing closes them, so they accumulate.

**Panel behaviour.** Before creating an issue, the panel checks that none exists for the run (no duplicates). When it sees that no run is active, it closes open shutdown issues created by the owner for finished runs.

**Recommended engine change (optional).** Close the matching issue after *Save persistent layers*, for example with `gh issue close`. This would need `issues: write` in the workflow permissions.

## 3. `session.json` outlives its run

The control branch keeps the last endpoint after the run ends.

**Panel behaviour.** The endpoint is shown only for an active run whose ID matches `run_id`, so stale sessions are ignored and labelled as such.

**Recommended engine change (optional).** Overwrite `session.json` with `{"run_id": "...", "endpoint": null}` in an `if: always()` step at the end of the job.

## 4. Shutdown requests require `author_association == OWNER`

This matches workspaces created by the panel, which are always under the signed-in user's account. A workspace owned by an organization would report `MEMBER` and shutdown requests would be ignored. The panel only creates user-owned workspaces, so this is not reachable from the UI today.

## 5. Template generation

Workspace creation calls `POST /repos/fox3000foxy/auroflow-engine/generate`, which only works if the engine repository is marked as a template (Settings, General, Template repository). This could not be verified from the build environment. If it is not, the panel shows the GitHub error and the workspace can be created with "Use this template" or a fork, then selected by name in Settings.

## 6. Authentication worker (changed)

The worker accepted a single origin (`PANEL_ORIGIN = https://fox3000foxy.github.io`). The panel is served from the custom domain `https://fox3000foxy.com`, so the browser sent that origin, the worker answered 403 **without CORS headers**, and the browser reported an opaque CORS error.

Changes in `worker/index.js` and `worker/wrangler.toml`:

- `PANEL_ORIGINS` accepts a comma-separated list (`https://fox3000foxy.com,https://fox3000foxy.github.io`). `PANEL_ORIGIN` is still read for older configurations. `http://localhost:4321` and `http://127.0.0.1:4321` stay allowed for development.
- Every response, including errors (400, 404, 405, 500, 502), carries CORS headers for allowed origins, so the panel shows the real error instead of a CORS failure.
- Refused origins get a JSON 403 (`origin_not_allowed`) that the panel can read and explain.
- Malformed JSON, a missing or oversized `device_code`, a missing client ID and GitHub being unreachable are handled explicitly.
- `Vary: Origin` and a 24-hour preflight cache are set.

Redeploy with `cd worker && npx wrangler deploy`. The worker still has no rate limiting; Cloudflare's rate limiting rules can be added without code changes.
