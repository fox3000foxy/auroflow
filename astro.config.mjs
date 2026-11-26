import { defineConfig } from 'astro/config';

// GitHub Pages project site. Every internal link goes through src/lib/paths.ts,
// which reads import.meta.env.BASE_URL, so changing `base` here is enough.
export default defineConfig({
  site: 'https://fox3000foxy.github.io',
  base: '/windows-golden-panel',
  output: 'static',
  trailingSlash: 'always',
  build: {
    format: 'directory',
    inlineStylesheets: 'never',
  },
  vite: {
    build: {
      // Keep every script external so the production Content-Security-Policy
      // can forbid inline scripts.
      assetsInlineLimit: 0,
    },
  },
});
