/**
 * Base-path aware URL helper. Astro exposes the configured `base` through
 * import.meta.env.BASE_URL; every internal link must go through `href()` so the
 * site keeps working under https://<user>.github.io/<repo>/.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

export function href(path = '/'): string {
  const clean = path.replace(/^\/+/, '');
  if (!clean) return `${BASE}/`;
  const [pathname, rest = ''] = clean.split(/(?=[?#])/);
  const withSlash = /\.[a-z0-9]+$/i.test(pathname) || pathname.endsWith('/') ? pathname : `${pathname}/`;
  return `${BASE}/${withSlash}${rest}`;
}

export type PageKey = 'home' | 'panel' | 'settings' | 'legal' | 'privacy' | 'disclaimer';

export const NAV: { key: PageKey; label: string; path: string }[] = [
  { key: 'home', label: 'Overview', path: '/' },
  { key: 'panel', label: 'Panel', path: '/panel/' },
  { key: 'settings', label: 'Settings', path: '/settings/' },
];
