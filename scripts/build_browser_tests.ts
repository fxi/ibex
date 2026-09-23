/** Build an isolated test checkout from pinned settings; never read real credentials. */
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "vite";
const root = resolve(".");
await mkdir("test-results", { recursive: true });
const temporary = await mkdtemp(resolve("test-results/build-"));
// Pin what an ambient or CI environment could otherwise override in vite.config.ts.
const pinned = {
  BASE_PATH: "/ibex/",
  VITE_DATA_URL: "",
  VITE_HEATMAP_URL: "",
};
Object.assign(process.env, pinned);
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
  for (const file of ["local-env.ts", "data-server.ts"])
    await cp(`scripts/${file}`, join(temporary, "scripts", file));
  // The synthetic release is served from the app's own `data/` path, as a published tree.
  await cp("tests/fixtures/data", join(temporary, "public/data"), {
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
    Object.entries(pinned)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
  );
  await build({
    root: temporary,
    configFile: join(temporary, "vite.config.ts"),
    build: { outDir: join(root, "dist"), emptyOutDir: true },
  });
} finally {
  await rm(temporary, { recursive: true, force: true });
}
