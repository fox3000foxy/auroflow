import type { GhRepo, GitHubClient } from './github';
import { ApiError, describe } from './errors';
import { HuggingFaceClient, defaultDatasetName } from './huggingface';
import {
  REQUIRED_SCOPES,
  SECRET_HF,
  SECRET_NGROK,
  VAR_HF_REPO,
  VAR_RDP_CIDR,
} from './config';

/**
 * How the workspace's workflow treats RDP_ALLOWED_CIDR.
 *  - enforced:  passed to ngrok (--cidr-allow), connections are filtered.
 *  - validated: required and checked by the workflow, but not enforced.
 *  - absent:    not referenced; the setting is not offered.
 */
export type NetworkSupport = 'enforced' | 'validated' | 'absent' | 'unknown';

export interface WorkspaceStatus {
  repo: GhRepo | null;
  workflowPresent: boolean;
  network: NetworkSupport;
  actionsEnabled: boolean | null;
  secrets: { ngrok: string | null; hf: string | null };
  customGolden?: boolean;
  variables: {
    hfRepo: string | null;
    cidr: string | null;
    goldenUrl?: string | null;
    goldenHash?: string | null;
  };
}

export function networkSupport(source: string | null): NetworkSupport {
  if (source === null) return 'unknown';
  if (/--cidr-allow/.test(source)) return 'enforced';
  if (/RDP_ALLOWED_CIDR/.test(source)) return 'validated';
  return 'absent';
}

export async function inspectWorkspace(gh: GitHubClient, owner: string, name: string): Promise<WorkspaceStatus> {
  const repo = await gh.findRepo(owner, name);
  if (!repo) {
    return {
      repo: null,
      workflowPresent: false,
      network: 'unknown',
      actionsEnabled: null,
      secrets: { ngrok: null, hf: null },
      variables: { hfRepo: null, cidr: null },
    };
  }
  const [source, actions, ngrok, hf, hfRepo, cidr, goldenUrl, goldenHash] = await Promise.all([
    gh.workflowSource(owner, name),
    gh.actionsPermissions(owner, name).catch(() => null),
    gh.secretInfo(owner, name, SECRET_NGROK),
    gh.secretInfo(owner, name, SECRET_HF),
    gh.variable(owner, name, VAR_HF_REPO),
    gh.variable(owner, name, VAR_RDP_CIDR),
    gh.variable(owner, name, 'GOLDEN_URL'),
    gh.variable(owner, name, 'GOLDEN_SHA256'),
  ]);
  return {
    repo,
    workflowPresent: source !== null,
    network: networkSupport(source),
    actionsEnabled: actions ? actions.enabled : null,
    secrets: { ngrok: ngrok?.updated_at ?? null, hf: hf?.updated_at ?? null },
    customGolden: !!source && source.includes('GOLDEN_URL'),
    variables: { hfRepo, cidr, goldenUrl, goldenHash },
  };
}

/* ---------------- Validation ---------------- */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export function isValidIpv4Host(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/32$/.exec(value.trim());
  return !!match && match.slice(1).every((part) => Number(part) <= 255 && String(Number(part)) === part);
}

export async function validateWorkspace(
  gh: GitHubClient,
  status: WorkspaceStatus,
  context: { owner: string; repo: string; hfToken: string | null },
): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, label: string, ok: CheckStatus, detail: string) => checks.push({ id, label, status: ok, detail });

  const scopes = gh.scopes;
  const missing = scopes ? REQUIRED_SCOPES.filter((s) => !scopes.includes(s)) : [];
  add('scopes', 'GitHub authorization', missing.length ? 'fail' : 'pass', missing.length ? `Missing scopes: ${missing.join(', ')}. Sign out and sign in again.` : 'Token grants repo and workflow scopes.');

  const { repo } = status;
  if (!repo) {
    add('repo', 'Workspace repository', 'fail', `${context.owner}/${context.repo} does not exist yet. Save the configuration to create it from the Golden template.`);
    return checks;
  }
  add('repo', 'Workspace repository', repo.archived ? 'fail' : 'pass', repo.archived ? 'The repository is archived and cannot run workflows.' : `${repo.full_name} is reachable.`);
  if (repo.permissions && !repo.permissions.admin) {
    add('admin', 'Repository permissions', 'fail', 'Admin access is required to write secrets and variables.');
  }
  add('visibility', 'Visibility', repo.private ? 'pass' : 'warn', repo.private ? 'Private. The RDP endpoint is visible only to collaborators.' : 'Public. Anyone can read the RDP endpoint from the golden-control branch and the workflow logs.');
  add('workflow', 'VM workflow', status.workflowPresent ? 'pass' : 'fail', status.workflowPresent ? 'windows-persistent.yml is present.' : 'windows-persistent.yml was not found on the default branch.');
  add('actions', 'GitHub Actions', status.actionsEnabled === false ? 'fail' : status.actionsEnabled ? 'pass' : 'warn', status.actionsEnabled === false ? 'Actions are disabled for this repository. Enable them under Settings, Actions.' : status.actionsEnabled ? 'Actions are enabled.' : 'Actions permissions could not be read.');
  add('issues', 'Graceful shutdown channel', repo.has_issues ? 'pass' : 'fail', repo.has_issues ? 'Issues are enabled; shutdown requests can be delivered.' : 'Issues are disabled. Saving the configuration enables them.');
  add('ngrok', 'ngrok token', status.secrets.ngrok ? 'pass' : 'fail', status.secrets.ngrok ? `Stored as ${SECRET_NGROK}.` : `${SECRET_NGROK} is not set.`);
  add('hf', 'Hugging Face token', status.secrets.hf ? 'pass' : 'fail', status.secrets.hf ? `Stored as ${SECRET_HF}.` : `${SECRET_HF} is not set. Without it the engine runs in fresh mode and nothing is saved.`);
  add('dataset', 'Dataset name', status.variables.hfRepo ? 'pass' : 'warn', status.variables.hfRepo ? `${VAR_HF_REPO} is ${status.variables.hfRepo}.` : `${VAR_HF_REPO} is not set. The engine uses <hf-user>/${context.repo}-layers.`);

  if (status.network === 'validated' || status.network === 'enforced') {
    const cidr = status.variables.cidr;
    const ok = !!cidr && isValidIpv4Host(cidr);
    add('cidr', 'RDP address restriction', ok ? (status.network === 'enforced' ? 'pass' : 'warn') : 'fail', !ok ? `${VAR_RDP_CIDR} must be a single IPv4 address (a.b.c.d/32). The workflow stops without it.` : status.network === 'enforced' ? `ngrok only accepts ${cidr}.` : `${cidr} is set, but this engine version does not pass it to ngrok. Connections are not filtered.`);
  }

  if (context.hfToken) {
    try {
      const hf = new HuggingFaceClient(context.hfToken);
      const me = await hf.whoami();
      const datasetId = status.variables.hfRepo ?? defaultDatasetName(me.name, context.repo);
      const dataset = await hf.datasetOrNull(datasetId);
      if (!dataset) add('hf-dataset', 'Persistence dataset', 'warn', `${datasetId} does not exist yet. The engine creates it as private on the first run.`);
      else add('hf-dataset', 'Persistence dataset', dataset.private ? 'pass' : 'fail', dataset.private ? `${datasetId} is private.` : `${datasetId} is public. The engine refuses to use a public dataset.`);
    } catch (error) {
      add('hf-dataset', 'Persistence dataset', 'warn', `Could not check with Hugging Face: ${describe(error)}`);
    }
  } else {
    add('hf-dataset', 'Persistence dataset', 'skip', 'Keep the Hugging Face token in this tab to check the dataset.');
  }
  return checks;
}

/* ---------------- Save ---------------- */

export interface SaveInput {
  owner: string;
  repo: string;
  private: boolean;
  ngrokToken: string;
  hfToken: string;
  dataset: string;
  cidr: string;
  goldenUrl?: string;
  goldenHash?: string;
  /** Change visibility of an existing repository to match `private`. */
  applyVisibility: boolean;
}

export type Progress = (message: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function saveWorkspace(gh: GitHubClient, input: SaveInput, progress: Progress): Promise<GhRepo> {
  const { owner, repo: name } = input;
  let repo = await gh.findRepo(owner, name);

  if (!repo) {
    progress(`Creating ${owner}/${name} from the Golden template`);
    try {
      await gh.generateFromTemplate(owner, name, input.private);
    } catch (error) {
      if (error instanceof ApiError && (error.kind === 'not_found' || error.kind === 'validation')) {
        throw new ApiError('GitHub', error.kind, `Could not create the repository from the template. ${error.message}`, error.status);
      }
      throw error;
    }
    for (let attempt = 0; attempt < 20 && !repo; attempt += 1) {
      await sleep(1500);
      repo = await gh.findRepo(owner, name);
    }
    if (!repo) throw new ApiError('GitHub', 'server', 'The repository was created but is not reachable yet. Try saving again in a moment.');
    progress('Waiting for the template files');
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (await gh.workflowSource(owner, name)) break;
      await sleep(1500);
    }
  } else if (input.applyVisibility && repo.private !== input.private) {
    progress(`Changing visibility to ${input.private ? 'private' : 'public'}`);
    repo = await gh.updateRepo(owner, name, { private: input.private });
  }

  if (!repo.has_issues) {
    progress('Enabling issues for graceful shutdown');
    repo = await gh.updateRepo(owner, name, { has_issues: true });
  }

  if (input.ngrokToken) {
    progress(`Sealing ${SECRET_NGROK}`);
    await gh.putSecret(owner, name, SECRET_NGROK, input.ngrokToken);
  }
  if (input.hfToken) {
    progress(`Sealing ${SECRET_HF}`);
    await gh.putSecret(owner, name, SECRET_HF, input.hfToken);
  }
  if (input.dataset) {
    progress(`Setting ${VAR_HF_REPO}`);
    await gh.setVariable(owner, name, VAR_HF_REPO, input.dataset);
  }
  if (input.cidr) {
    progress(`Setting ${VAR_RDP_CIDR}`);
    await gh.setVariable(owner, name, VAR_RDP_CIDR, input.cidr.trim());
  }
  if (input.goldenUrl !== undefined) {
    const source = await gh.workflowSource(owner, name);
    if (input.goldenUrl && !source?.includes('GOLDEN_URL')) {
      throw new Error('Update the workspace engine before using custom images.');
    }
    if (source?.includes('GOLDEN_URL')) {
      progress('Saving Golden Image configuration');
      await gh.setVariable(owner, name, 'GOLDEN_SHA256', input.goldenHash || '');
      await gh.setVariable(owner, name, 'GOLDEN_URL', input.goldenUrl);
    }
  }
  progress('Configuration saved');
  return repo;
}
