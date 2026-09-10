/** Build an isolated test checkout with a dummy local key; never read real credentials. */
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "vite";
const root = resolve(".");
await mkdir("test-results", { recursive: true });
const temporary = await mkdtemp(resolve("test-results/build-"));
try {
  for (const file of [
    "src",
    "profiles",
    "index.html",
    "vite.config.ts",
    "package.json",
  ])
    await cp(join(root, file), join(temporary, file), { recursive: true });
  await mkdir(join(temporary, "scripts"));
  await cp("scripts/local-env.ts", join(temporary, "scripts/local-env.ts"));
  await mkdir(join(temporary, "public/packs"), { recursive: true });
  await cp("public/packs/test", join(temporary, "public/packs/test"), {
    recursive: true,
  });
  await cp("public/icon.svg", join(temporary, "public/icon.svg"));
  await symlink(
    join(root, "node_modules"),
    join(temporary, "node_modules"),
    "dir",
  );
  await writeFile(
    join(temporary, ".env"),
    "VITE_MAPTILER_API_KEY=cyclatractor-browser-test-key\nVITE_REGION_MANIFEST=/cyclatractor/packs/test/manifest.json\n",
  );
  await build({
    root: temporary,
    configFile: join(temporary, "vite.config.ts"),
    build: { outDir: join(root, "dist"), emptyOutDir: true },
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
