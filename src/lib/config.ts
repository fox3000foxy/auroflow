/**
 * Integration constants. Every value here mirrors something that exists in the
 * VM engine repository (fox3000foxy/auroflow-engine). If the engine changes,
 * this is the single place to update.
 */

export const ENGINE_OWNER = 'fox3000foxy';
export const ENGINE_REPO = 'auroflow-engine';
export const ENGINE_URL = `https://github.com/${ENGINE_OWNER}/${ENGINE_REPO}`;
export const PANEL_URL = 'https://github.com/fox3000foxy/auroflow-panel';

/** .github/workflows/windows-persistent.yml in the engine. */
export const WORKFLOW_FILE = 'windows-persistent.yml';
export const WORKFLOW_PATH = `.github/workflows/${WORKFLOW_FILE}`;
export const WORKFLOW_REF = 'main';

/** Branch written by scripts/panel-control.py `publish`. */
export const CONTROL_BRANCH = 'golden-control';
export const SESSION_FILE = 'session.json';

/** Issue title polled by scripts/panel-control.py `shutdown`. */
export const shutdownIssueTitle = (runId: number | string) => `Golden shutdown ${runId}`;
export const SHUTDOWN_TITLE_RE = /^Golden shutdown (\d+)$/;

/** Endpoint format accepted by panel-control.py. */
export const ENDPOINT_RE = /^[a-zA-Z0-9.-]+:[0-9]{1,5}$/;

/** Secrets and variables read by the workflow. */
export const SECRET_NGROK = 'NGROK_AUTHTOKEN';
export const SECRET_HF = 'HF_TOKEN';
export const VAR_HF_REPO = 'HF_REPO';
export const VAR_RDP_CIDR = 'RDP_ALLOWED_CIDR';

/** Workflow timing (timeout-minutes and DEADLINE in the workflow). */
export const WORKFLOW_TIMEOUT_MIN = 300;
export const AUTO_SHUTDOWN_MIN = 287;

/** Values documented in the engine README (System specifications). */
export const SPEC = {
  os: 'Windows 10 IoT Enterprise LTSC 2021',
  version: '21H2',
  build: '19044.1288',
  virtualDisk: '64 GiB',
  machine: 'pc-q35-10.0',
  firmware: 'UEFI (OVMF), emulated TPM 2.0',
} as const;

/** Default repository name suggested for a new workspace. */
export const DEFAULT_WORKSPACE_REPO = 'auroflow-instance';

export const REPO_NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
export const DATASET_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** OAuth scopes requested by the authentication worker. */
export const REQUIRED_SCOPES = ['repo', 'workflow'];

export const AUTH_URL = (import.meta.env.PUBLIC_AUTH_URL ?? '').replace(/\/+$/, '');
