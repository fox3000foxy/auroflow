import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../worker/index.js';

const env = { PANEL_ORIGINS: 'https://fox3000foxy.com,https://fox3000foxy.github.io', GITHUB_CLIENT_ID: 'Ov23liTEST' };
const req = (path: string, origin: string | null, method = 'POST', body?: string) =>
  new Request(`https://relay.example${path}`, { method, headers: { ...(origin ? { Origin: origin } : {}), 'Content-Type': 'application/json' }, body });

afterEach(() => vi.unstubAllGlobals());

describe('authentication worker', () => {
  it('answers preflight for the custom domain', async () => {
    const r = await worker.fetch(req('/device', 'https://fox3000foxy.com', 'OPTIONS'), env);
    expect(r.status).toBe(204);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://fox3000foxy.com');
  });

  it('relays the device code request with client id and scope', async () => {
    const upstream = vi.fn(async () => new Response(JSON.stringify({ user_code: 'ABCD-1234' })));
    vi.stubGlobal('fetch', upstream);
    const r = await worker.fetch(req('/device', 'https://fox3000foxy.github.io', 'POST', '{}'), env);
    expect(r.status).toBe(200);
    expect(r.headers.get('Access-Control-Allow-Origin')).toBe('https://fox3000foxy.github.io');
    expect((await r.json()).user_code).toBe('ABCD-1234');
    const body = String((upstream.mock.calls[0] as unknown[])[1] && ((upstream.mock.calls[0] as unknown[])[1] as RequestInit).body);
    expect(body).toContain('client_id=Ov23liTEST');
    expect(body).toContain('scope=repo+workflow');
  });

  it('refuses unknown origins with a readable 403', async () => {
    const r = await worker.fetch(req('/device', 'https://evil.example', 'POST', '{}'), env);
    expect(r.status).toBe(403);
    expect((await r.json()).error).toBe('origin_not_allowed');
  });

  it('keeps CORS headers on errors', async () => {
    const bad = await worker.fetch(req('/token', 'https://fox3000foxy.com', 'POST', 'nope'), env);
    expect(bad.status).toBe(400);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBe('https://fox3000foxy.com');
    vi.stubGlobal('fetch', async () => {
      throw new Error('down');
    });
    const down = await worker.fetch(req('/device', 'https://fox3000foxy.com', 'POST', '{}'), env);
    expect(down.status).toBe(502);
    expect(down.headers.get('Access-Control-Allow-Origin')).toBe('https://fox3000foxy.com');
  });

  it('still reads the legacy PANEL_ORIGIN variable', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const r = await worker.fetch(req('/device', 'https://fox3000foxy.github.io', 'POST', '{}'), { PANEL_ORIGIN: 'https://fox3000foxy.github.io', GITHUB_CLIENT_ID: 'x' });
    expect(r.status).toBe(200);
  });
});
