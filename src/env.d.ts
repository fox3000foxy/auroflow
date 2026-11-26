/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Origin of the Cloudflare Worker that relays GitHub Device Flow requests. */
  readonly PUBLIC_AUTH_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
