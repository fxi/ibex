import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { localEnv } from "./scripts/local-env";
import { localData } from "./scripts/data-server";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(() => {
  const env = localEnv(new URL(".env", import.meta.url));
  // The process environment overrides `.env`, except for the key: locally only this
  // workspace's `.env` provides it, so an ambient value never leaks into a bundle. CI has
  // no `.env`, so there the workflow's environment is the configuration.
  const setting = (name: string, ambient = true) =>
    ((ambient || process.env.CI) && process.env[name]) || env[name] || "";
  const base = `/${setting("BASE_PATH").replace(/^\/+|\/+$/g, "") || "ibex"}/`;
  const pkg = JSON.parse(
    readFileSync(new URL("package.json", import.meta.url), "utf8"),
  );
  const commit =
    process.env.GITHUB_SHA ??
    (() => {
      try {
        return execSync("git rev-parse HEAD", { stdio: "pipe" }).toString();
      } catch {
        return "";
      }
    })();
  const version = commit.trim()
    ? `${pkg.version}+${commit.trim().slice(0, 7)}`
    : pkg.version;
  return {
    envDir: false as const,
    define: {
      __APP_VERSION__: JSON.stringify(version),
      "import.meta.env.VITE_MAPTILER_API_KEY": JSON.stringify(
        setting("VITE_MAPTILER_API_KEY", false).trim(),
      ),
      "import.meta.env.VITE_DATA_URL": JSON.stringify(
        setting("VITE_DATA_URL").trim(),
      ),
      "import.meta.env.VITE_HEATMAP_URL": JSON.stringify(
        setting("VITE_HEATMAP_URL").trim(),
      ),
    },
    base,
    plugins: [
      react(),
      localData(process.env.IBEX_DATA_DIR ?? ".cache/cells", base),
      VitePWA({
        registerType: "prompt",
        includeAssets: ["icon.svg"],
        manifest: {
          name: "Ibex",
          short_name: "Ibex",
          description: "Choose the territory. Find your way.",
          theme_color: "#15212f",
          background_color: "#101d28",
          display: "standalone",
          start_url: base,
          scope: base,
          icons: [
            {
              src: "icon.svg",
              sizes: "any",
              type: "image/svg+xml",
              purpose: "any",
            },
          ],
        },
        workbox: {
          clientsClaim: true,
          cleanupOutdatedCaches: true,
          globPatterns: ["**/*.{js,css,html,svg,woff2}"],
          globIgnores: ["**/data/**"],
          maximumFileSizeToCacheInBytes: 4000000,
          navigateFallback: "index.html",
          navigateFallbackDenylist: [/\/data\//],
        },
      }),
    ],
  };
});
