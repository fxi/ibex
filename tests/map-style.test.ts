import { expect, it, afterEach } from "vitest";
import { customMapStyle, mapResourceURL } from "../src/map/style";
import { mapTilerKey } from "../scripts/local-env";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true });
});
it("always returns the bundled style and safely authenticates its resources", () => {
  for (const key of [undefined, "", "   ", " test+key&value "]) {
    const style = customMapStyle(key);
    expect(style.layers.length).toBeGreaterThan(100);
    expect(style.sources).toHaveProperty("maptiler_planet");
    expect(JSON.stringify(style)).not.toContain("key=undefined");
    expect(JSON.stringify(style)).not.toContain("INSERT_YOUR_OWN_API_KEY");
  }
  const style = customMapStyle(" test+key&value ");
  const resource = mapResourceURL(style.sprite as string, " test+key&value ");
  expect(new URL(resource).searchParams.get("key")).toBe("test+key&value");
  expect(mapResourceURL("https://example.com/tile?x=1", "key")).toBe(
    "https://example.com/tile?x=1",
  );
  expect(customMapStyle("").glyphs).not.toContain("test");
});
it("reads only the specified local dotenv file without expansion or ambient fallback", () => {
  const dir = mkdtempSync(join(tmpdir(), "cyclatractor-env-"));
  directories.push(dir);
  const file = pathToFileURL(join(dir, ".env"));
  const previous = process.env.VITE_MAPTILER_API_KEY;
  process.env.VITE_MAPTILER_API_KEY = "global-secret-reference";
  try {
    expect(mapTilerKey(file)).toBe("");
    writeFileSync(file, "OTHER=value\n");
    expect(mapTilerKey(file)).toBe("");
    writeFileSync(file, "VITE_MAPTILER_API_KEY=   \n");
    expect(mapTilerKey(file)).toBe("");
    writeFileSync(
      file,
      'export VITE_MAPTILER_API_KEY = " local+key&value " # comment\n',
    );
    expect(mapTilerKey(file)).toBe("local+key&value");
    writeFileSync(file, 'VITE_MAPTILER_API_KEY="${GLOBAL_KEY}"\n');
    expect(mapTilerKey(file)).toBe("${GLOBAL_KEY}");
  } finally {
    if (previous === undefined) delete process.env.VITE_MAPTILER_API_KEY;
    else process.env.VITE_MAPTILER_API_KEY = previous;
  }
});
