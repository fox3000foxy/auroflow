/**
 * Browser storage, split by sensitivity.
 *
 * GitHub Pages serves every project of an account from the same origin
 * (https://<user>.github.io), so storage is shared with the account's other
 * Pages sites. To limit exposure:
 *
 *  - Credentials live in sessionStorage only: scoped to one browser tab and
 *    discarded when the tab closes. They survive navigation and reloads, so
 *    the user signs in once per tab.
 *  - The GitHub token expires from storage after SESSION_TTL_MS of inactivity.
 *    If the user explicitly opts in ("Stay signed in on this browser"), it is
 *    kept in localStorage instead, for at most REMEMBER_TTL_MS, so new tabs
 *    are signed in too.
 *  - The ngrok token is never stored. It is sealed into a GitHub secret and
 *    dropped.
 *  - The Hugging Face token is stored only if the user opts in, because it is
 *    needed again for storage details and dataset deletion.
 *  - Non-secret workspace settings (owner, repository) go to localStorage.
 *
 * Keys are namespaced so they cannot collide with other projects on the origin.
 */

const NS = 'golden-panel.v2';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const REMEMBER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function read<T>(store: Storage, key: string): T | null {
  return safe(() => {
    const raw = store.getItem(`${NS}.${key}`);
    return raw ? (JSON.parse(raw) as T) : null;
  }, null);
}

function write(store: Storage, key: string, value: unknown): void {
  safe(() => store.setItem(`${NS}.${key}`, JSON.stringify(value)), undefined);
}

function remove(store: Storage, key: string): void {
  safe(() => store.removeItem(`${NS}.${key}`), undefined);
}

/* ---------------- Credentials (sessionStorage) ---------------- */

interface StoredGithub {
  token: string;
  login: string;
  touched: number;
}

export const credentials = {
  github(): (StoredGithub & { remembered: boolean }) | null {
    const session = read<StoredGithub>(sessionStorage, 'github');
    if (session?.token && Date.now() - session.touched <= SESSION_TTL_MS) return { ...session, remembered: false };
    if (session) remove(sessionStorage, 'github');
    const local = read<StoredGithub & { since: number }>(localStorage, 'github');
    if (local?.token && Date.now() - local.since <= REMEMBER_TTL_MS) return { ...local, remembered: true };
    if (local) remove(localStorage, 'github');
    return null;
  },
  setGithub(token: string, login: string, remember = false): void {
    const now = Date.now();
    if (remember) {
      remove(sessionStorage, 'github');
      write(localStorage, 'github', { token, login, touched: now, since: now });
    } else {
      remove(localStorage, 'github');
      write(sessionStorage, 'github', { token, login, touched: now } satisfies StoredGithub);
    }
  },
  touchGithub(): void {
    const value = read<StoredGithub>(sessionStorage, 'github');
    if (value) write(sessionStorage, 'github', { ...value, touched: Date.now() });
  },
  huggingFace(): string | null {
    return read<string>(sessionStorage, 'hf');
  },
  setHuggingFace(token: string | null): void {
    if (token) write(sessionStorage, 'hf', token);
    else remove(sessionStorage, 'hf');
  },
  clear(): void {
    remove(sessionStorage, 'github');
    remove(localStorage, 'github');
    remove(sessionStorage, 'hf');
    remove(sessionStorage, 'cancel');
  },
};

/* ---------------- Workspace configuration (localStorage) ---------------- */

export interface WorkspaceConfig {
  owner: string;
  repo: string;
}

export const workspaceStore = {
  get(): WorkspaceConfig | null {
    return read<WorkspaceConfig>(localStorage, 'workspace');
  },
  set(value: WorkspaceConfig): void {
    write(localStorage, 'workspace', value);
  },
  clear(): void {
    remove(localStorage, 'workspace');
  },
};

/* ---------------- Operational state ---------------- */

/** Cross-tab guard against launching the workflow twice. */
export const dispatchLock = {
  get(repoKey: string): number | null {
    return read<number>(localStorage, `dispatch.${repoKey}`);
  },
  set(repoKey: string, at: number): void {
    write(localStorage, `dispatch.${repoKey}`, at);
  },
  clear(repoKey: string): void {
    remove(localStorage, `dispatch.${repoKey}`);
  },
  storageKey(repoKey: string): string {
    return `${NS}.dispatch.${repoKey}`;
  },
};

/** Run IDs for which this tab requested cancellation. */
export const cancelRequests = {
  has(runId: number): boolean {
    return (read<number[]>(sessionStorage, 'cancel') ?? []).includes(runId);
  },
  add(runId: number): void {
    const list = read<number[]>(sessionStorage, 'cancel') ?? [];
    write(sessionStorage, 'cancel', [...list.filter((id) => id !== runId), runId].slice(-10));
  },
};

export interface ActivityEntry {
  at: number;
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
}

export const activityStore = {
  list(repoKey: string): ActivityEntry[] {
    return read<ActivityEntry[]>(localStorage, `activity.${repoKey}`) ?? [];
  },
  add(repoKey: string, entry: ActivityEntry): ActivityEntry[] {
    const next = [entry, ...activityStore.list(repoKey)].slice(0, 60);
    write(localStorage, `activity.${repoKey}`, next);
    return next;
  },
  clear(repoKey: string): void {
    remove(localStorage, `activity.${repoKey}`);
  },
};

/**
 * The first prototype kept the GitHub, ngrok and Hugging Face tokens in
 * sessionStorage under unnamespaced keys. Remove them and carry over the
 * non-secret repository name.
 */
export function migrateLegacyStorage(): void {
  safe(() => {
    for (const key of ['golden.github', 'golden.ngrok', 'golden.hf']) sessionStorage.removeItem(key);
    const legacyRepo = localStorage.getItem('golden.repo');
    for (const key of ['golden.repo', 'golden.dataset', 'golden.cidr']) localStorage.removeItem(key);
    if (legacyRepo && !workspaceStore.get()) {
      write(localStorage, 'legacyRepo', legacyRepo);
    }
  }, undefined);
}

export function takeLegacyRepo(): string | null {
  const value = read<string>(localStorage, 'legacyRepo');
  if (value) remove(localStorage, 'legacyRepo');
  return value;
}
