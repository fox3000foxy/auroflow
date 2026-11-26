import { pollForToken, requestDeviceCode } from '../lib/relay';
import { signIn } from '../lib/session';
import { describe } from '../lib/errors';
import { $, copyText, toast } from '../lib/ui';

function bind(root: HTMLElement) {
  const idle = $('[data-dl-idle]', root);
  const pending = $('[data-dl-pending]', root);
  const start = $('[data-dl-start]', root) as HTMLButtonElement;
  const cancel = $('[data-dl-cancel]', root) as HTMLButtonElement;
  const copy = $('[data-dl-copy]', root) as HTMLButtonElement;
  const code = $('[data-dl-code]', root);
  const link = $('[data-dl-link]', root) as HTMLAnchorElement;
  const status = $('[data-dl-status]', root);
  const error = $('[data-dl-error]', root);
  const remember = $('[data-dl-remember]', root) as HTMLInputElement;
  let controller: AbortController | null = null;
  let countdown: ReturnType<typeof setInterval> | null = null;

  const reset = () => {
    controller?.abort();
    controller = null;
    if (countdown) clearInterval(countdown);
    countdown = null;
    idle.hidden = false;
    pending.hidden = true;
    start.removeAttribute('aria-busy');
    start.disabled = false;
  };

  start.addEventListener('click', async () => {
    error.hidden = true;
    start.setAttribute('aria-busy', 'true');
    start.disabled = true;
    controller = new AbortController();
    const signal = controller.signal;
    try {
      const device = await requestDeviceCode();
      code.textContent = device.user_code;
      if (/^https:\/\/github\.com\//.test(device.verification_uri)) link.href = device.verification_uri;
      idle.hidden = true;
      pending.hidden = false;
      const expires = Date.now() + device.expires_in * 1000;
      const tick = () => {
        const left = Math.max(0, Math.round((expires - Date.now()) / 1000));
        status.textContent = `Waiting for confirmation on GitHub. The code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.`;
      };
      tick();
      countdown = setInterval(tick, 1000);
      const token = await pollForToken(device, signal);
      status.textContent = 'Confirmed. Loading your account.';
      const session = await signIn(token, remember.checked);
      toast(`Signed in as ${session.user.login}.`, 'success');
      reset();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      reset();
      error.textContent = describe(err);
      error.hidden = false;
    }
  });

  cancel.addEventListener('click', reset);
  copy.addEventListener('click', async () => {
    if (await copyText(code.textContent ?? '')) toast('Code copied.', 'success');
  });
}

export function initDeviceLogins(): void {
  for (const root of document.querySelectorAll<HTMLElement>('[data-device-login]')) {
    if (root.dataset.bound) continue;
    root.dataset.bound = 'true';
    bind(root);
  }
}
