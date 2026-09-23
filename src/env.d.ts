/// <reference types="vite/client" />

/** Injected by `vite.config.ts`: package version plus short commit when built in CI. */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  readonly VITE_DATA_URL: string;
  readonly VITE_HEATMAP_URL: string;
}
