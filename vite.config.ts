import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// loadEnv() gives an already-exported shell var priority over .env, so an
// unrelated ambient VITE_MAPTILER_API_KEY (e.g. a secrets-manager placeholder)
// would otherwise silently shadow this project's real key. Read .env directly
// instead so the project's own value always wins.
function readDotEnvKey(key: string): string | undefined {
  try {
    const text = readFileSync(new URL(".env", import.meta.url), "utf8");
    const match = text.match(new RegExp(`^${key}=(.*)$`, "m"));
    return match?.[1]?.trim().replace(/^["']|["']$/g, "");
  } catch {
    return undefined;
  }
}

export default defineConfig(() => {
  process.env.VITE_MAPTILER_API_KEY = readDotEnvKey("VITE_MAPTILER_API_KEY");
  return {
    base: "/cyclatractor/",
    plugins: [
      react(),
      VitePWA({
        registerType: "prompt",
        includeAssets: ["icon.svg"],
        manifest: {
          name: "Cyclatractor",
          short_name: "Cyclatractor",
          description: "Choose the territory. Find your way.",
          theme_color: "#183f36",
          background_color: "#f4f3ea",
          display: "standalone",
          start_url: "/cyclatractor/",
          scope: "/cyclatractor/",
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
          globPatterns: ["**/*.{js,css,html,svg,woff2}"],
          globIgnores: ["**/packs/**"],
          maximumFileSizeToCacheInBytes: 4000000,
          navigateFallback: "index.html",
        },
      }),
    ],
  };
});
