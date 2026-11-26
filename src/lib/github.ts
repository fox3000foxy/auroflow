import { ApiError, isNotFound, kindForStatus } from './errors';
import {
  CONTROL_BRANCH,
  ENDPOINT_RE,
  ENGINE_OWNER,
  ENGINE_REPO,
  SESSION_FILE,
  SHUTDOWN_TITLE_RE,
  WORKFLOW_FILE,
  WORKFLOW_PATH,
  WORKFLOW_REF,
  shutdownIssueTitle,
} from './config';

const API = 'https://api.github.com';

/* ---------------- Types (subset of the REST API responses) ---------------- */

export interface GhUser {
  login: string;
  name: string | null;
  avatar_url: string;
  html_url: string;
}

export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  visibility?: string;
  html_url: string;
  has_issues: boolean;
  archived: boolean;
  is_template?: boolean;
  default_branch: string;
  owner: { login: string };
  permissions?: { admin: boolean; push: boolean };
}

export type RunStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'waiting'
  | 'requested'
  | 'pending';

export interface GhRun {
  id: number;
  run_number: number;
  status: RunStatus;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_started_at?: string;
  event: string;
  actor?: { login: string };
  triggering_actor?: { login: string };
}

export interface GhStep {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'pending' | 'waiting';
  conclusion: string | null;
  number: number;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface GhJob {
  id: number;
  status: string;
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
  runner_name: string | null;
  labels: string[];
  html_url: string;
  steps?: GhStep[];
}

export interface GhIssue {
  number: number;
  title: string;
  state: string;
  html_url: string;
  user: { login: string } | null;
  pull_request?: unknown;
  created_at: string;
}

export interface GhCache {
  key: string;
  size_in_bytes: number;
  last_accessed_at: string;
  created_at: string;
}

/** Result of reading session.json from the control branch. */
export type SessionResult =
  | { kind: 'missing' }
  | { kind: 'valid'; runId: string; endpoint: string; commit: string }
  | { kind: 'stale'; runId: string; commit: string }
  | { kind: 'invalid'; reason: string; commit: string };

/* ---------------- Client ---------------- */

export class GitHubClient {
  /** Scopes granted to the token, read from X-OAuth-Scopes. */
  scopes: string[] | null = null;
  onUnauthorized: (() => void) | null = null;

  constructor(private readonly token: string) {}

  async request<T>(path: string, init: { method?: string; body?: unknown; accept?: string } = {}): Promise<T> {
    const method = init.method ?? 'GET';
    let response: Response;
    try {
      response = await fetch(API + path, {
        method,
        // GitHub answers with `Cache-Control: private, max-age=60`. Revalidate
        // every time so the panel never shows a minute-old VM state; unchanged
        // resources return 304, which does not count against the rate limit.
        cache: 'no-cache',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: init.accept ?? 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    } catch {
      throw new ApiError('GitHub', 'network', 'Network request failed');
    }

    const scopes = response.headers.get('X-OAuth-Scopes');
    if (scopes !== null) this.scopes = scopes.split(',').map((s) => s.trim()).filter(Boolean);

    if (!response.ok) {
      const rateLimited = response.headers.get('X-RateLimit-Remaining') === '0';
      let detail = '';
      try {
        const data = (await response.json()) as { message?: string; errors?: { message?: string }[] };
        detail = [data.message, ...(data.errors ?? []).map((e) => e.message)].filter(Boolean).join(' ');
      } catch {
        /* body is not JSON */
      }
      const kind = kindForStatus(response.status, rateLimited);
      if (kind === 'auth') this.onUnauthorized?.();
      throw new ApiError('GitHub', kind, `${method} ${path.split('?')[0]} returned ${response.status}${detail ? `: ${detail}` : ''}`, response.status);
    }
    if (response.status === 204 || response.status === 205) return null as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /* ---- Account ---- */

  user(): Promise<GhUser> {
    return this.request<GhUser>('/user');
  }

  /* ---- Repository ---- */

  repo(owner: string, repo: string): Promise<GhRepo> {
    return this.request<GhRepo>(`/repos/${owner}/${repo}`);
  }

  async findRepo(owner: string, repo: string): Promise<GhRepo | null> {
    try {
      return await this.repo(owner, repo);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  updateRepo(owner: string, repo: string, patch: Partial<Pick<GhRepo, 'private' | 'has_issues'>>): Promise<GhRepo> {
    return this.request<GhRepo>(`/repos/${owner}/${repo}`, { method: 'PATCH', body: patch });
  }

  engineRepo(): Promise<GhRepo> {
    return this.repo(ENGINE_OWNER, ENGINE_REPO);
  }

  generateFromTemplate(owner: string, name: string, isPrivate: boolean): Promise<GhRepo> {
    return this.request<GhRepo>(`/repos/${ENGINE_OWNER}/${ENGINE_REPO}/generate`, {
      method: 'POST',
      body: {
        owner,
        name,
        private: isPrivate,
        include_all_branches: false,
        description: 'Windows Golden workspace',
      },
    });
  }

  /** Raw text of a file, or null if it does not exist. */
  async fileText(owner: string, repo: string, path: string, ref?: string): Promise<string | null> {
    try {
      const data = await this.request<{ content: string; encoding: string }>(
        `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`,
      );
      return decodeBase64(data.content);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  workflowSource(owner: string, repo: string): Promise<string | null> {
    return this.fileText(owner, repo, WORKFLOW_PATH);
  }

  actionsPermissions(owner: string, repo: string): Promise<{ enabled: boolean }> {
    return this.request(`/repos/${owner}/${repo}/actions/permissions`);
  }

  /* ---- Secrets and variables ---- */

  async secretInfo(owner: string, repo: string, name: string): Promise<{ name: string; updated_at: string } | null> {
    try {
      return await this.request(`/repos/${owner}/${repo}/actions/secrets/${name}`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Seal a secret with the repository public key (libsodium sealed box). */
  async putSecret(owner: string, repo: string, name: string, value: string): Promise<void> {
    // Loaded on demand: libsodium is only needed when saving secrets.
    const { default: sodium } = await import('libsodium-wrappers');
    await sodium.ready;
    const key = await this.request<{ key: string; key_id: string }>(`/repos/${owner}/${repo}/actions/secrets/public-key`);
    const sealed = sodium.crypto_box_seal(
      sodium.from_string(value),
      sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
    );
    await this.request(`/repos/${owner}/${repo}/actions/secrets/${name}`, {
      method: 'PUT',
      body: { encrypted_value: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL), key_id: key.key_id },
    });
  }

  async variable(owner: string, repo: string, name: string): Promise<string | null> {
    try {
      const data = await this.request<{ value: string }>(`/repos/${owner}/${repo}/actions/variables/${name}`);
      return data.value;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async setVariable(owner: string, repo: string, name: string, value: string): Promise<void> {
    try {
      await this.request(`/repos/${owner}/${repo}/actions/variables/${name}`, { method: 'PATCH', body: { name, value } });
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await this.request(`/repos/${owner}/${repo}/actions/variables`, { method: 'POST', body: { name, value } });
    }
  }

  /* ---- Workflow runs ---- */

  async runs(owner: string, repo: string, perPage = 10): Promise<GhRun[]> {
    const data = await this.request<{ workflow_runs: GhRun[] }>(
      `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=${perPage}`,
    );
    return data.workflow_runs;
  }

  async jobs(owner: string, repo: string, runId: number): Promise<GhJob[]> {
    const data = await this.request<{ jobs: GhJob[] }>(`/repos/${owner}/${repo}/actions/runs/${runId}/jobs?per_page=10`);
    return data.jobs;
  }

  dispatch(owner: string, repo: string): Promise<void> {
    return this.request(`/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      body: { ref: WORKFLOW_REF },
    });
  }

  cancel(owner: string, repo: string, runId: number): Promise<void> {
    return this.request(`/repos/${owner}/${repo}/actions/runs/${runId}/cancel`, { method: 'POST' });
  }

  async goldenCaches(owner: string, repo: string): Promise<GhCache[]> {
    const data = await this.request<{ actions_caches: GhCache[] }>(
      `/repos/${owner}/${repo}/actions/caches?key=golden-&per_page=10`,
    );
    return data.actions_caches;
  }

  async releaseByTag(owner: string, repo: string, tag: string): Promise<{ assets: { name: string; size: number }[]; html_url: string } | null> {
    try {
      return await this.request(`/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /* ---- Control protocol ---- */

  /**
   * Read session.json from the control branch and check it belongs to `runId`.
   * Distinguishes a missing branch or file from a stale or malformed session.
   * Real API failures are thrown.
   */
  async session(owner: string, repo: string, runId: number): Promise<SessionResult> {
    let commit: string;
    try {
      const ref = await this.request<{ object: { sha: string } }>(`/repos/${owner}/${repo}/git/ref/heads/${CONTROL_BRANCH}`);
      commit = ref.object.sha;
    } catch (error) {
      if (isNotFound(error)) return { kind: 'missing' };
      throw error;
    }
    const raw = await this.fileText(owner, repo, SESSION_FILE, commit);
    if (raw === null) return { kind: 'missing' };
    return parseSession(raw, runId, commit);
  }

  async openShutdownIssues(owner: string, repo: string): Promise<GhIssue[]> {
    const issues = await this.request<GhIssue[]>(`/repos/${owner}/${repo}/issues?state=open&per_page=100`);
    return issues.filter((issue) => !issue.pull_request && SHUTDOWN_TITLE_RE.test(issue.title) && issue.user?.login === owner);
  }

  createShutdownIssue(owner: string, repo: string, runId: number): Promise<GhIssue> {
    return this.request<GhIssue>(`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: {
        title: shutdownIssueTitle(runId),
        body: `Graceful shutdown requested from Windows Golden Panel for workflow run ${runId}.\n\nThe engine polls this issue, sends an ACPI power-down to Windows and saves the persistent layers before the run completes.`,
      },
    });
  }

  closeIssue(owner: string, repo: string, number: number): Promise<GhIssue> {
    return this.request<GhIssue>(`/repos/${owner}/${repo}/issues/${number}`, {
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'completed' },
    });
  }
}

/* ---------------- Pure helpers (unit tested) ---------------- */

export function decodeBase64(content: string): string {
  const binary = atob(content.replace(/\s+/g, ''));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function parseSession(raw: string, runId: number, commit: string): SessionResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', reason: 'session.json is not valid JSON', commit };
  }
  if (!data || typeof data !== 'object') return { kind: 'invalid', reason: 'session.json has no object', commit };
  const { run_id: sessionRun, endpoint } = data as { run_id?: unknown; endpoint?: unknown };
  const sessionRunId = sessionRun === undefined || sessionRun === null ? '' : String(sessionRun);
  if (!sessionRunId) return { kind: 'invalid', reason: 'session.json has no run_id', commit };
  if (sessionRunId !== String(runId)) return { kind: 'stale', runId: sessionRunId, commit };
  if (typeof endpoint !== 'string' || !ENDPOINT_RE.test(endpoint)) {
    return { kind: 'invalid', reason: 'session.json endpoint has an unexpected format', commit };
  }
  return { kind: 'valid', runId: sessionRunId, endpoint, commit };
}
