import { GitHubClient, type GhUser } from './github';
import { ApiError } from './errors';
import { REQUIRED_SCOPES } from './config';
import { credentials, migrateLegacyStorage, workspaceStore, activityStore, type ActivityEntry } from './storage';

export interface AppSession {
  gh: GitHubClient;
  user: GhUser;
  missingScopes: string[];
}

let cached: Promise<AppSession | null> | null = null;

/** Build a client that signs the user out when GitHub rejects the token. */
function client(token: string): GitHubClient {
  const gh = new GitHubClient(token);
  gh.onUnauthorized = () => {
    credentials.clear();
    document.dispatchEvent(new CustomEvent('golden:signed-out', { detail: { expired: true } }));
  };
  return gh;
}

/**
 * Restore the GitHub session for this tab. Resolves to null when signed out.
 * Throws only for network or server failures, so the UI can tell "signed out"
 * apart from "GitHub unreachable".
 */
export function loadSession(): Promise<AppSession | null> {
  if (cached) return cached;
  migrateLegacyStorage();
  cached = (async () => {
    const stored = credentials.github();
    if (!stored) return null;
    const gh = client(stored.token);
    try {
      const user = await gh.user();
      credentials.touchGithub();
      return { gh, user, missingScopes: missing(gh.scopes) };
    } catch (error) {
      if (error instanceof ApiError && error.kind === 'auth') return null;
      cached = null;
      throw error;
    }
  })();
  return cached;
}

/** Complete sign-in with a token from Device Flow. */
export async function signIn(token: string, remember = false): Promise<AppSession> {
  const gh = client(token);
  const user = await gh.user();
  credentials.setGithub(token, user.login, remember);
  const session = { gh, user, missingScopes: missing(gh.scopes) };
  cached = Promise.resolve(session);
  document.dispatchEvent(new CustomEvent('golden:signed-in', { detail: session }));
  return session;
}

export function signOut(): void {
  credentials.clear();
  cached = Promise.resolve(null);
  document.dispatchEvent(new CustomEvent('golden:signed-out', { detail: { expired: false } }));
}

/** Whether the token is remembered across tabs (opt-in). */
export function isRemembered(): boolean {
  return credentials.github()?.remembered ?? false;
}

/** Last known login, for rendering the header before the token is verified. */
export function storedLogin(): string | null {
  return credentials.github()?.login ?? null;
}

function missing(scopes: string[] | null): string[] {
  if (scopes === null) return [];
  return REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
}

/** Workspace selected in Settings, defaulting the owner to the signed-in user. */
export function currentWorkspace(login: string): { owner: string; repo: string } | null {
  const value = workspaceStore.get();
  if (!value?.repo) return null;
  return { owner: value.owner || login, repo: value.repo };
}

/** Activity log shared by the panel and settings. */
export function logActivity(repoKey: string, level: ActivityEntry['level'], message: string): void {
  const entries = activityStore.add(repoKey, { at: Date.now(), level, message });
  document.dispatchEvent(new CustomEvent('golden:activity', { detail: entries }));
}
