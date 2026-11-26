# Golden Panel

Astro static frontend prototype. No tokens are persisted in browser storage. GitHub OAuth tokens remain in memory until reload. GitHub secrets are sealed using libsodium.

## Setup

Create a GitHub OAuth App and enable Device Flow. Set its client ID in worker/wrangler.toml. Deploy the relay with `cd worker && npx wrangler deploy`. Set PUBLIC_AUTH_URL in a local .env or GitHub repository Actions variable. Enable GitHub Pages with GitHub Actions as source. Run npm install and npm run dev locally.

The OAuth scope repo is broad and grants access beyond the workspace; a narrowly scoped GitHub App is preferable for production. The relay needs rate limiting. The HF deletion endpoint and browser CORS need integration testing. The panel asks for the HF token again for deletion because GitHub secrets cannot be read back.

## Engine integration required

Start is deliberately blocked until the engine has a golden-panel-protocol.txt file containing 1. Do not add that marker until the engine enforces authenticated RDP and an IP allowlist, publishes session.json on the private golden-control branch with run_id and endpoint, and polls authenticated shutdown requests (issues titled Golden shutdown RUN_ID, validating author and run ID). Enable issues on the private workspace if using this protocol. The engine must shut down via QMP and save persistence before completing. Force cancellation can lose data. Require a licensed image and an authorized runner workload. The current engine is not modified by this archive.

This is an untested integration scaffold, not a production deployment. Use a dedicated GitHub account or replace broad OAuth scopes before public release.
