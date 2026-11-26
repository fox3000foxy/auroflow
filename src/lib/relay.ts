import { AUTH_URL } from './config';
import { ApiError, kindForStatus } from './errors';

/**
 * GitHub Device Flow through the Cloudflare Worker in /worker. The worker only
 * adds the OAuth client ID and forwards to github.com, because GitHub's OAuth
 * endpoints do not allow browser CORS requests.
 */

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface TokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

async function relay<T>(path: string, body: unknown): Promise<T> {
  if (!AUTH_URL) {
    throw new ApiError('Authentication relay', 'config', 'PUBLIC_AUTH_URL is not configured for this build.');
  }
  let response: Response;
  try {
    response = await fetch(AUTH_URL + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Authentication relay', 'network', 'The relay could not be reached.');
  }
  if (!response.ok) {
    const hint = response.status === 403 ? ' This origin is not allowed by the relay (PANEL_ORIGIN).' : '';
    throw new ApiError('Authentication relay', kindForStatus(response.status), `Request failed with ${response.status}.${hint}`, response.status);
  }
  return (await response.json()) as T;
}

export function requestDeviceCode(): Promise<DeviceCode> {
  return relay<DeviceCode>('/device', {});
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  });

const DEVICE_ERRORS: Record<string, string> = {
  expired_token: 'The code expired before it was confirmed. Request a new code.',
  access_denied: 'Authorization was cancelled on GitHub.',
  incorrect_client_credentials: 'The relay is configured with an invalid OAuth client ID.',
  incorrect_device_code: 'GitHub did not recognise the device code. Request a new code.',
  unsupported_grant_type: 'The relay sent an unsupported grant type.',
  device_flow_disabled: 'Device Flow is not enabled on the GitHub OAuth App.',
};

/** Poll until the user confirms the code on GitHub. */
export async function pollForToken(code: DeviceCode, signal: AbortSignal): Promise<string> {
  let interval = Math.max(code.interval || 5, 5);
  const deadline = Date.now() + code.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval * 1000, signal);
    const result = await relay<TokenResponse>('/token', { device_code: code.device_code });
    if (result.access_token) return result.access_token;
    if (result.error === 'authorization_pending') continue;
    if (result.error === 'slow_down') {
      interval = Math.max(result.interval ?? interval + 5, interval + 5);
      continue;
    }
    throw new ApiError(
      'Authentication relay',
      'auth',
      DEVICE_ERRORS[result.error ?? ''] ?? result.error_description ?? 'Authorization failed.',
    );
  }
  throw new ApiError('Authentication relay', 'auth', DEVICE_ERRORS.expired_token);
}
