import { localEnv } from "./scripts/local-env";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(() => {
  const env = localEnv(new URL(".env", import.meta.url));
  return {
    envDir: false as const,
    define: {
      "import.meta.env.VITE_MAPTILER_API_KEY": JSON.stringify(
        env.VITE_MAPTILER_API_KEY?.trim() ?? "",
      ),
      "import.meta.env.VITE_REGION_MANIFEST": JSON.stringify(
        process.env.VITE_REGION_MANIFEST ?? env.VITE_REGION_MANIFEST ?? "",
      ),
    },
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
