/** Header identity on app pages. */
import { loadSession, signOut, storedLogin } from '../lib/session';
import { confirmDialog, toast } from '../lib/ui';
import type { GhUser } from '../lib/github';

function render(user: Pick<GhUser, 'login' | 'avatar_url'> | null) {
  const root = document.querySelector<HTMLElement>('[data-identity]');
  if (!root) return;
  const userEl = root.querySelector<HTMLElement>('[data-identity-user]')!;
  const avatar = root.querySelector<HTMLImageElement>('[data-identity-avatar]')!;
  const name = root.querySelector<HTMLElement>('[data-identity-name]')!;
  const signin = root.querySelector<HTMLElement>('[data-identity-signin]')!;
  const signout = root.querySelector<HTMLElement>('[data-identity-signout]')!;
  userEl.hidden = !user;
  signout.hidden = !user;
  signin.hidden = !!user || document.body.dataset.page === 'settings';
  if (user) {
    name.textContent = user.login;
    if (user.avatar_url && /^https:\/\/avatars\.githubusercontent\.com\//.test(user.avatar_url)) {
      avatar.src = `${user.avatar_url}${user.avatar_url.includes('?') ? '&' : '?'}s=44`;
      avatar.hidden = false;
    } else {
      avatar.hidden = true;
    }
  }
}

export function initShell(): void {
  const login = storedLogin();
  if (login) render({ login, avatar_url: '' });
  loadSession()
    .then((session) => render(session?.user ?? null))
    .catch(() => {
      /* Network failure: keep the optimistic identity. */
    });

  document.addEventListener('golden:signed-in', (event) => {
    render((event as CustomEvent).detail.user);
  });
  document.addEventListener('golden:signed-out', (event) => {
    render(null);
    if ((event as CustomEvent).detail?.expired) toast('Your GitHub session expired. Sign in again.', 'error');
  });

  document.querySelector('[data-identity-signout]')?.addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Sign out?',
      body: 'The GitHub and Hugging Face tokens are removed from this tab. Running instances are not affected.',
      confirmLabel: 'Sign out',
    });
    if (ok) {
      signOut();
      toast('Signed out.');
    }
  });
}
